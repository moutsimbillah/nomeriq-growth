import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";

import { closeDb, getDb } from "@/lib/db/client";
import {
  getConversation,
  MESSAGE_BODY_PENDING_TEXT,
  messageBodyForDisplay,
} from "@/lib/services/conversations";

/**
 * The conversation page's thread, in the order it really happened.
 *
 * An import writes every row in one pass, so `created_at` is the import time and is identical for all
 * of them — ordering the thread by it put the replies in an arbitrary order (in the live thread all
 * five imported rows share 2026-11-05 12:38, while they were really sent between 30 Oct and 4 Nov).
 * The thread is now ordered by the time each message was really sent or received, newest first, and
 * an imported reply with no body shows its excerpt or a plain notice — never the raw `error` text the
 * importer wrote.
 */

const NAME_KEY = "conversation-order-fixture";
const IMPORT_TIME = "2026-11-05T12:38:00Z";
/** Later than the import: a live row must not jump to the top just because it was stored later. */
const LIVE_TIME = "2026-11-05T13:00:00Z";

const ids: Record<string, string> = {};
let prospectId = "";
let conversationId = "";

interface FixtureRow {
  key: string;
  direction: "inbound" | "outbound";
  fromEmail: string;
  source?: string;
  createdAt?: string;
  sentAt?: string | null;
  receivedAt?: string | null;
  excerpt?: string | null;
  bodyText?: string;
  error?: string | null;
}

async function insertMessage(row: FixtureRow): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  ids[row.key] = id;
  await db.query(
    `INSERT INTO messages (id, conversation_id, prospect_id, direction, source, message_id,
                           from_email, to_emails, subject, body_text, snippet,
                           sent_at, received_at, error, is_read, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '[]'::jsonb, $8, $9, $10, $11, $12, $13, true, $14)`,
    [
      id,
      conversationId,
      prospectId,
      row.direction,
      row.source ?? "legacy_import",
      `<${row.key}@legacy.example>`,
      row.fromEmail,
      `Message ${row.key}`,
      row.bodyText ?? "",
      row.excerpt ?? null,
      row.sentAt ?? null,
      row.receivedAt ?? null,
      row.error ?? null,
      row.createdAt ?? IMPORT_TIME,
    ],
  );
  return id;
}

async function removeFixture() {
  const db = await getDb();
  await db.query(`DELETE FROM messages WHERE prospect_id IN (SELECT id FROM prospects WHERE name_key = $1)`, [
    NAME_KEY,
  ]);
  await db.query(
    `DELETE FROM conversations WHERE prospect_id IN (SELECT id FROM prospects WHERE name_key = $1)`,
    [NAME_KEY],
  );
  await db.query(
    `DELETE FROM prospect_emails WHERE prospect_id IN (SELECT id FROM prospects WHERE name_key = $1)`,
    [NAME_KEY],
  );
  await db.query(`DELETE FROM prospects WHERE name_key = $1`, [NAME_KEY]);
}

