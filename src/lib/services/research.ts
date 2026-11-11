import { getDb } from "@/lib/db/client";
import { AppError, asStringArray, iso, number } from "@/lib/utils";
import type { Category, ResearchJob, ResearchJobStatus } from "@/lib/types";
import { qualifiedTargetCountSql, qualifiedTargetPredicateSql } from "@/lib/leads/qualified-target";
import { getWorkspaceSettings } from "./settings";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * `verified_count` is the job's progress toward its target and is the ONLY figure completion
 * reads: the shared qualified-target predicate (effective Tier 1 / Other, eligible). It counts
 * prospects rows through EXISTS, so repeated saves, several emails or several assessments of one
 * lead count once. `email_count` stays a raw total (verified job leads with any stored email,
 * whatever their tier) and is never used as target progress.
 */
const JOB_SELECT = `
  SELECT j.*,
    (SELECT count(*) FROM research_usage u WHERE u.job_id = j.id AND NOT u.cost_known) AS unknown_cost_calls,
    ${qualifiedTargetCountSql("j.id")} AS verified_count,
    (SELECT count(*) FROM prospects p
      WHERE p.research_job_id = j.id AND p.qualification_status = 'verified'
        AND p.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM prospect_emails e WHERE e.prospect_id = p.id)
    ) AS email_count,
    (SELECT count(*) FROM drafts d
      JOIN prospects p ON p.id = d.prospect_id
      WHERE p.research_job_id = j.id AND d.kind = 'first_contact'
    ) AS draft_count,
    (SELECT count(*) FROM research_events ev
      WHERE ev.job_id = j.id AND ev.event_type = 'duplicate_rejected'
    ) AS duplicates_rejected,
    (SELECT count(*) FROM research_candidates rc
      WHERE rc.job_id = j.id AND rc.status IN ('pending', 'researching')
    ) AS candidates_pending,
    (SELECT count(*) FROM research_candidates rc
      WHERE rc.job_id = j.id AND rc.status = 'qualified'
    ) AS candidates_qualified
  FROM research_jobs j
`;

function mapJob(row: any): ResearchJob {
  const target = number(row.target_count);
  const verified = number(row.verified_count);
  return {
    id: row.id,
    name: row.name,
    targetCount: target,
    categories: asStringArray(row.categories) as Category[],
    regions: row.regions,
    requirements: row.requirements,
    status: row.status as ResearchJobStatus,
    engine: row.engine === "deepseek" ? "deepseek" : "manual",
    notes: row.notes,
    createdAt: iso(row.created_at) ?? "",
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    stoppedAt: iso(row.stopped_at),
    lastWorkerAt: iso(row.last_worker_at),
    nextRunAt: iso(row.next_run_at),
    stopReason: row.stop_reason,
    lastError: row.last_error,
    budgetUsd: number(row.budget_usd, 5),
    spentUsd: number(row.spent_usd),
    unknownCostCalls: number(row.unknown_cost_calls),
    concurrency: number(row.concurrency, 1),
    ticks: number(row.ticks),
    searchQueriesUsed: number(row.search_queries_used),
    candidatesDiscovered: number(row.candidates_discovered),
    failedVerifications: number(row.failed_verifications),
    candidatesPending: number(row.candidates_pending),
    candidatesQualified: number(row.candidates_qualified),
    verifiedCount: verified,
    emailCount: number(row.email_count),
    draftCount: number(row.draft_count),
    duplicatesRejected: number(row.duplicates_rejected),
    remaining: Math.max(0, target - verified),
  };
}

export async function listResearchJobs(includeArchived = false): Promise<ResearchJob[]> {
  const db = await getDb();
  const result = await db.query<any>(
    `${JOB_SELECT}
     ${includeArchived ? "" : "WHERE j.status <> 'archived'"}
     ORDER BY CASE j.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
              j.created_at DESC`,
  );
  return result.rows.map(mapJob);
}

