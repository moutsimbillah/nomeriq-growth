import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { prepareFollowUpDraftOutcome } from "@/lib/services/followups";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * Why the "Prepare due follow-ups" button prepared nothing.
 *
 * The button reported "No follow-ups are due right now" for every empty run. Two of the three real
 * causes are not about timing — the switch is off, or today's limit is spent — and both are the most
 * likely answers on a fresh workspace, so the founder was told the wrong thing in exactly the case
 * they were most likely to hit. Each cause now has its own sentence, and this pins all three.
 *
 * It also pins the cap question item 0 asks outright: the button DOES respect a cap, so bulk
 * preparation does not need disabling. The cap is the workspace day's limit, and a second run on the
 * same day prepares nothing rather than double it.
 */

let userId = "";
const leads: string[] = [];

async function seedLead(index: number, name: string): Promise<void> {
  const db = await getDb();
  // A distinct business domain per lead: different leads may not share a business email domain.
  const domain = `reason${index}.example.test`;
  const email = `reason${index}@${domain}`;
  const prospect = await db.query<{ id: string }>(
    `INSERT INTO prospects (id, business_name, name_key, status, created_by_type, do_not_contact)
     VALUES (gen_random_uuid(), $1, $2, 'contacted', 'legacy', false) RETURNING id`,
    [name, name.toLowerCase().replace(/[^a-z0-9]+/g, "-")],
  );
  const id = prospect.rows[0].id;
  leads.push(id);
  await db.query(
    `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type, is_primary)
     VALUES (gen_random_uuid(), $1, $2, $2, $3, 'official_website', true)`,
    [id, email, `https://${domain}`],
  );
  const sentAt = new Date(Date.now() - (index + 12) * 86_400_000).toISOString();
  await db.query(
    `INSERT INTO conversations (id, prospect_id, subject, last_outbound_at, unread_count)
     VALUES (gen_random_uuid(), $1, 'Subject', $2::timestamptz, 0)`,
    [id, sentAt],
  );
  await db.query(
    `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
                         ai_generated, created_by_type, sent_at, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'first_contact', 1, 'sent', 'Subject', 'Body', $2, false, 'legacy',
             $3::timestamptz, now(), now())`,
    [id, email, sentAt],
  );
}

beforeAll(async () => {
  const db = await getDb();
  await ensureWorkspaceDefaults();
  userId = crypto.randomUUID();
  await db.query(
    `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
     VALUES ($1, $2, $2, 'Reason', $3, 'founder')`,
    [userId, "follow-up-reason@test.nomeriq.com", hashPassword("TestPassw0rd!123")],
  );
  await seedLead(1, "Reason Lead One");
  await seedLead(2, "Reason Lead Two");
  // A clean slate for this file: nothing prepared today, the switch explicitly off.
  await db.query(`DELETE FROM drafts WHERE kind = 'follow_up' AND prospect_id = ANY($1::uuid[])`, [leads]);
  await db.query(
    `UPDATE workspace_settings SET follow_up_auto_enabled = false, follow_up_daily_limit = 10, follow_up_max = 2 WHERE id = 'default'`,
  );
});

afterAll(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM drafts WHERE prospect_id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM conversations WHERE prospect_id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM prospect_emails WHERE prospect_id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM prospects WHERE id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await db.query(
    `UPDATE workspace_settings SET follow_up_auto_enabled = false, follow_up_daily_limit = 10, follow_up_max = 2 WHERE id = 'default'`,
  );
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

describe("prepare due follow-ups: the real reason for an empty run", () => {
  it("names the switch, not the clock, when automatic follow-ups are off", async () => {
    const outcome = await prepareFollowUpDraftOutcome({ userId });
    expect(outcome.drafts).toHaveLength(0);
    expect(outcome.reason).toMatch(/switched off in Settings/i);
    // It also says how many are waiting, so the number is not lost just because nothing was prepared.
    expect(outcome.reason).toMatch(/due and waiting/i);
    expect(outcome.reason).not.toMatch(/nothing is due yet/i);
  });

  it("respects the daily cap and says so when the day's room is spent", async () => {
    const db = await getDb();
    await db.query(
      `UPDATE workspace_settings SET follow_up_auto_enabled = true, follow_up_daily_limit = 1 WHERE id = 'default'`,
    );
    const first = await prepareFollowUpDraftOutcome({ userId });
    expect(first.drafts).toHaveLength(1);
    expect(first.reason).toBeNull();
    expect(first.room).toBe(1);

    // The second run the same day has no room: it prepares nothing and says which cap stopped it.
    const second = await prepareFollowUpDraftOutcome({ userId });
    expect(second.drafts).toHaveLength(0);
    expect(second.room).toBe(0);
    expect(second.reason).toMatch(/preparation limit of 1 follow-up draft/i);
  });

  it("says nothing is due only when nothing is in fact due", async () => {
    const db = await getDb();
    // Stop every seeded conversation being a candidate: an inbound reply newer than the last send.
    for (const id of leads) {
      await db.query(
        `INSERT INTO messages (id, conversation_id, prospect_id, direction, source, from_email, subject, body_text, received_at)
         SELECT gen_random_uuid(), c.id, c.prospect_id, 'inbound', 'seed', 'someone@example.test',
                'Re: Subject', 'Thanks, not interested.', now()
           FROM conversations c WHERE c.prospect_id = $1`,
        [id],
      );
      await db.query(
        `UPDATE conversations SET classification = 'not_interested', last_inbound_at = now() WHERE prospect_id = $1`,
        [id],
      );
    }
    await db.query(
      `UPDATE workspace_settings SET follow_up_auto_enabled = true, follow_up_daily_limit = 10 WHERE id = 'default'`,
    );

    const outcome = await prepareFollowUpDraftOutcome({ userId });
    expect(outcome.drafts).toHaveLength(0);
    expect(outcome.reason).toMatch(/No conversation is due for a follow-up right now/i);
  });
});