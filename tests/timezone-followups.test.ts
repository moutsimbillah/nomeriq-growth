import { beforeAll, afterAll, afterEach, it, expect, vi } from 'vitest';
import { getDb, closeDb } from '@/lib/db/client';
import { getWorkspaceSettings } from '@/lib/services/settings';
import { listFollowUpCandidates } from '@/lib/services/followups';

let db: any;
let prospectId = '';
let initial: any;

beforeAll(async () => {
  db = await getDb();
  initial = await getWorkspaceSettings();
  const rows = await db.query(
    "INSERT INTO prospects (id, business_name, name_key, created_by_type, status) VALUES (gen_random_uuid(), 'FollowZone', 'followzonefixture', 'api', 'contacted') RETURNING id"
  );
  prospectId = rows.rows[0].id;
  await db.query(
    "INSERT INTO conversations (id, prospect_id, subject, last_outbound_at) VALUES (gen_random_uuid(), $1, 'Fixture', '2026-11-05T18:59:00Z')",
    [prospectId]
  );
});

afterEach(() => {
  vi.useRealTimers();
});

it.each([
  ['Asia/Karachi', true, 1],
  ['America/New_York', false, 0],
])('%s: due=%s daysSince=%s', async (zone, due, daysSince) => {
  await db.query(
    'UPDATE workspace_settings SET timezone=$1, follow_up_max=$2, follow_up_delay_1_days=$3',
    [zone, 1, 1]
  );
  vi.useFakeTimers({ now: new Date('2026-11-05T19:00:00Z'), toFake: ['Date'] });
  const candidates = await listFollowUpCandidates();
  const candidate = candidates.find((c: any) => c.prospectId === prospectId);
  expect(candidate).toBeDefined();
  expect(candidate!.due).toBe(due);
  expect(candidate!.daysSinceLastOutbound).toBe(daysSince);
});

afterAll(async () => {
  await db.query(
    'UPDATE workspace_settings SET timezone=$1, follow_up_max=$2, follow_up_delay_1_days=$3',
    [initial.timezone, initial.followUpMax, initial.followUpDelay1Days]
  );
  await db.query('DELETE FROM prospects WHERE id=$1', [prospectId]);
  await closeDb();
});
