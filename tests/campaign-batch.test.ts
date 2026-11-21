import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Deliver = (...args: unknown[]) => Promise<unknown>;
const transport = vi.hoisted(() => ({ deliver: vi.fn<Deliver>() }));

vi.mock("@/lib/email/send-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send-provider")>();
  // the real transport by default; a single call is replaced where a test needs a system failure
  transport.deliver.mockImplementation(actual.deliverEmail as unknown as Deliver);
  return { ...actual, deliverEmail: (...args: unknown[]) => transport.deliver(...args) };
});

import { closeDb, getDb } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { ensureWorkspaceDefaults, updateWorkspaceSettings } from "@/lib/services/settings";
import { createEmailAccount } from "@/lib/email/accounts";
import { EmailDeliveryError } from "@/lib/email/send-provider";
import { saveProspect } from "@/lib/services/prospects";
import { approveDraft, generateDraftForProspect } from "@/lib/services/drafts";
import {
  createCampaign,
  createBatchCampaign,
  previewCampaignBatch,
  updateCampaignPacing,
  processNextCampaignItem,
  runCampaign,
  startCampaign,
  setCampaignStatus,
  listCampaignJournal,
  campaignProgress,
  CAMPAIGN_FAILURE_CIRCUIT_BREAKER,
} from "@/lib/services/campaigns";
import type { Category } from "@/lib/types";
import { assessmentFor } from "./helpers/lead-assessment";

/**
 * The founder-authorised batch campaign builder: migration 037, the all-or-nothing batch, the run
 * journal, server-side pacing, the per-item-vs-system failure split and the circuit breaker.
 *
 * Each test owns a mailbox of its own, and its drafts are pinned to it, so a `sender` filter selects
 * exactly that test's drafts and nothing else in the shared database.
 */

