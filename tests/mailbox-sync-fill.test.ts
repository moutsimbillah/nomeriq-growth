import type { ParsedMail } from "mailparser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { createEmailAccount } from "@/lib/email/accounts";
import { storeParsedMessage } from "@/lib/email/sync";
import { hashPassword } from "@/lib/auth/password";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * The import attaches old messages to a mailbox with no body, and expects a later sync to fill it.
 *
 * Before this change a message whose Message-ID already existed was skipped outright — `inserted:
 * false` and nothing else — so an imported row would have stayed blank for ever. The fix fills a blank
 * body and never overwrites one.
 */

let accountId = "";
let userId = "";
const created = { prospects: [] as string[] };

function parsed(overrides: Partial<{ messageId: string; text: string; subject: string }> = {}): ParsedMail {
  const headers = new Map<string, string>([
    ["return-path", "<bounce@mail.example>"],
    ["reply-to", "reply@northwind.example"],
  ]);
  return {
    from: { value: [{ address: "hello@northwind.example", name: "Northwind Signals" }] },
    to: [{ value: [{ address: "moutsim@nomeriq.com", name: null }] }],
    cc: undefined,
    subject: overrides.subject ?? "A question about your signals",
    messageId: overrides.messageId ?? "<northwind-1@mail.example>",
    inReplyTo: null,
    references: null,
    date: new Date("2026-10-15T09:00:00.000Z"),
    text: overrides.text ?? "Hello, I noticed you sell paid trading signals.",
    html: "<p>Hello, I noticed you sell paid trading signals.</p>",
    attachments: [],
    headers,
  } as unknown as ParsedMail;
}

async function store(message: ParsedMail, uid: number, folder = "INBOX") {
  return storeParsedMessage({
    parsed: message,
    account: { id: accountId, emailAddress: "moutsim@nomeriq.com", fromName: "Moutasim" } as never,
    direction: "inbound",
    folderPath: folder,
    folderLabel: "INBOX",
    uid,
    uidValidity: 1,
    isSeen: true,
    internalDate: new Date("2026-10-15T09:00:00.000Z"),
  });
}

beforeAll(async () => {
  const db = await getDb();
  await ensureWorkspaceDefaults();
  userId = crypto.randomUUID();
  await db.query(
    `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
     VALUES ($1, $2, $3, $4, $5, 'founder')`,
    [userId, "sync-fill@test.nomeriq.com", "sync-fill@test.nomeriq.com", "Sync Fill", hashPassword("TestPassw0rd!123")],
  );
  const account = await createEmailAccount(
    {
      provider: "sandbox",
      emailAddress: "moutsim@nomeriq.com",
      fromName: "Moutasim",
      name: "Sync fill mailbox",
      dailySendLimit: 20,
      minIntervalSeconds: 60,
    },
    userId,
  );
  accountId = account.id;

  // the prospect the imported message will belong to
  const prospect = await db.query<{ id: string }>(
    `INSERT INTO prospects (id, business_name, name_key, created_by_type)
     VALUES (gen_random_uuid(), 'Northwind Signals', 'northwind-signals', 'legacy') RETURNING id`,
  );
  created.prospects.push(prospect.rows[0].id);
  await db.query(
    `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type)
     VALUES (gen_random_uuid(), $1, 'hello@northwind.example', 'hello@northwind.example',
             'https://northwind.example', 'official_website')`,
    [prospect.rows[0].id],
  );
});

afterAll(async () => {
  const db = await getDb();
  for (const id of created.prospects) await db.query(`DELETE FROM prospects WHERE id = $1`, [id]);
  await db.query(`DELETE FROM email_accounts WHERE id = $1`, [accountId]);
  await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

describe("a message that already exists with no body", () => {
  it("is filled in, rather than skipped", async () => {
    const db = await getDb();
    // what the import leaves behind: the row, its Message-ID, and no body
    const existing = await db.query<{ id: string }>(
      `INSERT INTO messages (id, account_id, direction, source, folder, uidvalidity, uid, message_id,
                             from_email, to_emails, subject, body_text, sent_at, is_read)
       VALUES (gen_random_uuid(), $1, 'inbound', 'imap', 'INBOX', 1, 42, '<northwind-1@mail.example>',
               'hello@northwind.example', '[]'::jsonb, '(no subject)', '', now(), true)
       RETURNING id`,
      [accountId],
    );
    const rowId = existing.rows[0].id;

    const outcome = await store(parsed(), 42);
    expect(outcome.inserted).toBe(false);
    expect(outcome.filled).toBe(true);

    const filled = await db.query<{ body_text: string; subject: string; snippet: string | null }>(
      `SELECT body_text, subject, snippet FROM messages WHERE id = $1`,
      [rowId],
    );
    expect(filled.rows[0].body_text).toBe("Hello, I noticed you sell paid trading signals.");
    expect(filled.rows[0].subject).toBe("A question about your signals");
    expect(filled.rows[0].snippet).toContain("paid trading signals");

    // still exactly one row for that Message-ID: filling is not inserting
    const count = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE message_id = $1`,
      ["<northwind-1@mail.example>"],
    );
    expect(count.rows[0].n).toBe(1);
  });

  it("is never overwritten once it has a body", async () => {
    const db = await getDb();
    const before = await db.query<{ body_text: string }>(
      `SELECT body_text FROM messages WHERE message_id = $1`,
      ["<northwind-1@mail.example>"],
    );
    const outcome = await store(parsed({ text: "A different body that must not win." }), 42);
    expect(outcome.inserted).toBe(false);
    expect(outcome.filled).toBe(false);

    const after = await db.query<{ body_text: string }>(
      `SELECT body_text FROM messages WHERE message_id = $1`,
      ["<northwind-1@mail.example>"],
    );
    expect(after.rows[0].body_text).toBe(before.rows[0].body_text);
    expect(after.rows[0].body_text).not.toContain("must not win");
  });

  it("still inserts a genuinely new message", async () => {
    const db = await getDb();
    const outcome = await store(parsed({ messageId: "<northwind-2@mail.example>" }), 43);
    expect(outcome.inserted).toBe(true);
    expect(outcome.filled).toBe(false);
    const count = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE message_id = $1`,
      ["<northwind-2@mail.example>"],
    );
    expect(count.rows[0].n).toBe(1);
  });
});