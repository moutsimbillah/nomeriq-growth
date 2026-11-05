import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const { translateToEnglish } = vi.hoisted(() => ({ translateToEnglish: vi.fn() }));

vi.mock('@/lib/ai/translation', () => ({ translateToEnglish }));

import { closeDb, getDb, type DbClient } from '@/lib/db/client';
import { translateMessage } from '@/lib/services/message-translations';

const ARABIC = 'مرحبا بالعالم';

let db: DbClient;
const seededIds: string[] = [];

async function seed(body: string, direction: 'inbound' | 'outbound' = 'inbound'): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO messages (id, direction, source, from_email, body_text)
     VALUES (gen_random_uuid(), $1, 'seed', 'fixture@example.test', $2)
     RETURNING id`,
    [direction, body],
  );
  const id = result.rows[0].id;
  seededIds.push(id);
  return id;
}

async function cacheRowCount(ids: string[]): Promise<number> {
  const count = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM message_translations WHERE message_id = ANY($1::uuid[])`,
    [ids],
  );
  return count.rows[0]?.n ?? -1;
}

beforeAll(async () => {
  db = await getDb();
});

beforeEach(() => {
  translateToEnglish.mockReset();
  translateToEnglish.mockResolvedValue({
    ok: true,
    sourceLanguage: 'ar',
    translatedText: 'Hello',
    provider: 'openai',
    model: 'gpt-5-mini',
    isEnglish: false,
  });
});

afterAll(async () => {
  for (const id of seededIds) {
    await db.query(`DELETE FROM messages WHERE id = $1`, [id]);
  }
  await closeDb();
});

it('returns a safe failure and writes no cache row when the provider is unavailable', async () => {
  translateToEnglish.mockResolvedValue({
    ok: false,
    code: 'provider_unavailable',
    reason: 'Translation provider is unavailable.',
  });
  const id = await seed(ARABIC);

  const outcome = await translateMessage(id);

  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.code).toBe('provider_unavailable');
  expect(translateToEnglish).toHaveBeenCalledTimes(1);
  expect(await cacheRowCount([id])).toBe(0);
});

it('refuses an outbound message and an empty body without calling the provider', async () => {
  const outboundId = await seed(ARABIC, 'outbound');
  const emptyId = await seed('');

  const outbound = await translateMessage(outboundId);
  const empty = await translateMessage(emptyId);

  expect(outbound.ok).toBe(false);
  if (!outbound.ok) expect(outbound.code).toBe('not_inbound');
  expect(empty.ok).toBe(false);
  if (!empty.ok) expect(empty.code).toBe('empty');
  expect(translateToEnglish).toHaveBeenCalledTimes(0);
  expect(await cacheRowCount([outboundId, emptyId])).toBe(0);
});

it('caches an English result on the second call without a second provider call', async () => {
  translateToEnglish.mockResolvedValue({
    ok: true,
    sourceLanguage: 'en',
    translatedText: 'Hello world',
    provider: 'openai',
    model: 'gpt-5-mini',
    isEnglish: true,
  });
  const id = await seed('Hello world');

  const first = await translateMessage(id);
  expect(first.ok).toBe(true);
  if (first.ok) {
    expect(first.translation.status).toBe('english');
    expect(first.cached).toBe(false);
  }
  expect(translateToEnglish).toHaveBeenCalledTimes(1);

  const second = await translateMessage(id);
  expect(second.ok).toBe(true);
  if (second.ok) {
    expect(second.translation.status).toBe('english');
    expect(second.cached).toBe(true);
  }
  expect(translateToEnglish).toHaveBeenCalledTimes(1);
});

it('translates two concurrent requests for the same message with one provider call', async () => {
  const id = await seed(ARABIC);

  const [first, second] = await Promise.all([translateMessage(id), translateMessage(id)]);

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(translateToEnglish).toHaveBeenCalledTimes(1);
  expect(await cacheRowCount([id])).toBe(1);
});