const state = {
  userId: "",
  migrationAccountId: "",
  campaigns: [] as string[],
  drafts: [] as string[],
  prospects: [] as string[],
  accounts: [] as string[],
  suppressions: [] as string[],
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

async function newMailbox(
  options: { minIntervalSeconds?: number; dailySendLimit?: number } = {},
): Promise<string> {
  const account = await createEmailAccount(
    {
      name: `Batch Mailbox ${state.accounts.length + 1}`,
      provider: "sandbox",
      emailAddress: `batch-${state.accounts.length + 1}-${crypto.randomUUID().slice(0, 8)}@campaign-batch.test`,
      fromName: "Batch Test",
      dailySendLimit: options.dailySendLimit ?? 200,
      minIntervalSeconds: options.minIntervalSeconds ?? 5,
      isDefault: false,
    },
    state.userId,
  );
  state.accounts.push(account.id);
  return account.id;
}

/**
 * A real prospect and its real first-contact draft, pinned to the test's mailbox and with the
 * subject/body set for the fixture.
 */
async function makeDraft(
  accountId: string,
  name: string,
  domain: string,
  email: string,
  options: { subject?: string; body?: string; status?: "draft" | "approved" } = {},
): Promise<{ prospectId: string; draftId: string }> {
  const saved = await saveProspect({
    ...payload(name, domain, email),
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
  const db = await getDb();
  const subject = options.subject ?? `A quick question about ${name}`;
  const body =
    options.body ??
    `Hi ${name},\n\nI noticed your Telegram signal channel and had one idea worth a short call.\n\nBest,`;
  await db.query(`UPDATE drafts SET subject = $2, body = $3, status = $4 WHERE id = $1`, [
    draft.id,
    subject,
    body,
    options.status ?? "draft",
  ]);
  await db.query(`UPDATE prospects SET sending_profile_id = $2 WHERE id = $1`, [
    saved.prospect.id,
    accountId,
  ]);
  return { prospectId: saved.prospect.id, draftId: draft.id };
}

async function suppressEmail(email: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO suppressions (id, normalized_email, email, reason, source)
     VALUES (gen_random_uuid(), $1, $1, 'opt_out', 'founder')
     ON CONFLICT (normalized_email) DO UPDATE SET active = true`,
    [email],
  );
  state.suppressions.push(email);
}

async function campaignRow(id: string) {
  const db = await getDb();
  const result = await db.query<any>(`SELECT * FROM campaigns WHERE id = $1`, [id]);
  return result.rows[0];
}

const MIGRATION = readFileSync("src/db/migrations/037_campaign_batch_pacing.sql", "utf8");
const STATEMENTS = MIGRATION.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

async function runMigration() {
  const db = await getDb();
  for (const statement of STATEMENTS) await db.query(statement);
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  const db = await getDb();
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
     VALUES (gen_random_uuid(), 'campaign-batch@local.test', 'campaign-batch@local.test', 'Batch Founder', $1, 'founder')
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
  state.migrationAccountId = await newMailbox();
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
    await db.query(
      `DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE prospect_id = ANY($1::uuid[]))`,
      [state.prospects],
    );
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
  if (state.suppressions.length) {
    await db.query(`DELETE FROM suppressions WHERE normalized_email = ANY($1::text[])`, [state.suppressions]);
  }
  if (state.accounts.length) {
    await db.query(`DELETE FROM email_accounts WHERE id = ANY($1::uuid[])`, [state.accounts]);
  }
  await db.query(`DELETE FROM users WHERE id = $1`, [state.userId]);
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

describe("migration 037", () => {
  it("adds the campaign pacing columns and the run journal, and is safe to re-run", async () => {
    await runMigration();
    await runMigration();
    const db = await getDb();
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'campaigns'
          AND column_name IN ('scheduled_at', 'per_minute_cap', 'batch_size', 'filter_spec', 'consecutive_failures', 'last_error')`,
    );
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual(
      ["batch_size", "consecutive_failures", "filter_spec", "last_error", "per_minute_cap", "scheduled_at"].sort(),
    );
    const journal = await db.query<{ t: string | null }>(
      `SELECT to_regclass('public.campaign_run_journal')::text AS t`,
    );
    expect(journal.rows[0].t).toBe("campaign_run_journal");
    const indexes = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_indexes
        WHERE indexname IN ('outbound_sends_campaign_completed_idx', 'campaigns_due_idx', 'campaign_run_journal_campaign_idx')`,
    );
    expect(indexes.rows[0].count).toBe("3");
  });

  it("enforces the 1..6 ceiling at the database and allows NULL as the sanctioned none", async () => {
    const db = await getDb();
    const base = `INSERT INTO campaigns
        (id, name, status, account_id, daily_send_limit_snapshot, min_interval_snapshot, per_minute_cap)
       VALUES (gen_random_uuid(), 'Migration Pacing', 'approved', $1, 10, 5, $2)`;
    await expect(db.query(base, [state.migrationAccountId, 0])).rejects.toBeTruthy();
    await expect(db.query(base, [state.migrationAccountId, 7])).rejects.toBeTruthy();
    const okNull = await db.query<{ id: string }>(`${base} RETURNING id`, [state.migrationAccountId, null]);
    const okThree = await db.query<{ id: string }>(`${base} RETURNING id`, [state.migrationAccountId, 3]);
    await db.query(`DELETE FROM campaigns WHERE id = ANY($1::uuid[])`, [
      [okNull.rows[0].id, okThree.rows[0].id],
    ]);
  });
});

describe("batch creation", () => {
  it("previews a batch and creates it as one audited approval, selecting exactly the previewed drafts", async () => {
    const db = await getDb();
    const accountId = await newMailbox();
    const a = await makeDraft(accountId, "Cb Approve One", "cb-approve-one.example", "hello@cb-approve-one.example");
    const b = await makeDraft(accountId, "Cb Approve Two", "cb-approve-two.example", "hello@cb-approve-two.example");

    const preview = await previewCampaignBatch({ filters: { sender: accountId }, limit: 10 });
    expect(preview.matches).toBe(2);
    expect(preview.selected).toBe(2);
    expect(preview.ready).toBe(true);
    expect(preview.failing).toEqual([]);

    const { id } = await createBatchCampaign({
      name: "Batch approve 1",
      accountId,
      userId: state.userId,
      authorize: true,
      approveBatch: true,
      filters: { sender: accountId },
      limit: 10,
      perMinuteCap: 6,
    });
    state.campaigns.push(id);

    const items = await db.query<{ draft_id: string }>(
      `SELECT draft_id FROM campaign_items WHERE campaign_id = $1 ORDER BY position ASC`,
      [id],
    );
    expect(items.rows.map((row) => row.draft_id)).toEqual(preview.draftIds);
    expect([...preview.draftIds].sort()).toEqual([a.draftId, b.draftId].sort());

    const statuses = await db.query<{ status: string }>(
      `SELECT status FROM drafts WHERE id = ANY($1::uuid[])`,
      [[a.draftId, b.draftId]],
    );
    expect(statuses.rows.every((row) => row.status === "approved")).toBe(true);

    const campaign = await campaignRow(id);
    expect(Number(campaign.batch_size)).toBe(2);
    expect(Number(campaign.per_minute_cap)).toBe(6);
    expect(campaign.scheduled_at).toBeNull();
    expect(campaign.filter_spec.sender).toBe(accountId);
    expect(Number(campaign.filter_spec.limit)).toBe(10);

    const audit = await db.query<any>(
      `SELECT metadata FROM audit_log WHERE action = 'campaign.batch_approved' AND entity_id = $1`,
      [id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata.count).toBe(2);
    expect(audit.rows[0].metadata.filters.sender).toBe(accountId);
    expect(new Set(audit.rows[0].metadata.draftIds)).toEqual(new Set([a.draftId, b.draftId]));
  });

  it("refuses the whole batch, names every failing draft and creates nothing", async () => {
    const db = await getDb();
    const accountId = await newMailbox();
    const good = await makeDraft(accountId, "Cb Refuse Good", "cb-refuse-good.example", "hello@cb-refuse-good.example");
    const bad = await makeDraft(accountId, "Cb Refuse Bad", "cb-refuse-bad.example", "hello@cb-refuse-bad.example", {
      subject: "",
    });

    const preview = await previewCampaignBatch({ filters: { sender: accountId }, limit: 10 });
    expect(preview.ready).toBe(false);
    expect(preview.failing.map((refusal) => refusal.draftId)).toContain(bad.draftId);

    let error: { code?: string; message?: string } | undefined;
    try {
      await createBatchCampaign({
        name: "Batch refuse 1",
        accountId,
        userId: state.userId,
        authorize: true,
        approveBatch: true,
        filters: { sender: accountId },
        limit: 10,
      });
    } catch (caught) {
      error = caught as { code?: string; message?: string };
    }
    expect(error?.code).toBe("batch_check_failed");
    expect(error?.message).toContain(bad.draftId);
    expect(error?.message).toContain("empty_subject");

    const statuses = await db.query<{ status: string }>(
      `SELECT status FROM drafts WHERE id = ANY($1::uuid[])`,
      [[good.draftId, bad.draftId]],
    );
    expect(statuses.rows.every((row) => row.status === "draft")).toBe(true);
    const campaigns = await db.query(`SELECT 1 FROM campaigns WHERE name = 'Batch refuse 1'`);
    expect(campaigns.rows).toHaveLength(0);
  });
});

describe("server-side pacing", () => {
  it("stops at the per-minute cap and resumes once the window passes", async () => {
    const db = await getDb();
    const accountId = await newMailbox();
    const d1 = await makeDraft(accountId, "Cb Cap One", "cb-cap-one.example", "hello@cb-cap-one.example");
    const d2 = await makeDraft(accountId, "Cb Cap Two", "cb-cap-two.example", "hello@cb-cap-two.example");
    await approveDraft(d1.draftId, state.userId);
    await approveDraft(d2.draftId, state.userId);
    const { id } = await createCampaign({
      name: "Cap 1",
      draftIds: [d1.draftId, d2.draftId],
      accountId,
      userId: state.userId,
      authorize: true,
      perMinuteCap: 1,
    });
    state.campaigns.push(id);
    await startCampaign(id, state.userId);

    const first = await processNextCampaignItem(id, state.userId);
    expect(first.outcome).toBe("sent");

    const second = await processNextCampaignItem(id, state.userId);
    expect(second.outcome).toBe("held");
    expect(second.message ?? "").toMatch(/per-minute/i);
    expect((await campaignRow(id)).status).toBe("active");
    const queued = await db.query(`SELECT 1 FROM campaign_items WHERE campaign_id = $1 AND status = 'queued'`, [id]);
    expect(queued.rows).toHaveLength(1);

    // the window passes (and the account's own interval with it): the campaign resumes and finishes
    await db.query(`UPDATE outbound_sends SET completed_at = now() - interval '2 minutes' WHERE campaign_id = $1`, [id]);
    const third = await processNextCampaignItem(id, state.userId);
    expect(third.outcome).toBe("sent");
    expect((await campaignRow(id)).status).toBe("completed");
  });

  it("with no per-minute cap sends back to back once the account interval allows", async () => {
    const db = await getDb();
    const accountId = await newMailbox();
    const d1 = await makeDraft(accountId, "Cb NoCap One", "cb-nocap-one.example", "hello@cb-nocap-one.example");
    const d2 = await makeDraft(accountId, "Cb NoCap Two", "cb-nocap-two.example", "hello@cb-nocap-two.example");
    await approveDraft(d1.draftId, state.userId);
    await approveDraft(d2.draftId, state.userId);
    const { id } = await createCampaign({
      name: "NoCap 1",
      draftIds: [d1.draftId, d2.draftId],
      accountId,
      userId: state.userId,
      authorize: true,
      perMinuteCap: null,
    });
    state.campaigns.push(id);
    await startCampaign(id, state.userId);

    expect((await campaignRow(id)).per_minute_cap).toBeNull();

    const first = await processNextCampaignItem(id, state.userId);
    expect(first.outcome).toBe("sent");

    // the account's own minimum interval still holds the next one — that is not "no limit"
    const tooSoon = await processNextCampaignItem(id, state.userId);
    expect(tooSoon.outcome).toBe("held");

    // age the first send past the account interval but keep it inside 60s: a per-minute cap would still
    // block here, and with no cap set the next item goes.
    await db.query(
      `UPDATE outbound_sends SET completed_at = now() - interval '6 seconds'
        WHERE campaign_id = $1 AND status IN ('accepted', 'sandbox', 'uncertain')`,
      [id],
    );
    const second = await processNextCampaignItem(id, state.userId);
    expect(second.outcome).toBe("sent");
    expect((await campaignRow(id)).status).toBe("completed");
  });

  it("stops at the campaign's daily snapshot even with no per-minute cap", async () => {
    const accountId = await newMailbox({ dailySendLimit: 1 });
    const d1 = await makeDraft(accountId, "Cb Daily One", "cb-daily-one.example", "hello@cb-daily-one.example");
    const d2 = await makeDraft(accountId, "Cb Daily Two", "cb-daily-two.example", "hello@cb-daily-two.example");
    await approveDraft(d1.draftId, state.userId);
    await approveDraft(d2.draftId, state.userId);
    const { id } = await createCampaign({
      name: "Daily 1",
      draftIds: [d1.draftId, d2.draftId],
      accountId,
      userId: state.userId,
      authorize: true,
      perMinuteCap: null,
    });
    state.campaigns.push(id);
    await startCampaign(id, state.userId);

    const first = await processNextCampaignItem(id, state.userId);
    expect(first.outcome).toBe("sent");
    const second = await processNextCampaignItem(id, state.userId);
    expect(second.outcome).toBe("held");
    expect(second.message ?? "").toMatch(/snapshot|per workspace day/i);
    expect((await campaignRow(id)).status).toBe("active");
  });

  it("sends nothing before a future scheduled start", async () => {
    const db = await getDb();
    const accountId = await newMailbox();
    const d1 = await makeDraft(accountId, "Cb Sched One", "cb-sched-one.example", "hello@cb-sched-one.example");
    await approveDraft(d1.draftId, state.userId);
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    const { id } = await createCampaign({
      name: "Sched 1",
      draftIds: [d1.draftId],
      accountId,
      userId: state.userId,
      authorize: true,
      perMinuteCap: null,
      scheduledAt,
    });
    state.campaigns.push(id);
    await startCampaign(id, state.userId);

    const step = await processNextCampaignItem(id, state.userId);
    expect(step.outcome).toBe("held");
    expect(step.message ?? "").toMatch(/scheduled/i);
    expect((await db.query(`SELECT 1 FROM outbound_sends WHERE campaign_id = $1`, [id])).rows).toHaveLength(0);
    const queued = await db.query(`SELECT 1 FROM campaign_items WHERE campaign_id = $1 AND status = 'queued'`, [id]);
    expect(queued.rows).toHaveLength(1);

    const run = await runCampaign(id, state.userId);
    expect(run.status).toBe("held");
  });

  it("a paused or cancelled campaign sends nothing", async () => {
    const db = await getDb();
    const accountId = await newMailbox();
    const d1 = await makeDraft(accountId, "Cb Stop One", "cb-stop-one.example", "hello@cb-stop-one.example");
    await approveDraft(d1.draftId, state.userId);
    const { id } = await createCampaign({
      name: "Stop 1",
      draftIds: [d1.draftId],
      accountId,
      userId: state.userId,
      authorize: true,
      perMinuteCap: null,
    });
    state.campaigns.push(id);
    await startCampaign(id, state.userId);

    await setCampaignStatus(id, "paused");
    await expect(processNextCampaignItem(id, state.userId)).rejects.toThrow(/not active/i);
    expect((await db.query(`SELECT 1 FROM outbound_sends WHERE campaign_id = $1`, [id])).rows).toHaveLength(0);

    await setCampaignStatus(id, "cancelled");
    await expect(processNextCampaignItem(id, state.userId)).rejects.toThrow(/not active/i);
    expect((await db.query(`SELECT 1 FROM outbound_sends WHERE campaign_id = $1`, [id])).rows).toHaveLength(0);
  });
});

describe("the runner: per-item vs system failures", () => {
  it("skips a failing item, attempts the next, and completes with counts and a named skip", async () => {
    const db = await getDb();
    const accountId = await newMailbox();
    const bad = await makeDraft(accountId, "Cb Run Bad", "cb-run-bad.example", "hello@cb-run-bad.example");
    const good = await makeDraft(accountId, "Cb Run Good", "cb-run-good.example", "hello@cb-run-good.example");
    await approveDraft(bad.draftId, state.userId);
    await approveDraft(good.draftId, state.userId);
    await suppressEmail("hello@cb-run-bad.example");

    const { id } = await createCampaign({
      name: "Run skip 1",
      draftIds: [bad.draftId, good.draftId],
      accountId,
      userId: state.userId,
      authorize: true,
      perMinuteCap: null,
    });
    state.campaigns.push(id);
    await startCampaign(id, state.userId);

    const run = await runCampaign(id, state.userId);
    expect(run.status).toBe("completed");
    expect(run.sent).toBe(1);
    expect(run.skipped).toBe(1);

    const skippedItem = await db.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM campaign_items WHERE campaign_id = $1 AND draft_id = $2`,
      [id, bad.draftId],
    );
    expect(skippedItem.rows[0].status).toBe("skipped");
    expect(skippedItem.rows[0].error ?? "").toMatch(/opt-out|suppress/i);

    const journal = await listCampaignJournal(id);
    const skipped = journal.find((entry) => entry.level === "item_skipped");
    expect(skipped).toBeDefined();
    expect(skipped?.reason ?? "").toMatch(/opt-out|suppress/i);
    expect(journal.some((entry) => entry.level === "completed")).toBe(true);

    const progress = await campaignProgress(id);
    expect(progress.sent).toBe(1);
    expect(progress.skipped).toBe(1);
    expect(progress.queued).toBe(0);
  });

  it("pauses after the circuit breaker trips on consecutive failures", async () => {
    const accountId = await newMailbox();
    const drafts = [];
    for (const n of [1, 2, 3]) {
      drafts.push(
        await makeDraft(accountId, `Cb Breaker ${n}`, `cb-breaker-${n}.example`, `hello@cb-breaker-${n}.example`),
      );
      await suppressEmail(`hello@cb-breaker-${n}.example`);
    }
    for (const draft of drafts) await approveDraft(draft.draftId, state.userId);

    const { id } = await createCampaign({
      name: "Breaker 1",
      draftIds: drafts.map((draft) => draft.draftId),
      accountId,
      userId: state.userId,
      authorize: true,
      perMinuteCap: null,
    });
    state.campaigns.push(id);
    await startCampaign(id, state.userId);

    const run = await runCampaign(id, state.userId);
    expect(run.status).toBe("paused");
    expect(CAMPAIGN_FAILURE_CIRCUIT_BREAKER).toBe(3);

    const campaign = await campaignRow(id);
    expect(campaign.status).toBe("paused");
    expect(campaign.last_error ?? "").toMatch(/in a row/i);

    const journal = await listCampaignJournal(id);
    expect(journal.some((entry) => entry.level === "paused")).toBe(true);
    expect((await campaignProgress(id)).skipped).toBe(3);
  });

  it("pauses immediately on an authentication failure", async () => {
    const db = await getDb();
    const accountId = await newMailbox();
    const draft = await makeDraft(accountId, "Cb Auth One", "cb-auth-one.example", "hello@cb-auth-one.example");
    await approveDraft(draft.draftId, state.userId);
    const { id } = await createCampaign({
      name: "Auth 1",
      draftIds: [draft.draftId],
      accountId,
      userId: state.userId,
      authorize: true,
      perMinuteCap: null,
    });
    state.campaigns.push(id);
    await startCampaign(id, state.userId);

    transport.deliver.mockImplementationOnce(async () => {
      throw new EmailDeliveryError(
        "SMTP authentication failed. Check the IONOS mailbox address and password in Settings.",
        true,
        "EAUTH",
      );
    });

    const run = await runCampaign(id, state.userId);
    expect(run.status).toBe("paused");
    const campaign = await campaignRow(id);
    expect(campaign.status).toBe("paused");
    expect(campaign.last_error ?? "").toMatch(/authentication/i);

    const sent = await db.query(
      `SELECT 1 FROM outbound_sends WHERE campaign_id = $1 AND status IN ('accepted', 'sandbox')`,
      [id],
    );
    expect(sent.rows).toHaveLength(0);
    const journal = await listCampaignJournal(id);
    expect(journal.some((entry) => entry.level === "system_failure")).toBe(true);
  });

  it("resumes a paused campaign from the next queued item", async () => {
    const db = await getDb();
    const accountId = await newMailbox();
    const drafts = [];
    for (const n of [1, 2, 3]) {
      drafts.push(
        await makeDraft(accountId, `Cb Resume ${n}`, `cb-resume-${n}.example`, `hello@cb-resume-${n}.example`),
      );
      await suppressEmail(`hello@cb-resume-${n}.example`);
    }
    const tail = await makeDraft(accountId, "Cb Resume Four", "cb-resume-four.example", "hello@cb-resume-four.example");
    for (const draft of [...drafts, tail]) await approveDraft(draft.draftId, state.userId);

    const { id } = await createCampaign({
      name: "Resume 1",
      draftIds: [...drafts, tail].map((draft) => draft.draftId),
      accountId,
      userId: state.userId,
      authorize: true,
      perMinuteCap: null,
    });
    state.campaigns.push(id);
    await startCampaign(id, state.userId);

    const paused = await runCampaign(id, state.userId);
    expect(paused.status).toBe("paused");
    const queued = await db.query(`SELECT 1 FROM campaign_items WHERE campaign_id = $1 AND status = 'queued'`, [id]);
    expect(queued.rows).toHaveLength(1);

    await setCampaignStatus(id, "active");
    const run = await runCampaign(id, state.userId);
    expect(run.status).toBe("completed");
    expect(run.sent).toBe(1);
    expect((await listCampaignJournal(id)).some((entry) => entry.level === "resumed")).toBe(true);
  });
});

