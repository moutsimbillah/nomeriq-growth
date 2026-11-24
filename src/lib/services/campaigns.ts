import { getDb, type DbClient } from "@/lib/db/client";
import { AppError, iso } from "@/lib/utils";
import type { CampaignSummary, Draft } from "@/lib/types";
import { addedWindow } from "@/lib/dates/timezone";
import {
  getEmailAccountRecord,
  type EmailAccountRecord,
} from "@/lib/email/accounts";
import {
  checkDraftMechanics,
  complianceFooterPreview,
  type DraftCheckRefusal,
} from "@/lib/email/draft-check";
import {
  getDraft,
  listBatchCandidates,
  countBatchCandidates,
  type DraftFilters,
} from "./drafts";
import { sendDraft, getSendUsage } from "./email-sending";
import { getWorkspaceSettings } from "./settings";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The number of sends a campaign may make in one rolling minute by default. The founder may set it to
 * 1..6, or to "none" (NULL) for back-to-back sending; 0 and 7+ are refused, never clamped.
 * See `normalizePerMinuteCap` and migration 037.
 */
export const DEFAULT_PER_MINUTE_CAP = 3;
export const MAX_PER_MINUTE_CAP = 6;
/** The rolling window the per-minute cap is measured over, in seconds. */
export const PER_MINUTE_WINDOW_SECONDS = 60;
/** The largest batch one action may create or preview. Mirrors the drafts list ceiling. */
export const MAX_CAMPAIGN_BATCH = 200;
/**
 * How many consecutive INDETERMINATE item failures pause a campaign as systemic. Only failures whose
 * cause is NOT the recipient — a transient/provider error, an unknown error — are counted; a
 * deterministic per-recipient skip (a suppression, an opt-out, an invalid address, a rejection hold)
 * never is, so a run of those skips past and the campaign carries on. Any resolved item — a send, or a
 * deterministic skip — resets the counter. See `isDeterministicSkip` and `isSystemFailure`.
 */
export const CAMPAIGN_FAILURE_CIRCUIT_BREAKER = 3;
/**
 * How late a scheduled start may be and still be auto-started. If the process was down when the time
 * passed, the campaign starts on the next runner pass — but if that next pass is more than this far
 * past the schedule, the batch is stale: it is recorded for the founder and left for a manual start,
 * never mass-started silently. See `autoStartDueCampaigns`.
 */
export const CAMPAIGN_AUTOSTART_LATE_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ pacing inputs */

/** `undefined` keeps the caller's default; `null` means "no per-minute limit". */
function normalizePerMinuteCap(
  value: number | null | undefined,
  fallback: number | null,
): number | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_PER_MINUTE_CAP
  ) {
    return value;
  }
  throw new AppError(
    "The per-minute cap must be empty (no per-minute limit, send back to back) or a whole number from 1 to 6.",
    400,
    "per_minute_cap_out_of_range",
  );
}

function normalizeScheduledAt(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("The scheduled start must be a real date and time.", 400, "invalid_schedule");
  }
  return parsed.toISOString();
}

function normalizeBatchLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) {
    throw new AppError(
      "Choose how many drafts the batch includes (a whole number of 1 or more).",
      400,
      "invalid_batch_limit",
    );
  }
  // A window ceiling, not a silent per-minute clamp: the founder asks for a size, capped by the list.
  return Math.min(Math.floor(limit), MAX_CAMPAIGN_BATCH);
}

/* ------------------------------------------------------------------ creation */

async function insertCampaignRows(
  tx: DbClient,
  input: {
    id: string;
    name: string;
    accountId: string;
    userId: string;
    account: EmailAccountRecord;
    drafts: Draft[];
    scheduledAt: string | null;
    perMinuteCap: number | null;
    batchSize: number;
    filterSpec: unknown;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO campaigns
      (id, name, status, account_id, created_by, approved_by, approved_at,
       daily_send_limit_snapshot, min_interval_snapshot,
       scheduled_at, per_minute_cap, batch_size, filter_spec)
     VALUES ($1, $2, 'approved', $3, $4, $4, now(), $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      input.id,
      input.name,
      input.accountId,
      input.userId,
      input.account.dailySendLimit,
      input.account.minIntervalSeconds,
      input.scheduledAt,
      input.perMinuteCap,
      input.batchSize,
      JSON.stringify(input.filterSpec ?? {}),
    ],
  );
  let position = 0;
  for (const draft of input.drafts) {
    await tx.query(
      `INSERT INTO campaign_items
        (id, campaign_id, prospect_id, draft_id, position, status)
       VALUES ($1, $2, $3, $4, $5, 'queued')`,
      [crypto.randomUUID(), input.id, draft.prospectId, draft.id, position],
    );
    position += 1;
  }
}

export async function createCampaign(input: {
  name: string;
  draftIds: string[];
  accountId: string;
  userId: string;
  authorize: boolean;
  /** A start time, or null to start when the founder starts it. */
  scheduledAt?: string | null;
  /** 1..6, or null for no per-minute limit. Omitted uses the default (3). */
  perMinuteCap?: number | null;
  batchSize?: number;
  filterSpec?: unknown;
}): Promise<{ id: string }> {
  if (!input.name.trim()) throw new AppError("Give the campaign a name.");
  if (!input.draftIds.length) throw new AppError("Select at least one approved draft.");
  if (!input.authorize) {
    throw new AppError(
      "Explicit founder authorization is required before a campaign can be queued.",
      400,
      "authorization_required",
    );
  }
  const account = await getEmailAccountRecord(input.accountId);
  if (!account) throw new AppError("Email account not found.", 404);
  if (account.status !== "connected") {
    throw new AppError(
      "Connect a healthy email account before creating a campaign.",
      409,
    );
  }
  const uniqueDraftIds = [...new Set(input.draftIds)];
  const drafts: Draft[] = [];
  for (const draftId of uniqueDraftIds) {
    const draft = await getDraft(draftId);
    if (!draft) throw new AppError("One of the selected drafts no longer exists.");
    if (draft.kind !== "first_contact") {
      throw new AppError(
        "Campaigns send first-contact drafts. Follow-ups are reviewed individually.",
      );
    }
    if (draft.status !== "approved") {
      throw new AppError("Every campaign draft must be approved first.");
    }
    drafts.push(draft);
  }

  const id = crypto.randomUUID();
  const scheduledAt = normalizeScheduledAt(input.scheduledAt);
  const perMinuteCap = normalizePerMinuteCap(input.perMinuteCap, DEFAULT_PER_MINUTE_CAP);
  const db = await getDb();
  await db.transaction(async (tx) => {
    await insertCampaignRows(tx, {
      id,
      name: input.name.trim(),
      accountId: input.accountId,
      userId: input.userId,
      account,
      drafts,
      scheduledAt,
      perMinuteCap,
      batchSize: input.batchSize ?? drafts.length,
      filterSpec: input.filterSpec ?? {},
    });
    await tx.query(
      `INSERT INTO audit_log
        (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'founder', $2, 'campaign.created', 'campaign', $3, $4::jsonb)`,
      [
        crypto.randomUUID(),
        input.userId,
        id,
        JSON.stringify({ name: input.name, drafts: drafts.length }),
      ],
    );
  });
  return { id };
}

