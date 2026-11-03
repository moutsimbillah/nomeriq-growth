import { getDb } from "@/lib/db/client";
import { iso, number } from "@/lib/utils";
import type { ResearchRunSummary } from "@/lib/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const DEEPSEEK_WORKER_ID = "deepseek-engine";

/**
 * Opens a durable run record. A run survives the request that created it, so an
 * interrupted worker is visible as `running` with a stale heartbeat rather than
 * disappearing silently.
 */
export async function startResearchRun(input: {
  jobId: string;
  workerId?: string;
}): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO research_runs (id, job_id, worker_id, status)
     VALUES ($1, $2, $3, 'running')`,
    [id, input.jobId, input.workerId ?? DEEPSEEK_WORKER_ID],
  );
  return id;
}

export async function heartbeatResearchRun(
  runId: string,
  counters: { processed?: number; saved?: number; errors?: number } = {},
): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE research_runs SET
       last_heartbeat_at = now(),
       processed = processed + $1,
       saved = saved + $2,
       errors = errors + $3
     WHERE id = $4`,
    [
      counters.processed ?? 0,
      counters.saved ?? 0,
      counters.errors ?? 0,
      runId,
    ],
  );
}

export async function finishResearchRun(input: {
  runId: string;
  status: "completed" | "failed" | "interrupted" | "budget_paused" | "cancelled";
  stopReason?: string | null;
}): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE research_runs SET status = $1, ended_at = now(), stop_reason = $2
     WHERE id = $3`,
    [input.status, input.stopReason?.slice(0, 500) ?? null, input.runId],
  );
}

/**
 * Marks runs whose heartbeat stopped as interrupted. Called at the start of a
 * worker tick so an operator can distinguish "crashed" from "still working".
 */
export async function markStaleRunsInterrupted(
  staleAfterSeconds = 300,
): Promise<number> {
  const db = await getDb();
  const result = await db.query(
    `UPDATE research_runs SET status = 'interrupted', ended_at = now(),
       stop_reason = coalesce(stop_reason, 'Worker heartbeat stopped.')
     WHERE status = 'running'
       AND last_heartbeat_at < now() - ($1 || ' seconds')::interval`,
    [String(staleAfterSeconds)],
  );
  return result.rowCount;
}

export async function listResearchRuns(
  jobId: string,
  limit = 10,
): Promise<ResearchRunSummary[]> {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT * FROM research_runs WHERE job_id = $1
     ORDER BY started_at DESC LIMIT $2`,
    [jobId, Math.min(Math.max(limit, 1), 50)],
  );
  return result.rows.map((row) => ({
    id: row.id,
    workerId: row.worker_id,
    status: row.status,
    startedAt: iso(row.started_at) ?? "",
    lastHeartbeatAt: iso(row.last_heartbeat_at) ?? "",
    endedAt: iso(row.ended_at),
    processed: number(row.processed),
    saved: number(row.saved),
    errors: number(row.errors),
    stopReason: row.stop_reason,
  }));
}

export interface BudgetState {
  budgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  exhausted: boolean;
}

export async function getJobBudget(jobId: string): Promise<BudgetState | null> {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT budget_usd, spent_usd FROM research_jobs WHERE id = $1`,
    [jobId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const budgetUsd = number(row.budget_usd);
  const spentUsd = number(row.spent_usd);
  return {
    budgetUsd,
    spentUsd,
    remainingUsd: Math.max(0, budgetUsd - spentUsd),
    // A tiny epsilon avoids a floating point "0.0000001 remaining" loop.
    exhausted: spentUsd >= budgetUsd - 1e-9,
  };
}

/**
 * Takes a short-lived exclusive lease on a job so two callers cannot advance the
 * same job at the same time.
 *
 * Without this, two open browser tabs (or a tab racing the cron) would each run a
 * tick for one job, spending the founder's budget twice over. The claim is a
 * single conditional UPDATE, so the database decides the winner rather than the
 * application. An expired lease is taken over, so a crashed caller cannot block a
 * job permanently.
 */
export async function claimJobLease(input: {
  jobId: string;
  workerId: string;
  ttlSeconds?: number;
}): Promise<{ claimed: boolean; holder: string | null }> {
  const db = await getDb();
  const ttl = Math.min(Math.max(input.ttlSeconds ?? 120, 10), 900);
  const result = await db.query<any>(
    `UPDATE research_jobs
     SET worker_id = $1,
       worker_claim_expires_at = now() + ($2 || ' seconds')::interval,
       updated_at = now()
     WHERE id = $3
       AND status = 'active'
       AND (
         worker_claim_expires_at IS NULL
         OR worker_claim_expires_at < now()
         OR worker_id = $1
       )
     RETURNING worker_id`,
    [input.workerId, String(ttl), input.jobId],
  );
  if (result.rowCount) return { claimed: true, holder: input.workerId };

  const current = await db.query<any>(
    `SELECT worker_id FROM research_jobs WHERE id = $1`,
    [input.jobId],
  );
  return { claimed: false, holder: current.rows[0]?.worker_id ?? null };
}

/** Releases a job lease early so the next tick can start immediately. */
export async function releaseJobLease(input: {
  jobId: string;
  workerId: string;
}): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE research_jobs
     SET worker_claim_expires_at = NULL, worker_id = NULL, updated_at = now()
     WHERE id = $1 AND worker_id = $2`,
    [input.jobId, input.workerId],
  );
}
