import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { hasReplySinceLastOutbound } from "@/lib/services/email-sending";

/**
 * A follow-up is cancelled when the prospect has written since our last message — a judgement that
 * has to be made on when each message really happened, not on when its row was stored.
 *
 * The old portal's import writes a whole thread in one pass, so every imported row carries the import
 * time in `created_at`, later than any real send. Comparing `created_at` therefore reported a reply
 * to every send made before the import, and the follow-up job cancelled follow-ups that were still
 * due to go.
 */

const PREFIX = "follow-up-reply-timing";
/** The import runs after every message in these threads really happened. */
const IMPORT_TIME = "2026-11-05T12:38:00Z";

async function newThread(name: string): Promise<{ conversationId: string; prospectId: string }> {
  const db = await getDb();
  const prospect = await db.query<{ id: string }>(
    `INSERT INTO prospects (id, business_name, name_key, created_by_type, source_channel)
     VALUES (gen_random_uuid(), $1, $2, 'legacy', 'legacy_import') RETURNING id`,
    [name, `${PREFIX}-${name}`],
  );
  const conversation = await db.query<{ id: string }>(
    `INSERT INTO conversations (id, prospect_id, subject, last_message_at, last_inbound_at)
     VALUES (gen_random_uuid(), $1, 'Re: your signals', now(), now()) RETURNING id`,
    [prospect.rows[0].id],
  );
  return { conversationId: conversation.rows[0].id, prospectId: prospect.rows[0].id };
}

interface MessageFixture {
  direction: "inbound" | "outbound";
  source?: string;
  createdAt: string;
  sentAt?: string | null;
  receivedAt?: string | null;
}

async function insertMessage(
  { conversationId, prospectId }: { conversationId: string; prospectId: string },
  message: MessageFixture,
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO messages (id, conversation_id, prospect_id, direction, source, message_id,
                           from_email, to_emails, subject, body_text, sent_at, received_at,
                           is_read, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, '[]'::jsonb, 'Re: your signals', '',
             $7, $8, true, $9)`,
    [
      conversationId,
      prospectId,
      message.direction,
      message.source ?? (message.direction === "inbound" ? "legacy_import" : "smtp"),
      `<${crypto.randomUUID()}@reply-timing.example>`,
      message.direction === "inbound" ? "hello@reply-timing.example" : "founder@nomeriq.example",
      message.sentAt ?? null,
      message.receivedAt ?? null,
      message.createdAt,
    ],
  );
}

/** The comparison the follow-up check used to make, kept to prove what it got wrong. */
async function repliedByCreatedAt(conversationId: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.query(
    `SELECT 1 FROM messages
     WHERE conversation_id = $1 AND direction = 'inbound'
       AND created_at > COALESCE((
         SELECT max(created_at) FROM messages
         WHERE conversation_id = $1 AND direction = 'outbound'
       ), '-infinity'::timestamptz)
     LIMIT 1`,
    [conversationId],
  );
  return result.rows.length > 0;
}

afterAll(async () => {
  await removeFixtures();
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function removeFixtures() {
  const db = await getDb();
  const match = `${PREFIX}-%`;
  await db.query(
    `DELETE FROM messages WHERE prospect_id IN (SELECT id FROM prospects WHERE name_key LIKE $1)`,
    [match],
  );
  await db.query(
    `DELETE FROM conversations WHERE prospect_id IN (SELECT id FROM prospects WHERE name_key LIKE $1)`,
    [match],
  );
  await db.query(`DELETE FROM prospects WHERE name_key LIKE $1`, [match]);
}

describe("a follow-up's reply check", () => {
  it("does not treat an imported reply that predates the send as a reply to it", async () => {
    const thread = await newThread("predates-the-send");
    await insertMessage(thread, {
      direction: "outbound",
      createdAt: "2026-11-05T09:00:00Z",
      sentAt: "2026-11-05T09:00:00Z",
    });
    // Really arrived the day before the send; stored when the thread was imported, hours after it.
    await insertMessage(thread, {
      direction: "inbound",
      createdAt: IMPORT_TIME,
      receivedAt: "2026-11-04T17:30:00Z",
    });

    // What the old check saw: the import timestamp, later than the send, so it called this a reply.
    expect(await repliedByCreatedAt(thread.conversationId)).toBe(true);
    expect(await hasReplySinceLastOutbound(thread.conversationId)).toBe(false);
  });

  it("still stops the follow-up when the reply really did arrive after the send", async () => {
    const thread = await newThread("reply-after-the-send");
    await insertMessage(thread, {
      direction: "outbound",
      createdAt: "2026-11-05T09:00:00Z",
      sentAt: "2026-11-05T09:00:00Z",
    });
    await insertMessage(thread, {
      direction: "inbound",
      createdAt: IMPORT_TIME,
      receivedAt: "2026-11-05T14:00:00Z",
    });

    expect(await hasReplySinceLastOutbound(thread.conversationId)).toBe(true);
  });

  it("compares against the newest send, not the oldest", async () => {
    const thread = await newThread("two-sends");
    await insertMessage(thread, {
      direction: "outbound",
      createdAt: "2026-10-28T09:00:00Z",
      sentAt: "2026-10-28T09:00:00Z",
    });
    await insertMessage(thread, {
      direction: "inbound",
      createdAt: IMPORT_TIME,
      receivedAt: "2026-10-29T10:00:00Z",
    });
    await insertMessage(thread, {
      direction: "outbound",
      createdAt: "2026-11-02T09:00:00Z",
      sentAt: "2026-11-02T09:00:00Z",
    });

    // The reply answered the first send, and the second send came afterwards: nothing to stop for.
    expect(await hasReplySinceLastOutbound(thread.conversationId)).toBe(false);
  });

  it("does not count a reply at the same instant as the send", async () => {
    const thread = await newThread("same-instant");
    await insertMessage(thread, {
      direction: "outbound",
      createdAt: "2026-11-05T09:00:00Z",
      sentAt: "2026-11-05T09:00:00Z",
    });
    await insertMessage(thread, {
      direction: "inbound",
      createdAt: IMPORT_TIME,
      receivedAt: "2026-11-05T09:00:00Z",
    });

    expect(await hasReplySinceLastOutbound(thread.conversationId)).toBe(false);
  });

  it("treats any inbound as a reply when nothing was ever sent", async () => {
    const thread = await newThread("no-send");
    await insertMessage(thread, {
      direction: "inbound",
      createdAt: "2026-11-04T17:30:00Z",
      receivedAt: "2026-11-04T17:30:00Z",
    });

    expect(await hasReplySinceLastOutbound(thread.conversationId)).toBe(true);
  });
});