beforeAll(async () => {
  const db = await getDb();
  await removeFixture();

  const prospect = await db.query<{ id: string }>(
    `INSERT INTO prospects (id, business_name, name_key, created_by_type, source_channel)
     VALUES (gen_random_uuid(), 'Northwind Signals', $1, 'legacy', 'legacy_import')
     RETURNING id`,
    [NAME_KEY],
  );
  prospectId = prospect.rows[0].id;
  await db.query(
    `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type)
     VALUES (gen_random_uuid(), $1, 'contact@northwind.example', 'contact@northwind.example',
             'https://northwind.example', 'official_website')`,
    [prospectId],
  );

  const conversation = await db.query<{ id: string }>(
    `INSERT INTO conversations (id, prospect_id, subject, last_message_at, last_inbound_at)
     VALUES (gen_random_uuid(), $1, 'A question about your signals',
             '2026-11-04T17:30:00Z', '2026-11-04T17:30:00Z')
     RETURNING id`,
    [prospectId],
  );
  conversationId = conversation.rows[0].id;

  // Five imported rows, all with the same created_at, in a scrambled real order. Inbound rows carry
  // sent_at equal to received_at on live; one of them carries only received_at, to exercise the
  // fallback rather than a third convention.
  await insertMessage({ key: "out-1015", direction: "outbound", fromEmail: "moutsim@nomeriq.example", sentAt: "2026-10-30T20:15:00Z" });
  await insertMessage({
    key: "in-1104",
    direction: "inbound",
    fromEmail: "latest@northwind.example",
    sentAt: "2026-11-04T17:30:00Z",
    receivedAt: "2026-11-04T17:30:00Z",
  });
  await insertMessage({ key: "in-1030", direction: "inbound", fromEmail: "earlier@northwind.example", receivedAt: "2026-10-30T20:50:00Z" });
  await insertMessage({ key: "out-2110", direction: "outbound", fromEmail: "moutsim@nomeriq.example", sentAt: "2026-10-30T21:10:00Z" });
  await insertMessage({
    key: "in-1103",
    direction: "inbound",
    fromEmail: "earlier@northwind.example",
    sentAt: "2026-11-03T18:45:00Z",
    receivedAt: "2026-11-03T18:45:00Z",
  });

  // A live row that was stored after the import but really happened earlier: created_at must not win.
  await insertMessage({
    key: "live-1102",
    direction: "inbound",
    fromEmail: "earlier@northwind.example",
    source: "imap",
    createdAt: LIVE_TIME,
    sentAt: "2026-11-02T08:00:00Z",
    receivedAt: "2026-11-02T08:00:00Z",
  });

  // Two rows with the same real time, to prove the tiebreaker keeps them from shuffling.
  await insertMessage({ key: "tie-a", direction: "inbound", fromEmail: "earlier@northwind.example", receivedAt: "2026-10-29T07:00:00Z" });
  await insertMessage({ key: "tie-b", direction: "outbound", fromEmail: "moutsim@nomeriq.example", sentAt: "2026-10-29T07:00:00Z" });

  // What the import leaves behind: no body, no excerpt, and the reason in `error`.
  await insertMessage({
    key: "blank",
    direction: "inbound",
    fromEmail: "earlier@northwind.example",
    receivedAt: "2026-10-28T10:00:00Z",
    error: "excerpt only, full body pending mailbox sync",
  });
  await insertMessage({
    key: "excerpt",
    direction: "inbound",
    fromEmail: "earlier@northwind.example",
    receivedAt: "2026-10-28T09:00:00Z",
    excerpt: "Short excerpt the old portal kept.",
  });
  await insertMessage({
    key: "full",
    direction: "inbound",
    fromEmail: "earlier@northwind.example",
    receivedAt: "2026-10-28T08:00:00Z",
    bodyText: "A real body, stored in full.",
  });
});