/* ------------------------------------------------------------------ batch creation */

export interface CampaignBatchFilters extends DraftFilters {}

export interface CampaignBatchInput {
  name: string;
  accountId: string;
  userId: string;
  /** Explicit founder authorization to queue a campaign. */
  authorize: boolean;
  /** The founder's own "approve this batch" action. Both flags must be present to create. */
  approveBatch: boolean;
  /**
   * The founder's own explicit alternative to the all-or-nothing refusal: approve and queue ONLY the
   * selected drafts that pass the mechanical check, leaving the failing ones unapproved and named in
   * the audit row. Absent (or false) keeps the refusal — nothing is ever excluded silently.
   */
  approvePassingOnly?: boolean;
  filters: CampaignBatchFilters;
  limit: number;
  scheduledAt?: string | null;
  perMinuteCap?: number | null;
}

export interface CampaignBatchPreview {
  /** First-contact drafts still awaiting the founder that match the filters, in total. */
  matches: number;
  /** How many of them this limit would select. */
  selected: number;
  /** The ids the creation would select, in order. */
  draftIds: string[];
  /** Every mechanical refusal for the selected drafts. */
  failing: DraftCheckRefusal[];
  /** A short list of the emails that will go, so the founder sees the batch before committing. */
  sample: Array<{ id: string; prospectName: string; subject: string }>;
  /** Each failing draft named by its prospect, with every reason joined — the founder's to-do list. */
  failingPreviews: Array<{ draftId: string; prospectName: string; subject: string; message: string }>;
  /** True only when there is something to send and every selected draft passed the mechanical check. */
  ready: boolean;
}

/** How many of the selected drafts the preview shows the founder. */
const PREVIEW_SAMPLE_SIZE = 8;

async function complianceFooter(): Promise<string> {
  return complianceFooterPreview(await getWorkspaceSettings());
}

function batchCheckMessage(refusals: DraftCheckRefusal[], total: number): string {
  const failingDrafts = [...new Set(refusals.map((refusal) => refusal.draftId))];
  const lines = refusals.map(
    (refusal) => `- ${refusal.draftId} — ${refusal.rule}: ${refusal.message}`,
  );
  return [
    `${failingDrafts.length} of ${total} selected drafts failed the mechanical check, so nothing was approved and no campaign was created (all-or-nothing):`,
    ...lines,
  ].join("\n");
}

/**
 * What the founder would get before committing: how many drafts match, which ids a given limit
 * selects, and every mechanical refusal. Read-only — nothing is approved, created or changed.
 */
export async function previewCampaignBatch(input: {
  filters: CampaignBatchFilters;
  limit: number;
}): Promise<CampaignBatchPreview> {
  const limit = normalizeBatchLimit(input.limit);
  const [matches, drafts, footer] = await Promise.all([
    countBatchCandidates(input.filters),
    listBatchCandidates(input.filters, limit),
    complianceFooter(),
  ]);
  const failing = drafts.flatMap((draft) =>
    checkDraftMechanics({
      id: draft.id,
      subject: draft.subject,
      body: draft.body,
      companyName: draft.prospectName,
      complianceFooter: footer,
    }),
  );
  const failingByDraft = new Map<string, DraftCheckRefusal[]>();
  for (const refusal of failing) {
    const list = failingByDraft.get(refusal.draftId) ?? [];
    list.push(refusal);
    failingByDraft.set(refusal.draftId, list);
  }
  return {
    matches,
    selected: drafts.length,
    draftIds: drafts.map((draft) => draft.id),
    failing,
    sample: drafts
      .slice(0, PREVIEW_SAMPLE_SIZE)
      .map((draft) => ({
        id: draft.id,
        prospectName: draft.prospectName ?? "Prospect",
        subject: draft.subject,
      })),
    failingPreviews: drafts
      .filter((draft) => failingByDraft.has(draft.id))
      .map((draft) => ({
        draftId: draft.id,
        prospectName: draft.prospectName ?? "Prospect",
        subject: draft.subject,
        message: (failingByDraft.get(draft.id) ?? []).map((refusal) => refusal.message).join(" "),
      })),
    ready: drafts.length > 0 && failing.length === 0,
  };
}

/**
 * The one-click batch: resolve the drafts a filter set selects, check every one mechanically, and —
 * only if ALL pass, on the founder's explicit approval — approve exactly those drafts as a single
 * audited batch and queue the campaign. All-or-nothing: one failing draft refuses the whole batch,
 * names every failure, approves nothing and creates nothing. There is no silent skipping.
 *
 * The single exception is the founder's OWN explicit alternative (`approvePassingOnly: true`, sent by
 * the one "Approve the N that pass instead" control): the batch is then re-formed to the drafts that
 * pass, the campaign's batch_size and filter_spec carry the reduced selection, the audit row records
 * the selected count and every excluded draft id, and the failing drafts stay unapproved. It still
 * refuses when nothing would be left.
 */
export interface CampaignBatchResult {
  id: string;
  /** Number of drafts selected when the request was processed, not when the UI preview ran. */
  selectedCount: number;
  /** Number actually approved and queued by this transaction. */
  approvedCount: number;
  /** Current selected drafts explicitly left out by the passing-only option. */
  excludedFailing: Array<{ draftId: string; prospectName: string; message: string }>;
}

