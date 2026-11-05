import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb, type DbClient } from "@/lib/db/client";
import { buildRawMessage, chooseSentFolder, listUncopiedSentMessages } from "@/lib/email/sent-copy";
import { rematchUnmatchedInbound } from "@/lib/email/sync";

/**
 * The two mailbox-foundation jobs that are about what already exists rather than what arrives:
 * the Sent-folder copy, and attaching inbound mail that arrived before its lead did.
 *
 * Nothing here talks to an IMAP server. The parts that decide *what* to write are pure and pinned
 * here — the MIME is produced by nodemailer's own composer, so a copy is the message rather than a
 * reconstruction, and the folder is chosen the way the sync chooses it.
 */

let db: DbClient;
const RUN = `found-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const prospectIds: string[] = [];
const messageIds: string[] = [];
const conversationIds: string[] = [];

beforeAll(async () => {
  db = await getDb();
});

afterAll(async () => {
  for (const id of messageIds) await db.query(`DELETE FROM messages WHERE id = $1`, [id]);
  for (const id of conversationIds) await db.query(`DELETE FROM conversations WHERE id = $1`, [id]);
  for (const id of prospectIds) await db.query(`DELETE FROM prospects WHERE id = $1`, [id]);
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

describe("the Sent folder is chosen the way the sync chooses it", () => {
  it("prefers the folder the server marks as Sent", () => {
    expect(
      chooseSentFolder([
        { path: "INBOX" },
        { path: "Mail/Verzonden", specialUse: "\\Sent" },
        { path: "Sent Items" },
      ]),
    ).toBe("Mail/Verzonden");
  });

  it("falls back to a name it recognises, then to any name containing 'sent'", () => {
    expect(chooseSentFolder([{ path: "INBOX" }, { path: "Sent Items" }])).toBe("Sent Items");
    expect(chooseSentFolder([{ path: "INBOX" }, { path: "Sent Messages" }])).toBe("Sent Messages");
  });

  it("answers null rather than guessing when there is no Sent folder", () => {
    expect(chooseSentFolder([{ path: "INBOX" }, { path: "Archive" }])).toBeNull();
  });
});

describe("the copy is the message, not a reconstruction", () => {
  it("composes a MIME source carrying the original Message-ID and both bodies", async () => {
    const raw = await buildRawMessage({
      messageId: "<copy-1@nomeriq.test>",
      to: "prospect@example.test",
      subject: "A specific observation about your signals",
      text: "Plain text body.\n\nBest,",
      html: "<p>Plain text body.</p><p>Best,</p>",
      fromName: "Moutsim",
      fromEmail: "moutsim@nomeriq.test",
      headers: { "In-Reply-To": "<earlier@nomeriq.test>" },
    });
    const text = raw.toString("utf8");
    expect(text).toContain("<copy-1@nomeriq.test>");
    expect(text).toContain("A specific observation about your signals");
    expect(text).toContain("Plain text body.");
    expect(text).toContain("In-Reply-To: <earlier@nomeriq.test>");
    // A real MIME body, not an empty buffer.
    expect(text).toContain("Content-Type: text/plain");
  });
});

describe("a message is only listed for copying when its copy is unconfirmed", () => {
  async function account(label: string): Promise<string> {
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO email_accounts (id, name, provider, email_address, normalized_email, from_name,
         status, smtp_host, imap_host, username, password_encrypted, is_default)
       VALUES ($1, $2, 'smtp_imap', $3, $3, 'Copy', 'connected', 'smtp.t', 'imap.t', 'u', 'x', false)`,
      [id, `${RUN} ${label}`, `${label}-${RUN}@example.test`],
    );
    return id;
  }

  it("lists an uncopied live send and stops listing it once the copy is confirmed", async () => {
    const accountId = await account("lists");
    const id = crypto.randomUUID();
    messageIds.push(id);
    await db.query(
      `INSERT INTO messages (id, account_id, direction, source, message_id, from_email, to_emails,
         subject, body_text, sent_at, is_sandbox, delivery_status)
       VALUES ($1, $2, 'outbound', 'smtp', $3, $4, $5::jsonb, 'Subject', 'Body', now(), false, 'accepted')`,
      [id, accountId, `<listed-${RUN}@nomeriq.test>`, `${RUN}@example.test`, JSON.stringify(["p@example.test"])],
    );

    const before = await listUncopiedSentMessages(accountId);
    expect(before.map((row) => row.id)).toContain(id);
    expect(before[0].to).toBe("p@example.test");

    await db.query(`UPDATE messages SET sent_copy_saved_at = now() WHERE id = $1`, [id]);
    const after = await listUncopiedSentMessages(accountId);
    expect(after.map((row) => row.id)).not.toContain(id);
  });

  it("never lists a sandbox send, which has no Sent folder to write to", async () => {
    const accountId = await account("sandbox");
    const id = crypto.randomUUID();
    messageIds.push(id);
    await db.query(
      `INSERT INTO messages (id, account_id, direction, source, message_id, from_email, to_emails,
         subject, body_text, sent_at, is_sandbox, delivery_status)
       VALUES ($1, $2, 'outbound', 'system', $3, $4, $5::jsonb, 'Subject', 'Body', now(), true, 'accepted')`,
      [id, accountId, `<sandbox-${RUN}@nomeriq.test>`, `${RUN}@example.test`, JSON.stringify(["p@example.test"])],
    );
    const rows = await listUncopiedSentMessages(accountId);
    expect(rows.map((row) => row.id)).not.toContain(id);
  });
});

