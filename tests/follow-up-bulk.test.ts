import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { closeDb, getDb } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { FOLLOW_UP_BATCH_MAX, prepareFollowUpDraftOutcome } from "@/lib/services/followups";
import { approveDrafts } from "@/lib/services/drafts";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * Email item 4 — follow-ups in bulk. The founder ticks rows and clicks Prepare selected, or Prepare
 * next N (newest contacts first); prepared drafts are approved selected or all. Preparing and approving
 * never send. The "Automatic follow-ups" switch governs only the scheduled job; "Follow-ups per day"
 * caps every run.
 */

let userId = "";
const leads: string[] = [];

/** Lead n was last contacted (n + 12) days ago, so a lower n is a newer contact. */
async function seedLead(index: number): Promise<string> {
  const db = await getDb();
  const email = `bulk${index}@example.test`;
  const name = `Bulk Lead ${index}`;
  const prospect = await db.query<{ id: string }>(
    `INSERT INTO prospects (id, business_name, name_key, status, created_by_type, do_not_contact)
     VALUES (gen_random_uuid(), $1, $2, 'contacted', 'legacy', false) RETURNING id`,
    [name, `bulk-lead-${index}`],
  );
  const id = prospect.rows[0]!.id;
  leads.push(id);
  await db.query(
    `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type, is_primary)
     VALUES (gen_random_uuid(), $1, $2, $2, 'https://example.test', 'official_website', true)`,
    [id, email],
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
  return id;
}

async function followUpDrafts(): Promise<{ id: string; prospect_id: string; status: string }[]> {
  const db = await getDb();
  return (await db.query<{ id: string; prospect_id: string; status: string }>(
    `SELECT id, prospect_id, status FROM drafts WHERE kind = 'follow_up' AND prospect_id = ANY($1::uuid[])`,
    [leads],
  )).rows;
}

async function resetDrafts() {
  const db = await getDb();
  await db.query(`DELETE FROM drafts WHERE kind = 'follow_up' AND prospect_id = ANY($1::uuid[])`, [leads]);
}

beforeAll(async () => {
  const db = await getDb();
  await ensureWorkspaceDefaults();
  userId = crypto.randomUUID();
  await db.query(
    `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
     VALUES ($1, $2, $2, 'Bulk', $3, 'founder')`,
    [userId, "follow-up-bulk@test.nomeriq.com", hashPassword("TestPassw0rd!123")],
  );
  for (let index = 1; index <= 5; index += 1) await seedLead(index);
  // Remove other files' follow-up drafts made "today" so the day's room is this file's own.
  await db.query(`DELETE FROM drafts WHERE kind = 'follow_up' AND created_by_type = 'founder'`);
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
});

describe("Prepare selected and Prepare next N", () => {
  it("the scheduled job still needs the Automatic follow-ups switch", async () => {
    await resetDrafts();
    const outcome = await prepareFollowUpDraftOutcome({ userId });
    expect(outcome.drafts).toHaveLength(0);
    expect(outcome.reason).toMatch(/switched off in Settings/i);
  });

  it("Prepare selected writes drafts for exactly the ticked leads, with the switch off", async () => {
    await resetDrafts();
    const picked = [leads[3]!, leads[1]!];
    const outcome = await prepareFollowUpDraftOutcome({ userId, prospectIds: picked, limit: picked.length, trigger: "founder" });
    expect(outcome.drafts).toHaveLength(2);
    expect(new Set((await followUpDrafts()).map((d) => d.prospect_id))).toEqual(new Set(picked));
    expect((await followUpDrafts()).every((d) => d.status === "draft")).toBe(true);
  });

  it("Prepare next N takes the newest contacts first and stops at N", async () => {
    await resetDrafts();
    const db = await getDb();
    await db.query(`DELETE FROM drafts WHERE kind = 'follow_up' AND created_by_type = 'founder'`);
    const outcome = await prepareFollowUpDraftOutcome({ userId, limit: 2, trigger: "founder" });
    expect(outcome.drafts).toHaveLength(2);
    // Lead 1 and lead 2 were contacted most recently.
    expect(new Set((await followUpDrafts()).map((d) => d.prospect_id))).toEqual(new Set([leads[0], leads[1]]));
  });

  it("a lead with a draft already waiting is not prepared twice", async () => {
    const before = (await followUpDrafts()).length;
    const outcome = await prepareFollowUpDraftOutcome({ userId, prospectIds: [leads[0]!], limit: 1, trigger: "founder" });
    expect(outcome.drafts).toHaveLength(0);
    expect((await followUpDrafts()).length).toBe(before);
  });

  it("every run stays within Follow-ups per day", async () => {
    await resetDrafts();
    const db = await getDb();
    await db.query(`DELETE FROM drafts WHERE kind = 'follow_up' AND created_by_type = 'founder'`);
    await db.query(`UPDATE workspace_settings SET follow_up_daily_limit = 3 WHERE id = 'default'`);
    const outcome = await prepareFollowUpDraftOutcome({ userId, limit: 5, trigger: "founder" });
    expect(outcome.drafts).toHaveLength(3);
    const again = await prepareFollowUpDraftOutcome({ userId, limit: 5, trigger: "founder" });
    expect(again.drafts).toHaveLength(0);
    expect(again.reason).toMatch(/limit of 3/);
    await db.query(`UPDATE workspace_settings SET follow_up_daily_limit = 10 WHERE id = 'default'`);
  });

  it("one click is capped at the batch maximum", () => {
    expect(FOLLOW_UP_BATCH_MAX).toBe(50);
    const route = fs.readFileSync(path.join(process.cwd(), "src/app/api/followups/prepare/route.ts"), "utf8");
    expect(route).toContain(".max(FOLLOW_UP_BATCH_MAX)");
    expect(route).toContain('trigger: "founder"');
  });
});

describe("Approve selected and Approve all", () => {
  it("approves every listed draft, reports refusals with a reason, and sends nothing", async () => {
    const drafts = await followUpDrafts();
    expect(drafts.length).toBeGreaterThan(0);
    const db = await getDb();
    const sendsBefore = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbound_sends`)).rows[0]!.n;
    const result = await approveDrafts([...drafts.map((d) => d.id), crypto.randomUUID()], userId);
    expect(result.approved.sort()).toEqual(drafts.map((d) => d.id).sort());
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]!.reason).toMatch(/not found/i);
    expect((await followUpDrafts()).every((d) => d.status === "approved")).toBe(true);
    const sendsAfter = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbound_sends`)).rows[0]!.n;
    expect(sendsAfter).toBe(sendsBefore);
  });

  it("the Email page uses the bulk lists, and the route only approves", () => {
    const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
    const page = read("src/app/(app)/email/page.tsx");
    expect(page).toContain("<FollowUpEligibleList");
    expect(page).toContain("<FollowUpDraftList");
    expect(page).toContain("!candidate.activeDraftId");
    const bulk = read("src/components/follow-up-bulk.tsx");
    for (const label of ["Select all", "Prepare selected", "Prepare next", "Approve selected", "Approve all ready"]) {
      expect(bulk, label).toContain(label);
    }
    const route = read("src/app/api/drafts/approve-bulk/route.ts");
    expect(route).toContain("approveDrafts(");
    expect(route).not.toMatch(/sendDraft|outbound_sends|startCampaign/);
  });
});
