import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { ensureWorkspaceDefaults, updateWorkspaceSettings } from "@/lib/services/settings";
import { createEmailAccount } from "@/lib/email/accounts";
import { saveProspect } from "@/lib/services/prospects";
import { approveDraft, generateDraftForProspect } from "@/lib/services/drafts";
import {
  autoStartDueCampaigns,
  createCampaign,
  listCampaignJournal,
  runDueCampaigns,
  setCampaignStatus,
  startCampaign,
  CAMPAIGN_AUTOSTART_LATE_MS,
} from "@/lib/services/campaigns";
import { zonedWallClockToUtc, wallClockInZone } from "@/lib/dates/timezone";
import type { Category } from "@/lib/types";
import { assessmentFor } from "./helpers/lead-assessment";

/**
 * Auto-start for scheduled campaigns: a campaign the founder created WITH a start time must begin
 * itself, driven by the server-side runner, with no further click — and never start something it
 * should not. Each case owns its own mailbox so filters never collide in the shared database.
 */

const state = {
  userId: "",
  campaigns: [] as string[],
  drafts: [] as string[],
  prospects: [] as string[],
  accounts: [] as string[],
};

function payload(name: string, domain: string, email: string) {
  return {
    businessName: name,
    websiteUrl: `https://${domain}`,
    categories: ["forex"] as Category[],
    signalDescription: `${name} sells paid trading signal subscriptions to retail traders.`,
    email,
    emailSourceType: "official_website" as const,
    emailSourceUrl: `https://${domain}/contact`,
    leadAssessment: assessmentFor(`https://${domain}`),
    evidenceSummary: "A paid signal service with a published contact address.",
    sources: [{ url: `https://${domain}/pricing`, label: "Official pricing page" }],
  };
}

async function newMailbox(): Promise<string> {
  const account = await createEmailAccount(
    {
      name: `Auto Mailbox ${state.accounts.length + 1}`,
      provider: "sandbox",
      emailAddress: `auto-${state.accounts.length + 1}-${crypto.randomUUID().slice(0, 8)}@autostart.test`,
      fromName: "Auto Test",
      dailySendLimit: 200,
      minIntervalSeconds: 5,
      isDefault: false,
    },
    state.userId,
  );
  state.accounts.push(account.id);
  return account.id;
}

async function makeApprovedDraft(accountId: string, name: string, domain: string) {
  const saved = await saveProspect({
    ...payload(name, domain, `hello@${domain}`),
    actorType: "seed",
    actorUserId: state.userId,
  });
  state.prospects.push(saved.prospect.id);
  const draft = await generateDraftForProspect({
    prospectId: saved.prospect.id,
    actorType: "seed",
    actorUserId: state.userId,
  });
  state.drafts.push(draft.id);
  await approveDraft(draft.id, state.userId);
  const db = await getDb();
  await db.query(`UPDATE prospects SET sending_profile_id = $2 WHERE id = $1`, [
    saved.prospect.id,
    accountId,
  ]);
  return draft.id;
}

/** A scheduled campaign with one approved draft, ready to run. Returns its id. */
async function scheduledCampaign(accountId: string, scheduledAt: string, perMinuteCap: number | null = null) {
  const draftId = await makeApprovedDraft(
    accountId,
    `Auto ${state.campaigns.length + 1} Lead`,
    `auto-${state.campaigns.length + 1}-${crypto.randomUUID().slice(0, 6)}.example`,
  );
  const { id } = await createCampaign({
    name: `Auto ${state.campaigns.length + 1}`,
    draftIds: [draftId],
    accountId,
    userId: state.userId,
    authorize: true,
    scheduledAt,
    perMinuteCap,
  });
  state.campaigns.push(id);
  return id;
}

