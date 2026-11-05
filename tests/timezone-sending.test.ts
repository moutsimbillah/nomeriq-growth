import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { closeDb, getDb } from "@/lib/db/client";
import { assertAccountCanSend } from "@/lib/services/email-sending";
import { getWorkspaceSettings } from "@/lib/services/settings";

/**
 * RED: the daily send cap must be counted over the workspace's local calendar
 * day, not a rolling 24 hours. A send from just before local midnight is
 * yesterday's send, so it must not consume today's allowance.
 */

const FIXTURE_EMAIL = "normalizedtimezone-send@example.test";
let accountId = "";
let initialTimezone = "";

beforeAll(async () => {
  const db = await getDb();
  initialTimezone = (await getWorkspaceSettings()).timezone;
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO email_accounts (
       id, name, provider, email_address, normalized_email, from_name,
       status, daily_send_limit, is_default)
     VALUES (gen_random_uuid(), 'Fixture', 'sandbox', $1, $1, 'Fixture',
             'connected', 1, false)
     RETURNING id`,
    [FIXTURE_EMAIL],
  );
  accountId = inserted.rows[0].id;
});

afterAll(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM outbound_sends WHERE account_id = $1`, [accountId]);
  await db.query(`DELETE FROM email_accounts WHERE id = $1`, [accountId]);
  await db.query(`UPDATE workspace_settings SET timezone = $1 WHERE id = 'default'`, [
    initialTimezone,
  ]);
  await closeDb();
});

it.each([
  ["Asia/Karachi", "2026-11-05T19:00:00Z"],
  ["America/New_York", "2026-11-05T05:00:00Z"],
])("counts sends per local day in %s", async (timezone, localMidnightIso) => {
  const db = await getDb();
  await db.query(`UPDATE workspace_settings SET timezone = $1 WHERE id = 'default'`, [timezone]);
  await db.query(`DELETE FROM outbound_sends WHERE account_id = $1`, [accountId]);

  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-05T20:00:00Z"));

  const insertSend = (completedAt: Date) =>
    db.query(
      `INSERT INTO outbound_sends (id, account_id, idempotency_key, status, completed_at)
       VALUES (gen_random_uuid(), $1, gen_random_uuid()::text, 'accepted', $2)`,
      [accountId, completedAt],
    );

  try {
    const localMidnight = new Date(localMidnightIso);

    // One millisecond before local midnight: yesterday. A rolling 24h window
    // counts it and wrongly refuses; a local-day window must allow the send.
    await insertSend(new Date(localMidnight.getTime() - 1));
    await expect(assertAccountCanSend(accountId)).resolves.toBeUndefined();

    // Exactly local midnight: today's only allowed send, so the cap is reached.
    await insertSend(localMidnight);
    await expect(assertAccountCanSend(accountId)).rejects.toMatchObject({
      code: "daily_limit_reached",
    });
  } finally {
    vi.useRealTimers();
  }
});