describe("editing pacing while a campaign runs", () => {
  it("changes the per-minute cap immediately and audits old and new, refusing out-of-range values", async () => {
    const db = await getDb();
    const accountId = await newMailbox();
    const d1 = await makeDraft(accountId, "Cb Edit One", "cb-edit-one.example", "hello@cb-edit-one.example");
    const d2 = await makeDraft(accountId, "Cb Edit Two", "cb-edit-two.example", "hello@cb-edit-two.example");
    await approveDraft(d1.draftId, state.userId);
    await approveDraft(d2.draftId, state.userId);
    const { id } = await createCampaign({
      name: "Edit 1",
      draftIds: [d1.draftId, d2.draftId],
      accountId,
      userId: state.userId,
      authorize: true,
      perMinuteCap: 6,
    });
    state.campaigns.push(id);
    await startCampaign(id, state.userId);

    const first = await processNextCampaignItem(id, state.userId);
    expect(first.outcome).toBe("sent");

    const updated = await updateCampaignPacing(id, { perMinuteCap: 1 }, state.userId);
    expect(updated.perMinuteCap).toBe(1);

    const second = await processNextCampaignItem(id, state.userId);
    expect(second.outcome).toBe("held");
    expect(second.message ?? "").toMatch(/per-minute/i);

    const audit = await db.query<any>(
      `SELECT metadata FROM audit_log WHERE action = 'campaign.pacing_updated' AND entity_id = $1`,
      [id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata.perMinuteCap).toEqual({ from: 6, to: 1 });

    await expect(updateCampaignPacing(id, { perMinuteCap: 0 }, state.userId)).rejects.toMatchObject({
      code: "per_minute_cap_out_of_range",
    });
    await expect(updateCampaignPacing(id, { perMinuteCap: 7 }, state.userId)).rejects.toMatchObject({
      code: "per_minute_cap_out_of_range",
    });
    expect(Number((await campaignRow(id)).per_minute_cap)).toBe(1);
    const auditsStill = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log WHERE action = 'campaign.pacing_updated' AND entity_id = $1`,
      [id],
    );
    expect(auditsStill.rows[0].count).toBe("1");

    // setting it to "none" opens pacing again for the next send
    const cleared = await updateCampaignPacing(id, { perMinuteCap: null }, state.userId);
    expect(cleared.perMinuteCap).toBeNull();
    await db.query(
      `UPDATE outbound_sends SET completed_at = now() - interval '6 seconds'
        WHERE campaign_id = $1 AND status IN ('accepted', 'sandbox', 'uncertain')`,
      [id],
    );
    const third = await processNextCampaignItem(id, state.userId);
    expect(third.outcome).toBe("sent");
    const clearedAudit = await db.query<any>(
      `SELECT metadata FROM audit_log WHERE action = 'campaign.pacing_updated' AND entity_id = $1 ORDER BY created_at ASC`,
      [id],
    );
    expect(clearedAudit.rows).toHaveLength(2);
    expect(clearedAudit.rows[1].metadata.perMinuteCap).toEqual({ from: 1, to: null });

    // the schedule is editable the same way, with the same audit
    const future = new Date(Date.now() + 7_200_000).toISOString();
    const scheduled = await updateCampaignPacing(id, { scheduledAt: future }, state.userId);
    expect(scheduled.scheduledAt).toBe(future);
    const scheduleAudit = await db.query<any>(
      `SELECT metadata FROM audit_log WHERE action = 'campaign.pacing_updated' AND entity_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    expect(scheduleAudit.rows[0].metadata.scheduledAt.to).toBe(future);
  });
});