export async function createBatchCampaign(
  input: CampaignBatchInput,
): Promise<CampaignBatchResult> {
  if (!input.name.trim()) throw new AppError("Give the campaign a name.");
  if (!input.authorize) {
    throw new AppError(
      "Explicit founder authorization is required before a campaign can be queued.",
      400,
      "authorization_required",
    );
  }
  if (!input.approveBatch) {
    throw new AppError(
      "Approving a batch is the founder's own action. Confirm to approve the selected drafts.",
      400,
      "batch_approval_required",
    );
  }
  const account = await getEmailAccountRecord(input.accountId);
  if (!account) throw new AppError("Email account not found.", 404);
  if (account.status !== "connected") {
    throw new AppError("Connect a healthy email account before creating a campaign.", 409);
  }

  const limit = normalizeBatchLimit(input.limit);
  const candidates = await listBatchCandidates(input.filters, limit);
  if (!candidates.length) {
    throw new AppError(
      "No prepared drafts match these filters. Nothing was approved and no campaign was created.",
      409,
      "no_matching_drafts",
    );
  }

  const footer = await complianceFooter();
  const refusals = candidates.flatMap((draft) =>
    checkDraftMechanics({
      id: draft.id,
      subject: draft.subject,
      body: draft.body,
      companyName: draft.prospectName,
      complianceFooter: footer,
    }),
  );
  const failingDraftIds = [...new Set(refusals.map((refusal) => refusal.draftId))];
  const failingSet = new Set(failingDraftIds);
  const excludedFailing = candidates
    .filter((draft) => failingSet.has(draft.id))
    .map((draft) => ({
      draftId: draft.id,
      prospectName: draft.prospectName ?? "Unknown prospect",
      message: refusals
        .filter((refusal) => refusal.draftId === draft.id)
        .map((refusal) => `${refusal.rule}: ${refusal.message}`)
        .join("; "),
    }));
  const passing = candidates.filter((draft) => !failingSet.has(draft.id));
  if (refusals.length && (!input.approvePassingOnly || !passing.length)) {
    // Unchanged: one failing draft refuses the whole batch and creates nothing, naming every failure.
    // The only way past it is the founder's own explicit alternative, and even that refuses when no
    // selected draft would pass.
    throw new AppError(batchCheckMessage(refusals, candidates.length), 409, "batch_check_failed");
  }
  // Only the explicit `approvePassingOnly` ever narrows the batch — never a silent drop.
  const drafts = refusals.length ? passing : candidates;

  const scheduledAt = normalizeScheduledAt(input.scheduledAt);
  const perMinuteCap = normalizePerMinuteCap(input.perMinuteCap, DEFAULT_PER_MINUTE_CAP);
  // The batch record itself carries the reduced selection, so the exclusion is readable on the row.
  const filterSpec = refusals.length
    ? { ...input.filters, limit, excludedFailingDraftIds: failingDraftIds }
    : { ...input.filters, limit };
  const draftIds = drafts.map((draft) => draft.id);
  const id = crypto.randomUUID();

  const db = await getDb();
  await db.transaction(async (tx) => {
    // Approve exactly the selected drafts — the same status a one-by-one approval sets. A draft the
    // check refused is never in this list, so it stays unapproved.
    await tx.query(
      `UPDATE drafts SET status = 'approved', approved_at = now(), approved_by = $1, updated_at = now()
        WHERE id = ANY($2::uuid[]) AND status IN ('draft', 'approved')`,
      [input.userId, draftIds],
    );
    await insertCampaignRows(tx, {
      id,
      name: input.name.trim(),
      accountId: input.accountId,
      userId: input.userId,
      account,
      drafts,
      scheduledAt,
      perMinuteCap,
      batchSize: drafts.length,
      filterSpec,
    });
    // One audit row for the whole batch action: the filters, the count and every draft id — plus, when
    // the batch was reduced, how many were selected and every failing draft left out.
    await tx.query(
      `INSERT INTO audit_log
        (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'founder', $2, 'campaign.batch_approved', 'campaign', $3, $4::jsonb)`,
      [
        crypto.randomUUID(),
        input.userId,
        id,
        JSON.stringify({
          filters: input.filters,
          limit,
          count: drafts.length,
          draftIds,
          ...(refusals.length
            ? {
                selectedCount: candidates.length,
                approvePassingOnly: true,
                excludedFailing: { count: failingDraftIds.length, draftIds: failingDraftIds },
              }
            : {}),
        }),
      ],
    );
  });
  return {
    id,
    selectedCount: candidates.length,
    approvedCount: drafts.length,
    excludedFailing,
  };
}

/* ------------------------------------------------------------------ pacing edits */

/**
 * Change a campaign's per-minute cap and/or scheduled start after it was created, including while it
 * is running. An out-of-range cap (0, 7+, a fraction) is refused with a clear error — never clamped.
 * `null` is the sanctioned "no per-minute limit". Every change writes one audit row carrying the old
 * and the new value and the campaign id, and takes effect on the next send.
 */