async function campaignRow(id: string) {
  const db = await getDb();
  const result = await db.query<any>(`SELECT * FROM campaigns WHERE id = $1`, [id]);
  return result.rows[0];
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  const db = await getDb();
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
     VALUES (gen_random_uuid(), 'campaign-autostart@local.test', 'campaign-autostart@local.test', 'Auto Founder', $1, 'founder')
     RETURNING id`,
    [hashPassword(crypto.randomUUID())],
  );
  state.userId = user.rows[0].id;
  await updateWorkspaceSettings(
    {
      legalBusinessName: "Nomeriq",
      postalAddress: "1 Test Street, Test City",
      senderSignature: "Test Founder\nNomeriq",
      footerNote: "You received this because we found your public contact.",
    },
    state.userId,
  );
});

afterAll(async () => {
  const db = await getDb();
  if (state.campaigns.length) {
    await db.query(`DELETE FROM campaign_run_journal WHERE campaign_id = ANY($1::uuid[])`, [state.campaigns]);
    await db.query(`DELETE FROM campaign_items WHERE campaign_id = ANY($1::uuid[])`, [state.campaigns]);
    await db.query(`DELETE FROM campaigns WHERE id = ANY($1::uuid[])`, [state.campaigns]);
    await db.query(`DELETE FROM audit_log WHERE entity_id = ANY($1::text[])`, [state.campaigns]);
  }
  if (state.prospects.length) {
    await db.query(`DELETE FROM messages WHERE prospect_id = ANY($1::uuid[])`, [state.prospects]);
    await db.query(`DELETE FROM conversations WHERE prospect_id = ANY($1::uuid[])`, [state.prospects]);
    await db.query(`DELETE FROM outbound_sends WHERE prospect_id = ANY($1::uuid[])`, [state.prospects]);
    await db.query(`DELETE FROM drafts WHERE prospect_id = ANY($1::uuid[])`, [state.prospects]);
    for (const table of [
      "prospect_assessment_overrides",
      "prospect_assessments",
      "prospect_audience_observations",
      "prospect_contact_route_observations",
      "prospect_aliases",
    ]) {
      await db.query(`DELETE FROM ${table} WHERE prospect_id = ANY($1::uuid[])`, [state.prospects]);
    }
    await db.query(`DELETE FROM prospect_emails WHERE prospect_id = ANY($1::uuid[])`, [state.prospects]);
    await db.query(`DELETE FROM prospect_sources WHERE prospect_id = ANY($1::uuid[])`, [state.prospects]);
    await db.query(`DELETE FROM prospects WHERE id = ANY($1::uuid[])`, [state.prospects]);
  }
  if (state.accounts.length) {
    await db.query(`DELETE FROM email_accounts WHERE id = ANY($1::uuid[])`, [state.accounts]);
  }
  await db.query(`DELETE FROM users WHERE id = $1`, [state.userId]);
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

describe("migration 038", () => {
  it("widens the journal level check to the auto-start levels and is safe to re-run", async () => {
    const db = await getDb();
    const sql = readFileSync("src/db/migrations/038_campaign_autostart.sql", "utf8");
    await db.exec(sql);
    await db.exec(sql); // a second application is a no-op, not a second constraint
    const rows = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'campaign_run_journal'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%item_skipped%'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].def).toContain("auto_started");
    expect(rows.rows[0].def).toContain("auto_start_held");
    // The values the old check accepted are still accepted.
    for (const level of ["item_skipped", "system_failure", "paused", "resumed", "completed"]) {
      expect(rows.rows[0].def).toContain(level);
    }
  });
});

describe("scheduled campaigns start themselves", () => {
  it("starts a campaign whose scheduled time has passed, and writes the audit row and a journal entry", async () => {
    const db = await getDb();
    const accountId = await newMailbox();
    const id = await scheduledCampaign(accountId, new Date(Date.now() - 5 * 60_000).toISOString());

    expect((await campaignRow(id)).status).toBe("approved");

    const result = await autoStartDueCampaigns();
    expect(result.started).toContain(id);
    expect((await campaignRow(id)).status).toBe("active");

    const journal = await listCampaignJournal(id);
    expect(journal.filter((entry) => entry.level === "auto_started")).toHaveLength(1);

    const audit = await db.query<any>(
      `SELECT actor_type, actor_id, metadata FROM audit_log
        WHERE action = 'campaign.auto_started' AND entity_id = $1`,
      [id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_type).toBe("founder");
    // The founder who created it WITH a schedule is the authoriser of the start — not the scheduler.
    expect(audit.rows[0].actor_id).toBe(state.userId);
  });

  it("is idempotent: a second runner pass does not double-start it", async () => {
    const db = await getDb();
    const accountId = await newMailbox();
    const id = await scheduledCampaign(accountId, new Date(Date.now() - 60_000).toISOString());

    const first = await autoStartDueCampaigns();
    expect(first.started).toContain(id);

    const second = await autoStartDueCampaigns();
    const third = await autoStartDueCampaigns();
    expect(second.started).not.toContain(id);
    expect(third.started).not.toContain(id);

    const journal = await listCampaignJournal(id);
    expect(journal.filter((entry) => entry.level === "auto_started")).toHaveLength(1);
    const audit = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'campaign.auto_started' AND entity_id = $1`,
      [id],
    );
    expect(audit.rows[0].n).toBe("1");
  });

  it("starts a schedule the process missed while it was down, on the next pass", async () => {
    const accountId = await newMailbox();
    // Two hours late: the time passed while nothing was running, but it is still today's batch.
    const id = await scheduledCampaign(accountId, new Date(Date.now() - 2 * 3_600_000).toISOString());
    const result = await autoStartDueCampaigns();
    expect(result.started).toContain(id);
    expect((await campaignRow(id)).status).toBe("active");
  });

  it("does not start a schedule still in the future", async () => {
    const accountId = await newMailbox();
    const id = await scheduledCampaign(accountId, new Date(Date.now() + 60 * 60_000).toISOString());
    const result = await autoStartDueCampaigns();
    expect(result.started).not.toContain(id);
    expect((await campaignRow(id)).status).toBe("approved");
  });

  it("refuses to mass-start a schedule missed by more than 24 hours, records it once, and needs the founder's start", async () => {
    const db = await getDb();
    const accountId = await newMailbox();
    const id = await scheduledCampaign(
      accountId,
      new Date(Date.now() - (CAMPAIGN_AUTOSTART_LATE_MS + 60_000)).toISOString(),
    );

    const first = await autoStartDueCampaigns();
    expect(first.heldOverdue).toContain(id);
    expect(first.started).not.toContain(id);
    expect((await campaignRow(id)).status).toBe("approved");

    const journal = await listCampaignJournal(id);
    expect(journal.filter((entry) => entry.level === "auto_start_held")).toHaveLength(1);
    // It is not a failure of the campaign, and no success is claimed: no auto_started entry exists.
    expect(journal.some((entry) => entry.level === "auto_started")).toBe(false);

    // A later pass records nothing more — the refusal is written once.
    await autoStartDueCampaigns();
    expect(
      (await listCampaignJournal(id)).filter((entry) => entry.level === "auto_start_held"),
    ).toHaveLength(1);

    // The founder's own Start still works, which is exactly what the refusal asks for.
    await startCampaign(id, state.userId);
    expect((await campaignRow(id)).status).toBe("active");
  });

  it("still starts a schedule missed by just under 24 hours, so the boundary is real", async () => {
    const accountId = await newMailbox();
    const id = await scheduledCampaign(
      accountId,
      new Date(Date.now() - (CAMPAIGN_AUTOSTART_LATE_MS - 60_000)).toISOString(),
    );
    const result = await autoStartDueCampaigns();
    expect(result.started).toContain(id);
  });

  it("never auto-starts a campaign with no schedule — a manual Start still applies", async () => {
    const accountId = await newMailbox();
    const draftId = await makeApprovedDraft(accountId, "Manual Lead", `manual-${crypto.randomUUID().slice(0, 6)}.example`);
    const { id } = await createCampaign({
      name: "Manual only",
      draftIds: [draftId],
      accountId,
      userId: state.userId,
      authorize: true,
      perMinuteCap: null,
    });
    state.campaigns.push(id);

    const result = await autoStartDueCampaigns();
    expect(result.started).not.toContain(id);
    expect((await campaignRow(id)).status).toBe("approved");

    await startCampaign(id, state.userId);
    expect((await campaignRow(id)).status).toBe("active");
  });

  it("never auto-starts a campaign whose status is not the pre-start approved state", async () => {
    const accountId = await newMailbox();
    const past = new Date(Date.now() - 60_000).toISOString();

    // active: already started by hand
    const active = await scheduledCampaign(accountId, past);
    await startCampaign(active, state.userId);

    // paused
    const paused = await scheduledCampaign(accountId, past);
    await startCampaign(paused, state.userId);
    await setCampaignStatus(paused, "paused");

    // cancelled
    const cancelled = await scheduledCampaign(accountId, past);
    await setCampaignStatus(cancelled, "cancelled");

    const result = await autoStartDueCampaigns();
    for (const id of [active, paused, cancelled]) {
      expect(result.started).not.toContain(id);
      expect(result.heldOverdue).not.toContain(id);
    }
    expect((await campaignRow(active)).status).toBe("active");
    expect((await campaignRow(paused)).status).toBe("paused");
    expect((await campaignRow(cancelled)).status).toBe("cancelled");
  });

  it("stores a Karachi start as its UTC instant and compares it in UTC", async () => {
    const db = await getDb();
    const accountId = await newMailbox();
    // The founder typed 14:00 on 23 Nov 2026, thinking in Asia/Karachi (UTC+5) — the UI converts it
    // before it is sent, and this is what must land in the database.
    const utc = zonedWallClockToUtc("2026-11-23T14:00", "Asia/Karachi");
    expect(utc.toISOString()).toBe("2026-11-23T09:00:00.000Z");
    expect(wallClockInZone(utc, "Asia/Karachi")).toBe("2026-11-23T14:00");

    const id = await scheduledCampaign(accountId, utc.toISOString());
    const stored = await campaignRow(id);
    expect(new Date(stored.scheduled_at).toISOString()).toBe("2026-11-23T09:00:00.000Z");

    // It is in the future, so it is not started — the comparison is on the same UTC instant.
    const result = await autoStartDueCampaigns();
    expect(result.started).not.toContain(id);
    expect((await campaignRow(id)).status).toBe("approved");
    void db;
  });
});

