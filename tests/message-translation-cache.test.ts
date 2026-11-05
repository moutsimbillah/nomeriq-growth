import { beforeAll, afterAll, it, expect, vi } from "vitest";

const { translateToEnglish } = vi.hoisted(() => ({ translateToEnglish: vi.fn() }));

vi.mock("@/lib/ai/translation", () => ({ translateToEnglish }));

import { closeDb, getDb } from "@/lib/db/client";
import { translateMessage, getMessageTranslation } from "@/lib/services/message-translations";

// Each test owns its own message, so no test depends on state or mock call
// history left behind by a previous test. Vitest clears mock call history before
// every test (its default `clearMocks`), so a total like "2 calls" is only
// meaningful as a delta measured inside one test.
const ID_CACHED = "6f2f3c1a-0d5b-4e7a-9c48-1b2d3e4f5a60";
const ID_STORED = "6f2f3c1a-0d5b-4e7a-9c48-1b2d3e4f5a61";
const ID_INVALIDATED = "6f2f3c1a-0d5b-4e7a-9c48-1b2d3e4f5a62";
const IDS = [ID_CACHED, ID_STORED, ID_INVALIDATED];
const ORIGINAL = "مرحبا بالعالم";
const UPDATED = "وداعا أيها العالم";

async function seedMessage(id: string, body: string): Promise<void> {
  const db = await getDb();
  // Idempotent: a crashed earlier run must not break the next one. Deleting the
  // message cascades to its translation row.
  await db.query(`DELETE FROM messages WHERE id = $1`, [id]);
  await db.query(
    `INSERT INTO messages (id, direction, source, from_email, body_text, subject)
     VALUES ($1, 'inbound', 'seed', 'fixture@example.test', $2, 'Fixture')`,
    [id, body],
  );
}

beforeAll(async () => {
  await seedMessage(ID_CACHED, ORIGINAL);
  await seedMessage(ID_STORED, ORIGINAL);
  await seedMessage(ID_INVALIDATED, ORIGINAL);
  translateToEnglish.mockResolvedValue({
    ok: true,
    sourceLanguage: "ar",
    translatedText: "Hello",
    provider: "fixture",
    model: "fixture",
    isEnglish: false,
  });
});

afterAll(async () => {
  const db = await getDb();
  for (const id of IDS) await db.query(`DELETE FROM messages WHERE id = $1`, [id]);
  await closeDb();
});

it("translates a message, then serves the second call from cache", async () => {
  translateToEnglish.mockClear();

  const first = await translateMessage(ID_CACHED);
  expect(first.ok).toBe(true);
  if (first.ok) expect(first.translation.translatedText).toBe("Hello");
  expect(first.ok && first.translation.cached).toBe(false);
  expect(translateToEnglish).toHaveBeenCalledTimes(1);

  const second = await translateMessage(ID_CACHED);
  expect(second.ok).toBe(true);
  if (second.ok) expect(second.translation.cached).toBe(true);
  // A cache hit must not reach the provider: the delta stays at one call.
  expect(translateToEnglish).toHaveBeenCalledTimes(1);
});

it("keeps the stored body unchanged and writes exactly one translation row", async () => {
  translateToEnglish.mockClear();
  const db = await getDb();

  const translated = await translateMessage(ID_STORED);
  expect(translated.ok).toBe(true);
  expect(translateToEnglish).toHaveBeenCalledTimes(1);

  const body = await db.query<{ body_text: string }>(`SELECT body_text FROM messages WHERE id = $1`, [ID_STORED]);
  expect(body.rows[0]?.body_text).toBe(ORIGINAL);
  const count = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM message_translations WHERE message_id = $1`,
    [ID_STORED],
  );
  expect(count.rows[0]?.n).toBe(1);
});

it("invalidates the cache when the body changes and translates again", async () => {
  translateToEnglish.mockClear();
  const db = await getDb();

  // One test owns the whole story, so the call count below is a delta measured
  // here rather than a total inherited from an earlier test.
  const first = await translateMessage(ID_INVALIDATED);
  expect(first.ok).toBe(true);
  expect(translateToEnglish).toHaveBeenCalledTimes(1);

  const cached = await translateMessage(ID_INVALIDATED);
  expect(cached.ok).toBe(true);
  if (cached.ok) expect(cached.translation.cached).toBe(true);
  // The cache hit was served once, without a second provider call.
  expect(translateToEnglish).toHaveBeenCalledTimes(1);

  await db.query(`UPDATE messages SET body_text = $1 WHERE id = $2`, [UPDATED, ID_INVALIDATED]);
  expect(await getMessageTranslation(ID_INVALIDATED)).toBeNull();

  const again = await translateMessage(ID_INVALIDATED);
  expect(again.ok).toBe(true);
  if (again.ok) expect(again.translation.translatedText).toBe("Hello");
  // Initial translate plus post-invalidation translate: a delta of two calls.
  expect(translateToEnglish).toHaveBeenCalledTimes(2);

  // Re-translation refreshed the one row and never overwrote the message body
  // with the translated text.
  const body = await db.query<{ body_text: string }>(`SELECT body_text FROM messages WHERE id = $1`, [ID_INVALIDATED]);
  expect(body.rows[0]?.body_text).toBe(UPDATED);
  const count = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM message_translations WHERE message_id = $1`,
    [ID_INVALIDATED],
  );
  expect(count.rows[0]?.n).toBe(1);
});