export async function updateCampaignPacing(
  id: string,
  input: { perMinuteCap?: number | null; scheduledAt?: string | null },
  userId: string,
): Promise<{ perMinuteCap: number | null; scheduledAt: string | null }> {
  const db = await getDb();
  const existing = await db.query<any>(
    `SELECT id, per_minute_cap, scheduled_at FROM campaigns WHERE id = $1`,
    [id],
  );
  const row = existing.rows[0];
  if (!row) throw new AppError("Campaign not found.", 404);

  const fromCap =
    row.per_minute_cap === null || row.per_minute_cap === undefined
      ? null
      : Number(row.per_minute_cap);
  const fromScheduled: string | null = row.scheduled_at ? iso(row.scheduled_at) : null;
  const nextCap =
    input.perMinuteCap === undefined ? fromCap : normalizePerMinuteCap(input.perMinuteCap, null);
  const nextScheduled =
    input.scheduledAt === undefined ? fromScheduled : normalizeScheduledAt(input.scheduledAt);

  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE campaigns SET per_minute_cap = $1, scheduled_at = $2, updated_at = now() WHERE id = $3`,
      [nextCap, nextScheduled, id],
    );
    await tx.query(
      `INSERT INTO audit_log
        (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'founder', $2, 'campaign.pacing_updated', 'campaign', $3, $4::jsonb)`,
      [
        crypto.randomUUID(),
        userId,
        id,
        JSON.stringify({
          campaignId: id,
          perMinuteCap: { from: fromCap, to: nextCap },
          scheduledAt: { from: fromScheduled, to: nextScheduled },
        }),
      ],
    );
  });
  return { perMinuteCap: nextCap, scheduledAt: nextScheduled };
}

/* ------------------------------------------------------------------ lifecycle */

export async function startCampaign(id: string, userId: string): Promise<void> {
  const db = await getDb();
  const result = await db.query(
    `UPDATE campaigns SET status = 'active', updated_at = now()
     WHERE id = $1 AND status = 'approved'`,
    [id],
  );
  if (!result.rowCount) {
    throw new AppError(
      "Only an approved, unstarted campaign can be started.",
      409,
    );
  }
  await db.query(
    `INSERT INTO audit_log
      (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1, 'founder', $2, 'campaign.started', 'campaign', $3, '{}'::jsonb)`,
    [crypto.randomUUID(), userId, id],
  );
}

export async function setCampaignStatus(
  id: string,
  status: "paused" | "active" | "cancelled",
): Promise<void> {
  const db = await getDb();
  if (status === "cancelled") {
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE campaigns SET status = 'cancelled', updated_at = now() WHERE id = $1`,
        [id],
      );
      await tx.query(
        `UPDATE campaign_items SET status = 'skipped', updated_at = now()
         WHERE campaign_id = $1 AND status = 'queued'`,
        [id],
      );
    });
    return;
  }
  const before = await db.query<{ status: string }>(
    `SELECT status FROM campaigns WHERE id = $1`,
    [id],
  );
  await db.query(
    `UPDATE campaigns SET status = $1, updated_at = now(),
       consecutive_failures = CASE WHEN $1 = 'active' THEN 0 ELSE consecutive_failures END
     WHERE id = $2 AND status IN ('approved', 'paused', 'active')`,
    [status, id],
  );
  if (status === "active" && before.rows[0]?.status === "paused") {
    // A resume is visible in the run journal too, and the circuit breaker starts fresh.
    await journal(id, "resumed", { reason: "The campaign was resumed by the founder." });
  }
}

export async function renameCampaign(id: string, name: string): Promise<void> {
  if (!name.trim()) throw new AppError("Campaign name cannot be empty.");
  const db = await getDb();
  const result = await db.query(
    `UPDATE campaigns SET name = $1, updated_at = now() WHERE id = $2`,
    [name.trim(), id],
  );
  if (!result.rowCount) throw new AppError("Campaign not found.", 404);
}

/* ------------------------------------------------------------------ reads */

export async function listCampaigns(): Promise<CampaignSummary[]> {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT c.*, a.email_address,
      (SELECT count(*) FROM campaign_items ci WHERE ci.campaign_id = c.id) AS total,
      (SELECT count(*) FROM campaign_items ci WHERE ci.campaign_id = c.id AND ci.status = 'sent') AS sent,
      (SELECT count(*) FROM campaign_items ci WHERE ci.campaign_id = c.id AND ci.status = 'failed') AS failed,
      (SELECT count(*) FROM campaign_items ci WHERE ci.campaign_id = c.id AND ci.status = 'skipped') AS skipped,
      (SELECT count(*) FROM campaign_items ci WHERE ci.campaign_id = c.id AND ci.status IN ('queued', 'sending')) AS queued
     FROM campaigns c
     JOIN email_accounts a ON a.id = c.account_id
     ORDER BY c.created_at DESC LIMIT 100`,
  );
  if (!result.rows.length) return [];
  // The journal for the listed campaigns, so every skip is named beside its count. Bounded per
  // campaign: the newest 25 entries each, oldest-first, which is what the founder reads.
  const ids = result.rows.map((row) => row.id);
  const journal = await db.query<any>(
    `SELECT campaign_id, id, level, reason, draft_id, created_at FROM (
       SELECT j.*, row_number() OVER (PARTITION BY j.campaign_id ORDER BY j.created_at DESC, j.id DESC) AS rn
       FROM campaign_run_journal j WHERE j.campaign_id = ANY($1::uuid[])
     ) t WHERE rn <= 25 ORDER BY campaign_id, created_at ASC, id ASC`,
    [ids],
  );
  const journalByCampaign = new Map<string, any[]>();
  for (const row of journal.rows) {
    const list = journalByCampaign.get(row.campaign_id) ?? [];
    list.push({
      id: row.id,
      level: row.level,
      reason: row.reason,
      draftId: row.draft_id ?? null,
      createdAt: iso(row.created_at) ?? "",
    });
    journalByCampaign.set(row.campaign_id, list);
  }
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    accountEmail: row.email_address,
    total: Number(row.total),
    sent: Number(row.sent),
    failed: Number(row.failed),
    skipped: Number(row.skipped),
    queued: Number(row.queued),
    createdAt: iso(row.created_at) ?? "",
    scheduledAt: iso(row.scheduled_at),
    perMinuteCap:
      row.per_minute_cap === null || row.per_minute_cap === undefined
        ? null
        : Number(row.per_minute_cap),
    lastError: row.last_error ?? null,
    journal: journalByCampaign.get(row.id) ?? [],
  }));
}

export async function getCampaign(id: string) {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT c.*, a.email_address FROM campaigns c
     JOIN email_accounts a ON a.id = c.account_id WHERE c.id = $1`,
    [id],
  );
  const campaign = result.rows[0];
  if (!campaign) return null;
  const items = await db.query<any>(
    `SELECT ci.*, p.business_name, d.subject
     FROM campaign_items ci
     JOIN prospects p ON p.id = ci.prospect_id
     JOIN drafts d ON d.id = ci.draft_id
     WHERE ci.campaign_id = $1 ORDER BY ci.position ASC`,
    [id],
  );
  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    accountEmail: campaign.email_address,
    total: items.rows.length,
    sent: items.rows.filter((item) => item.status === "sent").length,
    failed: items.rows.filter((item) => item.status === "failed").length,
    queued: items.rows.filter((item) => ["queued", "sending"].includes(item.status)).length,
    createdAt: iso(campaign.created_at),
    scheduledAt: iso(campaign.scheduled_at),
    perMinuteCap:
      campaign.per_minute_cap === null || campaign.per_minute_cap === undefined
        ? null
        : Number(campaign.per_minute_cap),
    batchSize: Number(campaign.batch_size ?? 0),
    lastError: campaign.last_error ?? null,
    items: items.rows.map((item) => ({
      id: item.id,
      prospectId: item.prospect_id,
      businessName: item.business_name,
      subject: item.subject,
      status: item.status,
      error: item.error,
    })),
    usage: await getSendUsage(campaign.account_id),
  };
}