describe("runDueCampaigns drives auto-start and the run in one tick", () => {
  it("starts a scheduled campaign and sends its queued items in the same pass", async () => {
    const db = await getDb();
    const accountId = await newMailbox();
    const id = await scheduledCampaign(accountId, new Date(Date.now() - 60_000).toISOString(), null);

    const run = await runDueCampaigns({ maxCampaigns: 20 });
    expect(run.autoStarted).toContain(id);
    const entry = run.results.find((row) => row.campaignId === id);
    expect(entry).toBeDefined();
    expect(entry?.sent).toBe(1);
    expect((await campaignRow(id)).status).toBe("completed");

    const sent = await db.query(
      `SELECT 1 FROM outbound_sends WHERE campaign_id = $1 AND status IN ('accepted', 'sandbox')`,
      [id],
    );
    expect(sent.rows.length).toBeGreaterThan(0);
  });

  it("leaves a manual (unscheduled) campaign approved when the runner passes", async () => {
    const accountId = await newMailbox();
    const draftId = await makeApprovedDraft(accountId, "Idle Lead", `idle-${crypto.randomUUID().slice(0, 6)}.example`);
    const { id } = await createCampaign({
      name: "Idle manual",
      draftIds: [draftId],
      accountId,
      userId: state.userId,
      authorize: true,
      perMinuteCap: null,
    });
    state.campaigns.push(id);

    const run = await runDueCampaigns();
    expect(run.autoStarted).not.toContain(id);
    expect(run.results.some((row) => row.campaignId === id)).toBe(false);
    expect((await campaignRow(id)).status).toBe("approved");
  });
});
