import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import type { ParsedMail } from "mailparser";

import { closeDb, getDb, type DbClient } from "@/lib/db/client";
import { getEmailAccountRecord } from "@/lib/email/accounts";
import { storeParsedMessage } from "@/lib/email/sync";
import { GET as cronSync } from "@/app/api/cron/sync/route";

/**
 * A bounce must not be mistaken for a reply.
 *
 * This is the interaction that matters most in item 1, and it is invisible until it goes wrong: a
 * delivery report from `postmaster@` carries the subject of the message it failed, so a naive sync
 * would file it as "they answered", mark the thread replied, cancel the follow-up and remind the
 * founder to respond to a machine. The sync must read the report, suppress the address that failed,
 * and leave the conversation exactly as it was.
 */

let db: DbClient;
const RUN = `breply-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const prospectIds: string[] = [];
const conversationIds: string[] = [];
const draftIds: string[] = [];
const messageIds: string[] = [];
const accountIds: string[] = [];

/** The smallest ParsedMail the sync reads: senders, ids, subject, date, headers, text. */
function parsed(input: {
  from: string;
  subject: string;
  text: string;
  messageId: string;
  headers?: Record<string, string>;
}): ParsedMail {
  const headerMap = new Map(Object.entries(input.headers ?? {}));
  return {
    from: { value: [{ address: input.from, name: "" }] },
    to: { value: [{ address: `inbox-${RUN}@example.test`, name: "" }] },
    cc: undefined,
    messageId: input.messageId,
    inReplyTo: undefined,
    references: undefined,
    subject: input.subject,
    date: new Date(),
    text: input.text,
    html: false,
    attachments: [],
    headers: headerMap,
  } as unknown as ParsedMail;
}

beforeAll(async () => {
  db = await getDb();
});

afterAll(async () => {
  for (const id of messageIds) await db.query(`DELETE FROM messages WHERE id = $1`, [id]);
  for (const id of draftIds) await db.query(`DELETE FROM drafts WHERE id = $1`, [id]);
  for (const id of conversationIds) await db.query(`DELETE FROM conversations WHERE id = $1`, [id]);
  for (const id of prospectIds) await db.query(`DELETE FROM prospects WHERE id = $1`, [id]);
  for (const id of accountIds) await db.query(`DELETE FROM email_accounts WHERE id = $1`, [id]);
  await db.query(`DELETE FROM email_bounces WHERE normalized_email LIKE $1`, [`%${RUN}%`]);
  await db.query(`DELETE FROM suppressions WHERE normalized_email LIKE $1`, [`%${RUN}%`]);
  await db.query(`DELETE FROM mailbox_sync_state WHERE account_id = ANY($1::uuid[])`, [accountIds]);
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

/** Each fixture owns its own domain, so one case cannot collide with another's prospect. */
let fixtureCount = 0;

async function fixture(): Promise<{
  accountId: string;
  prospectId: string;
  conversationId: string;
  draftId: string;
  contactEmail: string;
  domain: string;
  lastInboundBefore: string | null;
}> {
  const accountId = crypto.randomUUID();
  accountIds.push(accountId);
  // One mailbox per fixture: the address is unique, and the case is about the message, not the account.
  const accountAddress = `inbox-${accountId.slice(0, 8)}-${RUN}@example.test`;
  await db.query(
    `INSERT INTO email_accounts (id, name, provider, email_address, normalized_email, from_name,
       status, smtp_host, imap_host, username, password_encrypted, is_default)
     VALUES ($1, $2, 'smtp_imap', $3, $3, 'Bounce', 'connected', 'smtp.t', 'imap.t', 'u', 'x', false)`,
    [accountId, `${RUN} account`, accountAddress],
  );

  fixtureCount += 1;
  const domain = `signals-${fixtureCount}-${RUN}.example.test`;
  const contactEmail = `contact-${fixtureCount}-${RUN}@${domain}`;
  const prospectId = crypto.randomUUID();
  prospectIds.push(prospectId);
  await db.query(
    `INSERT INTO prospects (id, business_name, name_key, domain_key, qualification_status, status,
       created_by_type, source_agent, source_channel, last_contacted_at)
     VALUES ($1, $2, $3, $4, 'verified', 'contacted', 'api', 'claude', 'mcp_oauth', now())`,
    [prospectId, `${RUN} Signals ${fixtureCount}`, `${RUN}-signals-${fixtureCount}`, domain],
  );
  await db.query(
    `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type, is_primary)
     VALUES (gen_random_uuid(), $1, $2, $2, 'https://example.test', 'official_website', true)`,
    [prospectId, contactEmail],
  );

  const conversationId = crypto.randomUUID();
  conversationIds.push(conversationId);
  await db.query(
    `INSERT INTO conversations (id, prospect_id, subject, status, last_message_at, last_outbound_at, unread_count)
     VALUES ($1, $2, 'Your signals offer', 'open', now() - interval '3 days', now() - interval '3 days', 0)`,
    [conversationId, prospectId],
  );

  const draftId = crypto.randomUUID();
  draftIds.push(draftId);
  await db.query(
    `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
       ai_generated, created_by_type, created_at, updated_at)
     VALUES ($1, $2, 'follow_up', 1, 'draft', 'Re: Your signals offer', 'Body', $3, false, 'founder', now(), now())`,
    [draftId, prospectId, contactEmail],
  );

  const conversation = await db.query<{ last_inbound_at: string | null }>(
    `SELECT last_inbound_at FROM conversations WHERE id = $1`,
    [conversationId],
  );
  return {
    accountId,
    prospectId,
    conversationId,
    draftId,
    contactEmail,
    domain,
    lastInboundBefore: conversation.rows[0].last_inbound_at,
  };
}

describe("a delivery report is not a reply", () => {
  it("suppresses the failed address, leaves the thread unanswered and keeps the follow-up", async () => {
    const f = await fixture();
    const account = (await getEmailAccountRecord(f.accountId))!;
    const failed = f.contactEmail;

    const stored = await storeParsedMessage({
      parsed: parsed({
        from: `MAILER-DAEMON+verp123@mx-${RUN}.example.test`,
        subject: "Undelivered Mail Returned to Sender",
        messageId: `<dsn-${RUN}@mx.example.test>`,
        text: `Final-Recipient: rfc822; ${failed}\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 user unknown`,
      }),
      account,
      direction: "inbound",
      folderPath: "INBOX",
      folderLabel: "INBOX",
      uid: 991,
      uidValidity: 1,
      isSeen: true,
      internalDate: new Date(),
    });
    messageIds.push(
      (
        await db.query<{ id: string }>(
          `SELECT id FROM messages WHERE message_id = $1`,
          [`<dsn-${RUN}@mx.example.test>`],
        )
      ).rows[0].id,
    );
    expect(stored.inserted).toBe(true);

    // 1. The address that failed is suppressed, so nothing else is ever sent to it.
    const suppression = await db.query<{ reason: string; active: boolean }>(
      `SELECT reason, active FROM suppressions WHERE normalized_email = $1`,
      [failed],
    );
    expect(suppression.rows[0]).toMatchObject({ reason: "bounce", active: true });

    // 2. The thread was not marked answered: no inbound time, no unread count, no status change.
    const conversation = await db.query<{
      last_inbound_at: string | null;
      unread_count: number;
      status: string;
      classification: string;
    }>(
      `SELECT last_inbound_at, unread_count, status, classification FROM conversations WHERE id = $1`,
      [f.conversationId],
    );
    expect(conversation.rows[0].last_inbound_at).toBe(f.lastInboundBefore);
    expect(conversation.rows[0].unread_count).toBe(0);
    expect(conversation.rows[0].status).toBe("open");
    expect(conversation.rows[0].classification).not.toBe("unsubscribe");

    // 3. The prepared follow-up is still there to send: nobody replied.
    const draft = await db.query<{ status: string }>(
      `SELECT status FROM drafts WHERE id = $1`,
      [f.draftId],
    );
    expect(draft.rows[0].status).toBe("draft");

    // 4. The report itself is on record with its status code.
    const logged = await db.query<{ kind: string; dsn_status: string; action: string }>(
      `SELECT kind, dsn_status, action FROM email_bounces WHERE normalized_email = $1`,
      [failed],
    );
    expect(logged.rows[0]).toMatchObject({ kind: "permanent", dsn_status: "5.1.1", action: "suppressed" });
  });

  it("still treats a real reply as a reply", async () => {
    const f = await fixture();
    const account = (await getEmailAccountRecord(f.accountId))!;

    await storeParsedMessage({
      parsed: parsed({
        from: f.contactEmail,
        subject: "Re: Your signals offer",
        messageId: `<reply-${RUN}@${f.domain}>`,
        text: "Thanks, this looks interesting. Can you tell me more?",
      }),
      account,
      direction: "inbound",
      folderPath: "INBOX",
      folderLabel: "INBOX",
      uid: 992,
      uidValidity: 1,
      isSeen: true,
      internalDate: new Date(),
    });
    messageIds.push(
      (
        await db.query<{ id: string }>(
          `SELECT id FROM messages WHERE message_id = $1`,
          [`<reply-${RUN}@${f.domain}>`],
        )
      ).rows[0].id,
    );

    const conversation = await db.query<{ last_inbound_at: string | null; unread_count: number }>(
      `SELECT last_inbound_at, unread_count FROM conversations WHERE id = $1`,
      [f.conversationId],
    );
    expect(conversation.rows[0].last_inbound_at).not.toBeNull();
    expect(conversation.rows[0].unread_count).toBe(1);

    // A reply cancels the queued follow-up, which is the behaviour a bounce must not trigger.
    const draft = await db.query<{ status: string }>(
      `SELECT status FROM drafts WHERE id = $1`,
      [f.draftId],
    );
    expect(draft.rows[0].status).toBe("cancelled");
  });
});

describe("the scheduled sync route", () => {
  const call = (authorization?: string) =>
    new Request(`http://localhost:3100/api/cron/sync`, {
      headers: authorization ? { authorization } : {},
    });

  it("refuses without the secret", async () => {
    const response = await cronSync(call());
    expect(response.status).toBe(401);
  });

  it("refuses a wrong secret", async () => {
    const response = await cronSync(call("Bearer not-the-secret"));
    expect(response.status).toBe(401);
  });

  it("runs, sends nothing, and says so", async () => {
    const response = await cronSync(call(`Bearer ${process.env.CRON_SECRET}`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.note).toMatch(/No email was sent/i);
    // Every account reports individually: one mailbox failing never hides the others.
    expect(Array.isArray(body.data.accounts)).toBe(true);
  });
});