export async function getResearchJob(id: string): Promise<ResearchJob | null> {
  const db = await getDb();
  const result = await db.query<any>(`${JOB_SELECT} WHERE j.id = $1`, [id]);
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

export async function createResearchJob(input: {
  name: string;
  targetCount: number;
  categories: Category[];
  regions?: string;
  requirements?: string;
  notes?: string;
  engine?: "manual" | "deepseek";
  budgetUsd?: number;
  concurrency?: number;
  userId: string;
}): Promise<ResearchJob> {
  if (!input.name.trim()) throw new AppError("Give the research job a name.");
  if (input.targetCount < 1 || input.targetCount > 10_000) {
    throw new AppError("Research targets must be between 1 and 10,000.");
  }
  if (!input.categories.length) {
    throw new AppError("Select at least one category for the research job.");
  }
  const engine = input.engine ?? "manual";
  // Defaults come from workspace settings so the founder configures budget and
  // concurrency once instead of per job.
  const settings = await getWorkspaceSettings();
  const budgetUsd = input.budgetUsd ?? settings.researchDefaultBudgetUsd;
  const concurrency = input.concurrency ?? settings.researchDefaultConcurrency;
  if (!(budgetUsd > 0) || budgetUsd > 1_000) {
    throw new AppError("Research budget must be between $0.01 and $1,000.");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new AppError("Research concurrency must be between 1 and 8.");
  }
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO research_jobs
      (id, name, target_count, categories, regions, requirements, notes, engine,
       budget_usd, concurrency, status, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      input.name.trim(),
      input.targetCount,
      JSON.stringify(input.categories),
      input.regions?.trim() || "Worldwide",
      input.requirements?.trim() ||
        "Commercial trading-signal providers only, with a publicly published business email and source URL.",
      input.notes?.trim() || "",
      engine,
      budgetUsd,
      concurrency,
      engine === "deepseek" ? "paused" : "active",
      input.userId,
    ],
  );
  return (await getResearchJob(id))!;
}

export async function updateResearchJobStatus(
  id: string,
  status: "active" | "paused" | "completed" | "archived" | "cancelled",
): Promise<ResearchJob> {
  const db = await getDb();
  const job = await getResearchJob(id);
  if (!job) throw new AppError("Research job not found.", 404);
  const result = await db.query(
    `UPDATE research_jobs
     SET status = $1,
       completed_at = CASE
         WHEN $1 = 'completed' THEN now()
         WHEN $1 = 'active' THEN null
         ELSE completed_at END,
       stopped_at = CASE
         WHEN $1 = 'active' THEN null
         WHEN $1 IN ('cancelled', 'completed') THEN now()
         ELSE stopped_at END,
       stop_reason = CASE
         WHEN $1 = 'cancelled' THEN coalesce(stop_reason, 'Cancelled by the founder.')
         WHEN $1 = 'active' THEN null
         ELSE stop_reason END,
       started_at = CASE WHEN $1 = 'active' THEN coalesce(started_at, now()) ELSE started_at END,
       next_run_at = CASE WHEN $1 = 'active' THEN now() ELSE next_run_at END,
       updated_at = now()
     WHERE id = $2`,
    [status, id],
  );
  if (!result.rowCount) throw new AppError("Research job not found.", 404);
  const eventType = eventTypeForStatus(status);
  if (eventType) {
    await recordResearchEvent(id, eventType, {
      detail: { status },
      actorType: "founder",
    });
  }
  return (await getResearchJob(id))!;
}

/**
 * Maps a job status to an allowed `research_events.event_type`. The database
 * constrains this column, so statuses without a dedicated event return null
 * rather than an invalid type.
 */
function eventTypeForStatus(status: string): string | null {
  if (status === "active") return "job_resumed";
  if (status === "cancelled") return "job_cancelled";
  if (status === "completed") return "job_completed";
  if (status === "paused") return "job_paused";
  return null;
}

export async function recordResearchEvent(
  jobId: string,
  eventType: string,
  input: {
    prospectId?: string | null;
    detail?: Record<string, unknown>;
    actorType?: string;
  } = {},
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO research_events
      (id, job_id, event_type, prospect_id, detail, created_by_type)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      crypto.randomUUID(),
      jobId,
      eventType,
      input.prospectId ?? null,
      JSON.stringify(input.detail ?? {}),
      input.actorType ?? "deepseek",
    ],
  );
}

/**
 * Marks a job complete once its qualified-target count reaches the target. The count is
 * re-evaluated inside the guarded UPDATE with the same predicate the progress figure uses, so a
 * stale read cannot complete a job, and only an `active` job can move: paused, cancelled,
 * completed and archived jobs keep their status.
 */
export async function refreshResearchJobStatus(jobId: string): Promise<void> {
  const db = await getDb();
  const result = await db.query<{ target_count: number; verified_count: string | number }>(
    `WITH counted AS (
       SELECT j.id, ${qualifiedTargetCountSql("j.id")} AS verified_count
       FROM research_jobs j WHERE j.id = $1
     )
     UPDATE research_jobs r
     SET status = 'completed', completed_at = now(), stopped_at = now(),
       stop_reason = 'Target reached.', updated_at = now()
     FROM counted c
     WHERE r.id = c.id AND r.status = 'active' AND c.verified_count >= r.target_count
     RETURNING r.target_count, c.verified_count`,
    [jobId],
  );
  const completed = result.rows[0];
  if (completed) {
    await recordResearchEvent(jobId, "job_completed", {
      detail: { verifiedCount: Number(completed.verified_count), target: Number(completed.target_count) },
      actorType: "deepseek",
    });
  }
}