/* ------------------------------------------------------------------ run journal */

async function journal(
  campaignId: string,
  level:
    | "item_skipped"
    | "system_failure"
    | "paused"
    | "resumed"
    | "completed"
    | "auto_started"
    | "auto_start_held",
  input: {
    reason: string;
    itemId?: string | null;
    draftId?: string | null;
    metadata?: unknown;
  },
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO campaign_run_journal
      (id, campaign_id, level, item_id, draft_id, reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      crypto.randomUUID(),
      campaignId,
      level,
      input.itemId ?? null,
      input.draftId ?? null,
      input.reason,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

/** Everything the runner recorded for a campaign, oldest first. */
export async function listCampaignJournal(campaignId: string) {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT * FROM campaign_run_journal WHERE campaign_id = $1 ORDER BY created_at ASC`,
    [campaignId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    level: row.level,
    itemId: row.item_id,
    draftId: row.draft_id,
    reason: row.reason,
    metadata: row.metadata,
    createdAt: iso(row.created_at),
  }));
}

/* ------------------------------------------------------------------ pacing state */

export interface CampaignPacingState {
  ready: boolean;
  message?: string;
  nextAllowedAt?: string | null;
}

/**
 * Whether this campaign may send right now, decided from database state only — never from anything a
 * browser sends. Three gates: a scheduled start still in the future, the rolling per-minute cap (when
 * set), and the campaign's own snapshot of the mailbox's daily limit. Being held here is not a
 * failure: nothing is sent, the campaign stays active and the next window resumes it.
 */
export async function campaignPacingState(campaign: {
  id: string;
  scheduled_at: string | null;
  per_minute_cap: number | null;
  daily_send_limit_snapshot: number;
}): Promise<CampaignPacingState> {
  const db = await getDb();
  if (campaign.scheduled_at) {
    const startMs = new Date(campaign.scheduled_at).getTime();
    if (Number.isFinite(startMs) && startMs > Date.now()) {
      return {
        ready: false,
        message: `This campaign is scheduled to start at ${new Date(startMs).toISOString()}.`,
        nextAllowedAt: new Date(startMs).toISOString(),
      };
    }
  }
  if (campaign.per_minute_cap !== null && campaign.per_minute_cap !== undefined) {
    const recent = await db.query<{ count: string | number; last_sent: string | null }>(
      `SELECT count(*) AS count, max(completed_at) AS last_sent FROM outbound_sends
        WHERE campaign_id = $1 AND status IN ('accepted', 'sandbox', 'uncertain')
          AND completed_at >= now() - ($2 || ' seconds')::interval`,
      [campaign.id, String(PER_MINUTE_WINDOW_SECONDS)],
    );
    const count = Number(recent.rows[0]?.count ?? 0);
    if (count >= Number(campaign.per_minute_cap)) {
      const lastSent = recent.rows[0]?.last_sent
        ? new Date(recent.rows[0].last_sent as string).getTime()
        : Date.now();
      return {
        ready: false,
        message: `Reached this campaign's per-minute cap of ${campaign.per_minute_cap} sends. The next send waits for the 60-second window to pass.`,
        nextAllowedAt: new Date(lastSent + PER_MINUTE_WINDOW_SECONDS * 1000).toISOString(),
      };
    }
  }
  const settings = await getWorkspaceSettings();
  const window = addedWindow("today", new Date(), undefined, undefined, settings.timezone)!;
  const today = await db.query<{ count: string | number }>(
    `SELECT count(*) AS count FROM outbound_sends
      WHERE campaign_id = $1 AND status IN ('accepted', 'sandbox')
        AND completed_at >= $2 AND completed_at < $3`,
    [campaign.id, window.from.toISOString(), window.to.toISOString()],
  );
  const sentToday = Number(today.rows[0]?.count ?? 0);
  if (sentToday >= Number(campaign.daily_send_limit_snapshot)) {
    return {
      ready: false,
      message: `Reached this campaign's snapshot of ${campaign.daily_send_limit_snapshot} sends per workspace day. Sending resumes when the day's window resets.`,
      nextAllowedAt: null,
    };
  }
  return { ready: true };
}

/* ------------------------------------------------------------------ failure classification */

/** The per-item refusals that end one item but never the run. */
const PER_ITEM_SKIP_CODES = new Set([
  "suppressed",
  "do_not_contact",
  "already_contacted",
  "prospect_replied",
  "unverified_recipient",
  "duplicate_contact",
  "rejection_hold",
]);

/**
 * A DETERMINISTIC per-recipient skip: the same recipient and draft produce the same result every time,
 * so it is not evidence of a systemic fault and must not count toward the circuit breaker. The
 * founder's rule — "skip the failed one and carry on if it is not a system issue" — makes these skips
 * the thing the runner moves past, never a reason to pause.
 */
export function isDeterministicSkip(error: unknown): boolean {
  return error instanceof AppError && PER_ITEM_SKIP_CODES.has(error.code);
}

const SYSTEM_FAILURE_CODES = new Set([
  "email_account_not_connected",
  "bounce_rate_paused",
  "no_sender_profile",
  "no_email_account",
  "post_send_recording_failed",
]);

/**
 * The provider is asking us to slow down, or our quota is spent. This is the provider's own capacity,
 * not the recipient's fault, so it pauses the campaign immediately rather than skipping one recipient —
 * carrying on would only deepen the throttle. Covers the usual API codes and the SMTP transient
 * throttling responses (421/450/452) and the wordings providers use for them.
 */
const RATE_LIMIT_CODES = new Set([
  "rate_limited",
  "rate_limit_exceeded",
  "too_many_requests",
  "quota_exceeded",
  "quota_exhausted",
  "throttled",
]);
const RATE_LIMIT_PATTERN =
  /rate.?limit|throttl|too many (?:messages|requests|connections|recipients)|quota|(?:^|\D)(?:421|450|452)(?!\d)/i;

/**
 * A system failure pauses the whole campaign and keeps it resumable; a per-item failure skips the one
 * item and the runner goes on. This decides which. An unexpected (non-AppError) exception is always
 * systemic, because an internal error is never the recipient's fault. A provider rate-limit or quota
 * refusal is systemic for the same reason — it is the provider's capacity, not this recipient. The
 * transport's own label is coarse — an authentication failure and an unreachable server both arrive as
 * `smtp_rejected` — so the message decides between them and a mailbox-rejected recipient.
 */
