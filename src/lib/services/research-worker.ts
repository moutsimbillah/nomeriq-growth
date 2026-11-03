import {
  runResearchTick,
  selectNextResearchJob,
  touchJobWorker,
  type EngineOptions,
} from "@/lib/services/research-engine";
import { listResearchJobs, getResearchJob } from "@/lib/services/research";
import { getWorkspaceSettings } from "@/lib/services/settings";
import { markStaleRunsInterrupted } from "@/lib/services/research-runs";
import type { ResearchTickResult } from "@/lib/types";

/**
 * The durable worker entry point.
 *
 * One invocation advances one due job by one bounded tick. All state lives in
 * PostgreSQL, so a request timeout, a redeploy or a crashed process simply
 * means the next invocation continues where this one stopped. A completed or
 * cancelled job is never restarted from zero.
 */
export async function runWorker(input: {
  /** Restrict the worker to one job, or let it pick the next due active job. */
  jobId?: string | null;
  options?: EngineOptions;
} = {}): Promise<ResearchTickResult & { pickedJobId: string | null }> {
  // Surface crashed workers as interrupted before starting new work.
  await markStaleRunsInterrupted().catch(() => 0);

  let jobId = input.jobId ?? null;
  if (!jobId) {
    jobId = await selectNextResearchJob();
  }

  if (!jobId) {
    return {
      jobId: null,
      pickedJobId: null,
      status: "idle",
      processed: 0,
      saved: 0,
      duplicates: 0,
      rejected: 0,
      failed: 0,
      searches: 0,
      fetches: 0,
      modelCalls: 0,
      spentUsd: 0,
      stopReason: "No active DeepSeek research job is due.",
      notes: [],
    };
  }

  const result = await runResearchTick(jobId, input.options);
  await touchJobWorker(jobId).catch(() => undefined);
  return { ...result, pickedJobId: jobId };
}

/**
 * How many due jobs one cron invocation may advance. Bounded so a single
 * invocation cannot run unbounded work; tunable through the environment.
 */
export function resolveWorkerMaxJobs(): number {
  const raw = Number(process.env.RESEARCH_WORKER_MAX_JOBS);
  if (!Number.isFinite(raw) || raw < 1) return 3;
  return Math.min(Math.floor(raw), 10);
}

/**
 * Advances every due active job by one tick, bounded by `maxJobs`, so a single
 * cron invocation cannot run unbounded work.
 */
export async function runWorkerForAllDueJobs(input: {
  maxJobs?: number;
  options?: EngineOptions;
} = {}): Promise<{
  ticks: ResearchTickResult[];
  interruptedRuns: number;
}> {
  const interruptedRuns = await markStaleRunsInterrupted().catch(() => 0);
  const maxJobs = Math.min(Math.max(input.maxJobs ?? resolveWorkerMaxJobs(), 1), 10);
  const jobs = await listResearchJobs();
  const due = jobs.filter((job) => job.status === "active" && job.engine === "deepseek");

  const ticks: ResearchTickResult[] = [];
  for (const job of due.slice(0, maxJobs)) {
    ticks.push(await runResearchTick(job.id, input.options));
    await touchJobWorker(job.id).catch(() => undefined);
  }
  return { ticks, interruptedRuns };
}

/** A compact, honest progress snapshot used by the UI and API. */
export async function researchProgress(jobId: string) {
  const job = await getResearchJob(jobId);
  if (!job) return null;
  const settings = await getWorkspaceSettings();
  return {
    job,
    budget: {
      budgetUsd: job.budgetUsd,
      spentUsd: job.spentUsd,
      remainingUsd: Math.max(0, job.budgetUsd - job.spentUsd),
      exhausted: job.spentUsd >= job.budgetUsd - 1e-9,
    },
    settings: {
      researchDefaultBudgetUsd: settings.researchDefaultBudgetUsd,
      researchDefaultConcurrency: settings.researchDefaultConcurrency,
      deepseekSearchQps: settings.deepseekSearchQps,
      deepseekFetchQps: settings.deepseekFetchQps,
    },
  };
}