export async function recordDraftSaved(
  jobId: string | null,
  prospectId: string,
  actorType: string,
): Promise<void> {
  if (!jobId) return;
  const db = await getDb();
  await db.query(
    `INSERT INTO research_events
      (id, job_id, event_type, prospect_id, detail, created_by_type)
     VALUES ($1, $2, 'draft_saved', $3, $4::jsonb, $5)`,
    [
      crypto.randomUUID(),
      jobId,
      prospectId,
      JSON.stringify({ prospectId }),
      actorType,
    ],
  );
  await refreshResearchJobStatus(jobId);
}

export async function getResearchOverview(): Promise<{
  activeJobs: number;
  /** Effective eligible Tier 1 / Other leads across jobs — the only target-progress figure. */
  totalVerified: number;
  /** Raw stored total: verified-status leads with any email, whatever their tier. Not progress. */
  totalEmailsStored: number;
  totalDrafts: number;
  totalDuplicates: number;
  targetRemaining: number;
}> {
  const jobs = await listResearchJobs();
  return {
    activeJobs: jobs.filter((job) => job.status === "active").length,
    totalVerified: jobs.reduce((sum, job) => sum + job.verifiedCount, 0),
    totalEmailsStored: jobs.reduce((sum, job) => sum + job.emailCount, 0),
    totalDrafts: jobs.reduce((sum, job) => sum + job.draftCount, 0),
    totalDuplicates: jobs.reduce((sum, job) => sum + job.duplicatesRejected, 0),
    targetRemaining: jobs
      .filter((job) => job.status === "active")
      .reduce((sum, job) => sum + job.remaining, 0),
  };
}

/**
 * Totals across every saved lead, independent of research jobs.
 *
 * The per-job counters only know about leads a job created, so a lead saved by a connector with no
 * job at all is invisible to them. These figures come from the saved rows themselves — never from a
 * job counter, never estimated — and say separately how many leads sit outside every job.
 */
export async function getOverallLeadTotals(): Promise<{
  allLeads: number;
  verifiedLeads: number;
  verifiedWithEmail: number;
  /** Leads that count toward targets (shared qualified-target predicate), across all jobs. */
  qualifiedTargetLeads: number;
  draftsSaved: number;
  duplicatesRejected: number;
  notInAnyResearchJob: number;
}> {
  const db = await getDb();
  const result = await db.query<{
    all_leads: number;
    verified_leads: number;
    verified_with_email: number;
    qualified_target_leads: number;
    drafts_saved: number;
    duplicates_rejected: number;
    not_in_any_job: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM prospects WHERE archived_at IS NULL) AS all_leads,
       (SELECT count(*)::int FROM prospects
          WHERE qualification_status = 'verified' AND archived_at IS NULL) AS verified_leads,
       (SELECT count(*)::int FROM prospects
          WHERE qualification_status = 'verified' AND archived_at IS NULL
            AND EXISTS (SELECT 1 FROM prospect_emails e WHERE e.prospect_id = prospects.id)) AS verified_with_email,
       (SELECT count(*)::int FROM prospects p WHERE ${qualifiedTargetPredicateSql("p")}) AS qualified_target_leads,
       (SELECT count(*)::int FROM drafts) AS drafts_saved,
       (SELECT count(*)::int FROM research_events WHERE event_type = 'duplicate_rejected') AS duplicates_rejected,
       (SELECT count(*)::int FROM prospects
          WHERE research_job_id IS NULL AND archived_at IS NULL) AS not_in_any_job`,
  );
  const row = result.rows[0];
  return {
    allLeads: Number(row.all_leads),
    verifiedLeads: Number(row.verified_leads),
    verifiedWithEmail: Number(row.verified_with_email),
    qualifiedTargetLeads: Number(row.qualified_target_leads),
    draftsSaved: Number(row.drafts_saved),
    duplicatesRejected: Number(row.duplicates_rejected),
    notInAnyResearchJob: Number(row.not_in_any_job),
  };
}

export async function getRecentResearchEvents(limit = 12) {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT ev.*, j.name AS job_name, p.business_name
     FROM research_events ev
     JOIN research_jobs j ON j.id = ev.job_id
     LEFT JOIN prospects p ON p.id = ev.prospect_id
     ORDER BY ev.created_at DESC
     LIMIT $1`,
    [Math.min(limit, 50)],
  );
  return result.rows.map((row) => ({
    id: row.id,
    type: row.event_type,
    jobId: row.job_id,
    jobName: row.job_name,
    prospectId: row.prospect_id,
    businessName: row.business_name,
    detail: row.detail,
    actorType: row.created_by_type,
    createdAt: iso(row.created_at) ?? "",
  }));
}