export function isSystemFailure(error: unknown): boolean {
  if (!(error instanceof AppError)) return true;
  if (SYSTEM_FAILURE_CODES.has(error.code)) return true;
  if (RATE_LIMIT_CODES.has(error.code)) return true;
  if (RATE_LIMIT_PATTERN.test(error.message)) return true;
  if (error.code === "smtp_rejected") {
    return /authenticat|credential|EAUTH|unauthor|not connected|refused|timed? ?out|timeout|ESOCKET|ETIMEDOUT|connect(?:ion)? (?:fail|error|reset)/i.test(
      error.message,
    );
  }
  return false;
}

async function journalCompleted(campaignId: string, batchSize: number): Promise<void> {
  const db = await getDb();
  const progress = await campaignProgress(campaignId);
  const updated = await db.query(
    `UPDATE campaigns SET status = 'completed', completed_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'active'`,
    [campaignId],
  );
  if (!updated.rowCount) return;
  await journal(campaignId, "completed", {
    reason: `${progress.sent} sent, ${progress.failed} failed, ${progress.skipped} skipped of ${batchSize} selected.`,
    metadata: {
      sent: progress.sent,
      failed: progress.failed,
      skipped: progress.skipped,
      total: progress.total,
      batchSize,
    },
  });
}

async function bumpConsecutiveFailures(campaignId: string): Promise<number> {
  const db = await getDb();
  const result = await db.query<{ consecutive_failures: number }>(
    `UPDATE campaigns SET consecutive_failures = consecutive_failures + 1
      WHERE id = $1 RETURNING consecutive_failures`,
    [campaignId],
  );
  return Number(result.rows[0]?.consecutive_failures ?? 0);
}

