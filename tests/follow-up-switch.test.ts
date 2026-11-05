import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { prepareFollowUpDrafts } from "@/lib/services/followups";
import { ensureWorkspaceDefaults, updateWorkspaceSettings } from "@/lib/services/settings";

/**
 * The 04:00 job must not turn a fresh import into hundreds of follow-up drafts overnight.
 *
 * Every lead here has a sent first contact months old, so all of them are "due" — which is exactly the
 * imported shape. The switch keeps the job off, and the daily limit is a day's quota, not a run's, so a
 * second run the same day cannot double it.
 */

let userId = "";
const leads: string[] = [];

async function seed() {
  const db = await getDb();
  await ensureWorkspaceDefaults();
  userId = crypto.randomUUID();
  await db.query(
    `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
     VALUES ($1, $2, $2, 'Follow Up', $3, 'founder')`,
    [userId, "follow-up-switch@test.nomeriq.com", hashPassword("TestPassw0rd!123")],
  );
  for (let index = 0; index < 4; index += 1) {
    const name = `Switch Lead ${index + 1}`;
    const email = `switch${index + 1}@example.test`;
    const prospect = await db.query<{ id: string }>(
      `INSERT INTO prospects (id, business_name, name_key, status, created_by_type, do_not_contact)
       VALUES (gen_random_uuid(), $1, $2, 'contacted', 'legacy', false) RETURNING id`,
      [name, name.toLowerCase().replace(/[^a-z0-9]+/g, "-")],
    );
    leads.push(prospect.rows[0].id);
    await db.query(
      `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type, is_primary)
       VALUES (gen_random_uuid(), $1, $2, $2, 'https://example.test', 'official_website', true)`,
      [prospect.rows[0].id, email],
    );
    // lead 1 sent most recently: the cap must take the newest, not the oldest
    const sentAt = new Date(Date.now() - (index + 10) * 86_400_000).toISOString();
    await db.query(
      `INSERT INTO conversations (id, prospect_id, subject, last_outbound_at, unread_count)
       VALUES (gen_random_uuid(), $1, 'Subject', $2::timestamptz, 0)`,
      [prospect.rows[0].id, sentAt],
    );
    await db.query(
      `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
                           ai_generated, created_by_type, sent_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'first_contact', 1, 'sent', 'Subject', 'Body', $2, false, 'legacy',
               $3::timestamptz, now(), now())`,
      [prospect.rows[0].id, email, sentAt],
    );
  }
  await db.query(`UPDATE workspace_settings SET follow_up_auto_enabled = false, follow_up_daily_limit = 10 WHERE id = 'default'`);
}

async function followUps() {
  const db = await getDb();
  const result = await db.query<{ prospect_id: string }>(
    `SELECT prospect_id FROM drafts WHERE kind = 'follow_up' ORDER BY created_at`,
  );
  return result.rows.map((row) => row.prospect_id);
}