afterAll(async () => {
  await removeFixture();
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("the conversation thread is ordered by the time it really happened", () => {
  it("gives every imported row the same created_at, so created_at alone cannot order it", async () => {
    const db = await getDb();
    const distinct = await db.query<{ n: number }>(
      `SELECT count(DISTINCT created_at)::int AS n FROM messages
       WHERE conversation_id = $1 AND source = 'legacy_import'`,
      [conversationId],
    );
    expect(distinct.rows[0].n).toBe(1);
  });

  it("comes back newest first by sent_at/received_at, whatever the created_at", async () => {
    const conversation = await getConversation(conversationId);
    expect(conversation).not.toBeNull();
    const order = conversation!.messages.map((message) => message.id);

    expect(order.slice(0, 6)).toEqual([
      ids["in-1104"],
      ids["in-1103"],
      ids["live-1102"],
      ids["out-2110"],
      ids["in-1030"],
      ids["out-1015"],
    ]);
    // equal real times stay adjacent; which of the two comes first is fixed by the tiebreaker
    expect([order[6], order[7]].sort()).toEqual([ids["tie-a"], ids["tie-b"]].sort());
    expect(order.slice(8)).toEqual([ids["blank"], ids["excerpt"], ids["full"]]);
    expect(order).toHaveLength(11);

    // and the whole list is non-increasing by the real time, not merely the first six
    const db = await getDb();
    const stamps = await db.query<{ id: string; real_time: string }>(
      `SELECT id, COALESCE(sent_at, received_at, created_at) AS real_time
       FROM messages WHERE conversation_id = $1`,
      [conversationId],
    );
    const realTime = new Map(
      stamps.rows.map((row) => [row.id, new Date(row.real_time as unknown as string).getTime()]),
    );
    const values = order.map((id) => realTime.get(id) ?? Number.NaN);
    expect(values).toEqual([...values].sort((a, b) => b - a));
  });

  it("returns the same order on every render", async () => {
    const first = (await getConversation(conversationId))!.messages.map((message) => message.id);
    const second = (await getConversation(conversationId))!.messages.map((message) => message.id);
    const third = (await getConversation(conversationId))!.messages.map((message) => message.id);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("treats the newest inbound by real time as the one being replied to", async () => {
    const conversation = (await getConversation(conversationId))!;
    // the newest inbound in the thread, not the prospect's contact address and not the last stored row
    expect(conversation.replyTo).toBe("latest@northwind.example");
  });

  it("marks the first card, not the last, as the latest message", () => {
    const page = readFileSync("src/app/(app)/email/[id]/page.tsx", "utf8");
    expect(page).toContain("index === 0 && inbound");
    expect(page).not.toContain("conversation.messages.length - 1 && inbound");
  });
});

describe("a message with no body", () => {
  it("shows the pending notice when there is no excerpt, and never the raw error", async () => {
    const db = await getDb();
    const row = await db.query<{ body_text: string; snippet: string | null; error: string | null }>(
      `SELECT body_text, snippet, error FROM messages WHERE id = $1`,
      [ids["blank"]],
    );
    // the fixture reproduces the live row: nothing to show but the importer's reason
    expect(row.rows[0].body_text).toBe("");
    expect(row.rows[0].snippet).toBeNull();
    expect(row.rows[0].error).toBe("excerpt only, full body pending mailbox sync");

    const conversation = (await getConversation(conversationId))!;
    const message = conversation.messages.find((item) => item.id === ids["blank"])!;
    expect(messageBodyForDisplay(message)).toEqual({
      kind: "pending",
      text: "Full text not imported yet. It appears when the mailbox is connected.",
    });
    expect(MESSAGE_BODY_PENDING_TEXT).toBe(
      "Full text not imported yet. It appears when the mailbox is connected.",
    );
  });

  it("shows the excerpt when one was kept", async () => {
    const conversation = (await getConversation(conversationId))!;
    const message = conversation.messages.find((item) => item.id === ids["excerpt"])!;
    expect(messageBodyForDisplay(message)).toEqual({
      kind: "excerpt",
      text: "Short excerpt the old portal kept.",
    });
  });

  it("leaves a message that has a body exactly as it was", async () => {
    const conversation = (await getConversation(conversationId))!;
    const message = conversation.messages.find((item) => item.id === ids["full"])!;
    expect(messageBodyForDisplay(message)).toEqual({
      kind: "body",
      text: "A real body, stored in full.",
    });
  });

  it("never prints the importer's reason as the text of any message", async () => {
    const conversation = (await getConversation(conversationId))!;
    const texts = conversation.messages.map((message) => messageBodyForDisplay(message).text);
    expect(texts.some((text) => text.includes("excerpt only"))).toBe(false);
    expect(texts.some((text) => text.includes("pending mailbox sync"))).toBe(false);

    const page = readFileSync("src/app/(app)/email/[id]/page.tsx", "utf8");
    expect(page).toContain("messageBodyForDisplay(message)");
    expect(page).not.toContain("message.error");
  });
});

/**
 * A static check only: vitest runs in a node environment here, so the button is not rendered. What is
 * asserted is the markup that makes it wrap as a row instead of breaking the label.
 */
describe("the Suggest with AI button", () => {
  const source = readFileSync("src/components/conversation-actions.tsx", "utf8");
  // the reply card's header row: from its container down to the label's ternary
  const header = source.slice(
    source.indexOf("border-b border-line px-5 py-4"),
    source.indexOf('"Suggest again"'),
  );

  it("keeps the label on one line and lets the header row wrap instead", () => {
    expect(header).toContain("Write reply");
    expect(header).toContain("flex-wrap");
    expect(header).toContain("whitespace-nowrap");
    // the button takes a full row below `sm`, and sits inline beside the heading from `sm` up
    expect(header).toContain("w-full");
    expect(header).toContain("sm:w-auto");
  });

  it("keeps the wording and the wand/spinner behaviour", () => {
    expect(source).toContain('"Suggest again"');
    expect(source).toContain('"Suggest with AI"');
    expect(source).toContain("WandSparkles size={10}");
    expect(source).toContain('<LoaderCircle size={10} className="spin" />');
  });
});