async function resetConsecutiveFailures(campaignId: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE campaigns SET consecutive_failures = 0
      WHERE id = $1 AND consecutive_failures <> 0`,
    [campaignId],
  );
}

/* ------------------------------------------------------------------ the runner */

export type CampaignStepOutcome = "none" | "sent" | "held" | "paused" | "failed" | "skipped";

export interface CampaignStepResult {
  done: boolean;
  sent?: boolean;
  outcome: CampaignStepOutcome;
  error?: string;
  message?: string;
  nextAllowedAt?: string | null;
  progress?: {
    sent: number;
    failed: number;
    skipped: number;
    queued: number;
    total: number;
  };
}

async function handleItemError(
  campaignId: string,
  campaignRow: any,
  item: { id: string; draft_id: string },
  error: unknown,
): Promise<CampaignStepResult> {
  const db = await getDb();
  const appError = error instanceof AppError ? error : null;
  const code = appError?.code ?? "";
  const message = error instanceof Error ? error.message : "The campaign item failed.";

  // A pacing refusal is not a failure: the item waits for the next window and the campaign stays active.
  if (code === "daily_limit_reached" || code === "min_interval") {
    await db.query(
      `UPDATE campaign_items SET status = 'queued', updated_at = now() WHERE id = $1`,
      [item.id],
    );
    const usage = await getSendUsage(campaignRow.account_id);
    return {
      done: false,
      sent: false,
      outcome: "held",
      error: message,
      nextAllowedAt: usage.nextAllowedAt,
      progress: await campaignProgress(campaignId),
    };
  }

  if (isSystemFailure(error)) {
    await journal(campaignId, "system_failure", {
      itemId: item.id,
      draftId: item.draft_id,
      reason: message,
      metadata: { code: code || null },
    });
    await db.query(
      `UPDATE campaigns SET status = 'paused', last_error = $2, updated_at = now() WHERE id = $1`,
      [campaignId, message],
    );
    // The item goes back to the queue: a resume continues from here, it does not restart.
    await db.query(
      `UPDATE campaign_items SET status = 'queued', updated_at = now() WHERE id = $1 AND status = 'sending'`,
      [item.id],
    );
    return {
      done: false,
      sent: false,
      outcome: "paused",
      error: message,
      progress: await campaignProgress(campaignId),
    };
  }

  // Per-item failure: this item is terminal and named in its own row AND the run journal; the campaign
  // goes on. A DETERMINISTIC skip (a suppression, an opt-out, an invalid address, a rejection hold) is
  // never a systemic signal — it does not count toward the circuit breaker, and it resets the run of
  // failures because it is not one of them. Only an INDETERMINATE failure (a transient/provider or
  // unknown error) counts; see `isDeterministicSkip` and `isSystemFailure`.
  const deterministic = isDeterministicSkip(error);
  const itemStatus = deterministic ? "skipped" : "failed";
  await db.query(
    `UPDATE campaign_items SET status = $2, error = $1, updated_at = now() WHERE id = $3`,
    [message, itemStatus, item.id],
  );
  await journal(campaignId, "item_skipped", {
    itemId: item.id,
    draftId: item.draft_id,
    reason: message,
    metadata: { code: code || null, itemStatus },
  });

  if (deterministic) {
    // A deterministic skip is progress, not a fault: it is not a failure, so it never trips the breaker
    // and it resets the run of indeterminate failures behind it.
    await resetConsecutiveFailures(campaignId);
  } else {
    const failures = await bumpConsecutiveFailures(campaignId);
    if (failures >= CAMPAIGN_FAILURE_CIRCUIT_BREAKER) {
      const reason = `${failures} items failed in a row, which usually means the sending setup rather than the recipients. The campaign was paused after: ${message}`;
      await db.query(
        `UPDATE campaigns SET status = 'paused', last_error = $2, updated_at = now() WHERE id = $1`,
        [campaignId, reason],
      );
      await journal(campaignId, "paused", {
        reason,
        metadata: { consecutiveFailures: failures },
      });
      return {
        done: false,
        sent: false,
        outcome: "paused",
        error: message,
        progress: await campaignProgress(campaignId),
      };
    }
  }

  const progress = await campaignProgress(campaignId);
  if (progress.queued === 0) await journalCompleted(campaignId, Number(campaignRow.batch_size ?? 0));
  return {
    done: progress.queued === 0,
    sent: false,
    outcome: itemStatus,
    error: message,
    progress,
  };
}

/**
 * One step of a campaign: claim the next queued item, or finish the campaign, or hold for pacing.
 *
 * Every step still passes the full send gate inside `sendDraft` — this adds pacing and the
 * per-item/system failure split, nothing else. Pacing is read from the database, never from a caller.
 */
export async function processNextCampaignItem(
  campaignId: string,
  userId: string,
): Promise<CampaignStepResult> {
  const db = await getDb();
  const campaign = await db.query<any>(
    `SELECT * FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  const row = campaign.rows[0];
  if (!row) throw new AppError("Campaign not found.", 404);
  if (row.status !== "active") {
    throw new AppError("This campaign is not active.", 409);
  }

  const pacing = await campaignPacingState(row);
  if (!pacing.ready) {
    return {
      done: false,
      sent: false,
      outcome: "held",
      message: pacing.message,
      nextAllowedAt: pacing.nextAllowedAt ?? null,
      progress: await campaignProgress(campaignId),
    };
  }

  let item: any = null;
  await db.transaction(async (tx) => {
    const next = await tx.query<any>(
      `SELECT ci.*, d.status AS draft_status
       FROM campaign_items ci
       JOIN drafts d ON d.id = ci.draft_id
       WHERE ci.campaign_id = $1 AND ci.status = 'queued'
       ORDER BY ci.position ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [campaignId],
    );
    item = next.rows[0] ?? null;
    if (item) {
      await tx.query(
        `UPDATE campaign_items SET status = 'sending', updated_at = now() WHERE id = $1`,
        [item.id],
      );
    }
  });

  if (!item) {
    await journalCompleted(campaignId, Number(row.batch_size ?? 0));
    return { done: true, outcome: "none", progress: await campaignProgress(campaignId) };
  }

  try {
    const outcome = await sendDraft({
      draftId: item.draft_id,
      accountId: row.account_id,
      campaignId,
      actorUserId: userId,
    });
    if ("queued" in outcome) {
      // Held back by the account's own minimum interval. Nothing was sent. The item returns to the
      // queue, and the transient ledger row is removed so the scheduler's own drain cannot send it
      // outside this campaign's pacing (which would leave the item stranded at 'sending').
      await db.query(
        `UPDATE campaign_items SET status = 'queued', error = null, updated_at = now() WHERE id = $1`,
        [item.id],
      );
      await db.query(
        `DELETE FROM outbound_sends WHERE draft_id = $1 AND status = 'queued'`,
        [item.draft_id],
      );
      const usage = await getSendUsage(row.account_id);
      return {
        done: false,
        sent: false,
        outcome: "held",
        error: undefined,
        nextAllowedAt: usage.nextAllowedAt,
        progress: await campaignProgress(campaignId),
      };
    }
    await resetConsecutiveFailures(campaignId);
    const progress = await campaignProgress(campaignId);
    if (progress.queued === 0) await journalCompleted(campaignId, Number(row.batch_size ?? 0));
    return {
      done: progress.queued === 0,
      sent: true,
      outcome: "sent",
      progress,
    };
  } catch (error) {
    return handleItemError(campaignId, row, item, error);
  }
}

export interface CampaignRunResult {
  status: "running" | "held" | "paused" | "completed" | "inactive";
  sent: number;
  failed: number;
  skipped: number;
  steps: number;
  message?: string;
  nextAllowedAt?: string | null;
}

/**
 * Work a running campaign through its items, one after each success, until it is complete or a stop
 * says otherwise. A per-item failure skips that one item and the run continues; a system failure or
 * the circuit breaker pauses the campaign and the run ends. A pacing hold (per-minute cap, daily
 * snapshot, the mailbox's minimum interval, a future start) ends the run with the campaign still
 * active, so the next tick resumes exactly where it stopped.
 */
export async function runCampaign(
  campaignId: string,
  userId: string,
): Promise<CampaignRunResult> {
  const db = await getDb();
  const found = await db.query<{ status: string; batch_size: number }>(
    `SELECT status, batch_size FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  const row = found.rows[0];
  if (!row) throw new AppError("Campaign not found.", 404);
  if (row.status !== "active") {
    return { status: "inactive", sent: 0, failed: 0, skipped: 0, steps: 0 };
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let steps = 0;
  // Bounded by the campaign's own size plus one, so one tick can never become an unbounded loop.
  const maxSteps = Math.max(Number(row.batch_size ?? 0), 0) + 1;
  while (steps < maxSteps) {
    const step = await processNextCampaignItem(campaignId, userId);
    steps += 1;
    if (step.outcome === "sent") {
      sent += 1;
      if (step.done) return { status: "completed", sent, failed, skipped, steps };
      continue;
    }
    if (step.outcome === "failed") {
      failed += 1;
      if (step.done) return { status: "completed", sent, failed, skipped, steps };
      continue;
    }
    if (step.outcome === "skipped") {
      skipped += 1;
      if (step.done) return { status: "completed", sent, failed, skipped, steps };
      continue;
    }
    if (step.outcome === "held") {
      return {
        status: "held",
        sent,
        failed,
        skipped,
        steps,
        message: step.message,
        nextAllowedAt: step.nextAllowedAt ?? null,
      };
    }
    if (step.outcome === "paused") {
      return { status: "paused", sent, failed, skipped, steps, message: step.error };
    }
    return { status: "completed", sent, failed, skipped, steps };
  }
  return { status: "running", sent, failed, skipped, steps };
}

export interface CampaignAutoStartResult {
  /** Campaigns this pass moved from approved to active because their scheduled time had arrived. */
  started: string[];
  /** Scheduled starts missed by more than a day, recorded and left for the founder, never mass-started. */
  heldOverdue: string[];
}

/**
 * Start every approved campaign whose scheduled time has arrived, so a campaign the founder scheduled
 * begins itself without a second click. Creating a campaign WITH a start time is the founder's
 * authorising act, and the audit row it writes (`campaign.auto_started`) attributes the start to that
 * founder (`created_by`), never to the scheduler.
 *
 * Guards, all from database state:
 * - Only an `approved` campaign is auto-started. A manual campaign (no `scheduled_at`) is untouched —
 *   it still waits for the founder's own Start. A campaign already active, paused, cancelled or
 *   completed is never re-started here.
 * - The approved-guarded UPDATE is the claim, so two runner passes cannot double-start: the second
 *   finds status `active` and changes nothing, and the journal entry is written exactly once.
 * - If the process was down when the time passed the campaign still starts on the next pass — but only
 *   if it is within `CAMPAIGN_AUTOSTART_LATE_MS`. A start missed by more than a day is recorded once
 *   (`auto_start_held`) and left approved for the founder rather than mass-started stale.
 */
export async function autoStartDueCampaigns(
  options: { maxCampaigns?: number } = {},
): Promise<CampaignAutoStartResult> {
  const db = await getDb();
  const max = Math.min(Math.max(options.maxCampaigns ?? 5, 1), 20);
  const due = await db.query<{ id: string; scheduled_at: string; created_by: string | null }>(
    `SELECT id, scheduled_at, created_by FROM campaigns
      WHERE status = 'approved' AND scheduled_at IS NOT NULL AND scheduled_at <= now()
      ORDER BY scheduled_at ASC LIMIT $1`,
    [max],
  );
  const started: string[] = [];
  const heldOverdue: string[] = [];
  const now = Date.now();
  for (const row of due.rows) {
    const scheduledMs = new Date(row.scheduled_at).getTime();
    const lateMs = Number.isFinite(scheduledMs) ? now - scheduledMs : 0;
    if (lateMs > CAMPAIGN_AUTOSTART_LATE_MS) {
      // Recorded once, then left alone: two passes must not keep re-recording the same refusal.
      const already = await db.query(
        `SELECT 1 FROM campaign_run_journal WHERE campaign_id = $1 AND level = 'auto_start_held' LIMIT 1`,
        [row.id],
      );
      if (!already.rows.length) {
        await journal(row.id, "auto_start_held", {
          reason: `The scheduled start (${row.scheduled_at}) was missed by more than 24 hours, so this campaign was not started automatically. Start it yourself to send it.`,
          metadata: { scheduledAt: row.scheduled_at },
        });
      }
      heldOverdue.push(row.id);
      continue;
    }
    const claimed = await db.query<{ id: string }>(
      `UPDATE campaigns SET status = 'active', updated_at = now()
        WHERE id = $1 AND status = 'approved' RETURNING id`,
      [row.id],
    );
    if (!claimed.rowCount) continue;
    await journal(row.id, "auto_started", {
      reason: `Started automatically at its scheduled time (${row.scheduled_at}), which the founder set when authorising the batch.`,
      metadata: { scheduledAt: row.scheduled_at },
    });
    await db.query(
      `INSERT INTO audit_log
        (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'founder', $2, 'campaign.auto_started', 'campaign', $3, $4::jsonb)`,
      [crypto.randomUUID(), row.created_by, row.id, JSON.stringify({ scheduledAt: row.scheduled_at })],
    );
    started.push(row.id);
  }
  return { started, heldOverdue };
}

/**
 * The scheduler's entry point: start any scheduled campaign whose time has arrived, then run every
 * active campaign whose start time has come, bounded per tick. A campaign that pauses or holds stops
 * for this tick and is picked up again on the next one.
 */
export async function runDueCampaigns(
  options: { maxCampaigns?: number } = {},
): Promise<{
  ran: number;
  results: Array<{
    campaignId: string;
    status: string;
    sent: number;
    failed: number;
    skipped: number;
  }>;
  autoStarted: string[];
  heldOverdue: string[];
}> {
  const db = await getDb();
  // Scheduled campaigns start themselves first; the active pass below then runs them the same tick.
  const auto = await autoStartDueCampaigns({ maxCampaigns: options.maxCampaigns });
  const max = Math.min(Math.max(options.maxCampaigns ?? 3, 1), 20);
  const due = await db.query<{ id: string }>(
    `SELECT id FROM campaigns
      WHERE status = 'active' AND (scheduled_at IS NULL OR scheduled_at <= now())
      ORDER BY created_at ASC LIMIT $1`,
    [max],
  );
  const results: Array<{
    campaignId: string;
    status: string;
    sent: number;
    failed: number;
    skipped: number;
  }> = [];
  for (const row of due.rows) {
    try {
      const run = await runCampaign(row.id, "scheduler");
      results.push({
        campaignId: row.id,
        status: run.status,
        sent: run.sent,
        failed: run.failed,
        skipped: run.skipped,
      });
    } catch {
      results.push({ campaignId: row.id, status: "error", sent: 0, failed: 0, skipped: 0 });
    }
  }
  return { ran: results.length, results, autoStarted: auto.started, heldOverdue: auto.heldOverdue };
}

export async function retryFailedCampaignItems(
  campaignId: string,
): Promise<{ queued: number; uncertain: number }> {
  const db = await getDb();
  const campaign = await db.query<any>(`SELECT * FROM campaigns WHERE id = $1`, [
    campaignId,
  ]);
  if (!campaign.rows[0]) throw new AppError("Campaign not found.", 404);
  const failed = await db.query<any>(
    `SELECT ci.id, os.status AS send_status
     FROM campaign_items ci
     LEFT JOIN outbound_sends os ON os.draft_id = ci.draft_id
     WHERE ci.campaign_id = $1 AND ci.status = 'failed'`,
    [campaignId],
  );
  let queued = 0;
  let uncertain = 0;
  await db.transaction(async (tx) => {
    for (const item of failed.rows) {
      if (item.send_status === "uncertain") {
        uncertain += 1;
        continue;
      }
      await tx.query(
        `UPDATE campaign_items SET status = 'queued', error = null, updated_at = now()
         WHERE id = $1`,
        [item.id],
      );
      queued += 1;
    }
    if (queued > 0) {
      await tx.query(
        `UPDATE campaigns SET status = 'active', completed_at = null, updated_at = now()
         WHERE id = $1`,
        [campaignId],
      );
    }
  });
  return { queued, uncertain };
}

export async function campaignProgress(campaignId: string) {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT
      count(*) AS total,
      count(*) FILTER (WHERE status = 'sent') AS sent,
      count(*) FILTER (WHERE status = 'failed') AS failed,
      count(*) FILTER (WHERE status = 'skipped') AS skipped,
      count(*) FILTER (WHERE status IN ('queued', 'sending')) AS queued
     FROM campaign_items WHERE campaign_id = $1`,
    [campaignId],
  );
  const row = result.rows[0];
  return {
    total: Number(row.total),
    sent: Number(row.sent),
    failed: Number(row.failed),
    skipped: Number(row.skipped),
    queued: Number(row.queued),
  };
}