beforeAll(seed);
afterAll(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM drafts WHERE prospect_id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM conversations WHERE prospect_id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM prospect_emails WHERE prospect_id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM prospects WHERE id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await db.query(`UPDATE workspace_settings SET follow_up_auto_enabled = false, follow_up_daily_limit = 10 WHERE id = 'default'`);
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

describe("automatic follow-ups", () => {
  it("drafts nothing while the switch is off", async () => {
    expect(await prepareFollowUpDrafts({ userId })).toHaveLength(0);
    expect(await followUps()).toHaveLength(0);
    const db = await getDb();
    const sends = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbound_sends`);
    expect(sends.rows[0].n).toBe(0);
  });

  it("drafts at most the daily limit, newest send first", async () => {
    const db = await getDb();
    await db.query(`UPDATE workspace_settings SET follow_up_auto_enabled = true, follow_up_daily_limit = 3 WHERE id = 'default'`);
    const created = await prepareFollowUpDrafts({ userId });
    expect(created).toHaveLength(3);
    // lead 1 has the most recent send, so it is first; the fourth lead gets nothing
    expect(await followUps()).toEqual([leads[0], leads[1], leads[2]]);
    const leftOver = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM drafts WHERE kind = 'follow_up' AND prospect_id = $1`,
      [leads[3]],
    );
    expect(leftOver.rows[0].n).toBe(0);
  });

  it("drafts nothing more on a second run the same day", async () => {
    expect(await prepareFollowUpDrafts({ userId })).toHaveLength(0);
    expect(await followUps()).toHaveLength(3);
  });

  it("refuses more than 50 a day, and keeps the switch off until it is on", async () => {
    const db = await getDb();
    await db.query(`UPDATE workspace_settings SET legal_business_name = 'Nomeriq' WHERE id = 'default'`);

    const off = await updateWorkspaceSettings({ followUpAutoEnabled: false }, userId);
    expect(off.followUpAutoEnabled).toBe(false);

    await expect(updateWorkspaceSettings({ followUpDailyLimit: 51 }, userId)).rejects.toThrow(/0 and 50/i);
    const saved = await updateWorkspaceSettings(
      { followUpDailyLimit: 50, followUpAutoEnabled: true },
      userId,
    );
    expect(saved.followUpDailyLimit).toBe(50);
    expect(saved.followUpAutoEnabled).toBe(true);

    // the quota is a day's, not a lead's: raising it lets the next lead through, not all of them
    const more = await prepareFollowUpDrafts({ userId });
    expect(more).toHaveLength(1);
    expect(await followUps()).toHaveLength(4);
  });

  it("leaves an excluded lead out without marking it do not contact", async () => {
    const db = await getDb();
    // The same shape as the leads above — contacted, unanswered, due — but kept out of the job.
    const prospect = await db.query<{ id: string }>(
      `INSERT INTO prospects (id, business_name, name_key, status, created_by_type,
                              do_not_contact, follow_up_excluded)
       VALUES (gen_random_uuid(), 'Switch Excluded Lead', 'switch-excluded-lead', 'contacted',
               'legacy', false, true)
       RETURNING id`,
    );
    const excludedId = prospect.rows[0].id;
    leads.push(excludedId);
    const email = "switchexcluded@example.test";
    await db.query(
      `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type, is_primary)
       VALUES (gen_random_uuid(), $1, $2, $2, 'https://example.test', 'official_website', true)`,
      [excludedId, email],
    );
    const sentAt = new Date(Date.now() - 12 * 86_400_000).toISOString();
    await db.query(
      `INSERT INTO conversations (id, prospect_id, subject, last_outbound_at, unread_count)
       VALUES (gen_random_uuid(), $1, 'Subject', $2::timestamptz, 0)`,
      [excludedId, sentAt],
    );
    await db.query(
      `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
                           ai_generated, created_by_type, sent_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'first_contact', 1, 'sent', 'Subject', 'Body', $2, false, 'legacy',
               $3::timestamptz, now(), now())`,
      [excludedId, email, sentAt],
    );
    await db.query(
      `UPDATE workspace_settings SET follow_up_auto_enabled = true, follow_up_daily_limit = 50 WHERE id = 'default'`,
    );

    const before = await followUps();
    expect(await prepareFollowUpDrafts({ userId })).toHaveLength(0);
    expect(await followUps()).toEqual(before);
    expect(before).not.toContain(excludedId);

    // The pairing that matters: excluded from the job, still contactable by hand.
    const flags = await db.query<{ follow_up_excluded: boolean; do_not_contact: boolean }>(
      `SELECT follow_up_excluded, do_not_contact FROM prospects WHERE id = $1`,
      [excludedId],
    );
    expect(flags.rows[0]).toEqual({ follow_up_excluded: true, do_not_contact: false });

    // So it was not skipped for the do_not_contact reason: lift only the exclusion and the same lead
    // is picked up on the very next run, with do_not_contact still false throughout.
    await db.query(`UPDATE prospects SET follow_up_excluded = false WHERE id = $1`, [excludedId]);
    const created = await prepareFollowUpDrafts({ userId });
    expect(created.map((draft) => draft.prospectId)).toEqual([excludedId]);
    expect(await followUps()).toContain(excludedId);
    const after = await db.query<{ do_not_contact: boolean }>(
      `SELECT do_not_contact FROM prospects WHERE id = $1`,
      [excludedId],
    );
    expect(after.rows[0].do_not_contact).toBe(false);
  });
});