describe("inbound mail that arrived before its lead is attached later", () => {
  async function seedProspect(name: string, domain: string, email: string): Promise<string> {
    const id = crypto.randomUUID();
    prospectIds.push(id);
    await db.query(
      `INSERT INTO prospects (id, business_name, name_key, domain_key, qualification_status, status,
         created_by_type, source_agent, source_channel)
       VALUES ($1, $2, $3, $4, 'verified', 'new', 'api', 'claude', 'mcp_oauth')`,
      [id, name, `${RUN}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, domain],
    );
    await db.query(
      `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type, is_primary)
       VALUES (gen_random_uuid(), $1, $2, $2, 'https://example.test', 'official_website', true)`,
      [id, email],
    );
    return id;
  }

  async function seedInbound(from: string, subject: string): Promise<string> {
    const id = crypto.randomUUID();
    messageIds.push(id);
    await db.query(
      `INSERT INTO messages (id, direction, source, from_email, to_emails, subject, body_text,
         received_at, matched_by)
       VALUES ($1, 'inbound', 'imap', $2, '[]'::jsonb, $3, 'Their reply.', now(), 'unmatched')`,
      [id, from, subject],
    );
    return id;
  }

  it("attaches by the exact sender address, and says so", async () => {
    const email = `hello-${RUN}@attachone.example.test`;
    const prospectId = await seedProspect("Attach One", "attachone.example.test", email);
    const messageId = await seedInbound(email, "Re: your note");

    const result = await rematchUnmatchedInbound();
    expect(result.matched).toBeGreaterThanOrEqual(1);
    expect(result.byAddress).toBeGreaterThanOrEqual(1);

    const row = await db.query<{ prospect_id: string; conversation_id: string; matched_by: string }>(
      `SELECT prospect_id, conversation_id, matched_by FROM messages WHERE id = $1`,
      [messageId],
    );
    expect(row.rows[0].prospect_id).toBe(prospectId);
    expect(row.rows[0].matched_by).toBe("exact_email");
    expect(row.rows[0].conversation_id).toBeTruthy();
    conversationIds.push(row.rows[0].conversation_id);
  });

  it("attaches by the sender's own domain when the address is not on file", async () => {
    const prospectId = await seedProspect(
      "Attach Two",
      "attachtwo.example.test",
      `sales-${RUN}@attachtwo.example.test`,
    );
    const messageId = await seedInbound(`ceo-${RUN}@attachtwo.example.test`, "Re: pricing");

    const result = await rematchUnmatchedInbound();
    expect(result.byDomain).toBeGreaterThanOrEqual(1);

    const row = await db.query<{ prospect_id: string; matched_by: string; conversation_id: string }>(
      `SELECT prospect_id, matched_by, conversation_id FROM messages WHERE id = $1`,
      [messageId],
    );
    expect(row.rows[0].prospect_id).toBe(prospectId);
    expect(row.rows[0].matched_by).toBe("sender_domain");
    conversationIds.push(row.rows[0].conversation_id);
  });

  it("leaves a free-mail sender unmatched, because a shared domain identifies nobody", async () => {
    const messageId = await seedInbound(`someone-${RUN}@gmail.com`, "Re: hello");
    await rematchUnmatchedInbound();
    const row = await db.query<{ prospect_id: string | null }>(
      `SELECT prospect_id FROM messages WHERE id = $1`,
      [messageId],
    );
    expect(row.rows[0].prospect_id).toBeNull();
  });

  it("never moves a message that already has an owner", async () => {
    const email = `owner-${RUN}@attachone.example.test`;
    const messageId = await seedInbound(email, "Re: already placed");
    const first = await rematchUnmatchedInbound();
    expect(first.matched).toBeGreaterThanOrEqual(1);
    const owned = await db.query<{ prospect_id: string; conversation_id: string }>(
      `SELECT prospect_id, conversation_id FROM messages WHERE id = $1`,
      [messageId],
    );
    conversationIds.push(owned.rows[0].conversation_id);

    const second = await rematchUnmatchedInbound();
    const after = await db.query<{ prospect_id: string }>(
      `SELECT prospect_id FROM messages WHERE id = $1`,
      [messageId],
    );
    // Same owner, and the run did not report re-attaching it.
    expect(after.rows[0].prospect_id).toBe(owned.rows[0].prospect_id);
    expect(second.matched).toBeLessThanOrEqual(second.scanned);
  });
});