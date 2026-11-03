import { getDb } from "@/lib/db/client";
import { getProspect, saveProspect, checkDuplicate } from "@/lib/services/prospects";
import { generateDraftForProspect } from "@/lib/services/drafts";
import { getProductTruth, getWorkspaceSettings } from "@/lib/services/settings";
import {
  claimPendingCandidates,
  recordDiscoveredCandidates,
  releaseCandidateClaim,
  requeueExpiredCandidates,
  setCandidateResult,
  expireStaleClaims,
  candidateDisplayName,
  type DiscoveryResult,
} from "@/lib/services/research-candidates";
import {
  getResearchJob,
  refreshResearchJobStatus,
  recordResearchEvent,
} from "@/lib/services/research";
import { recordResearchUsage } from "@/lib/services/research-usage";
import {
  getJobBudget,
  finishResearchRun,
  heartbeatResearchRun,
  markStaleRunsInterrupted,
  startResearchRun,
  DEEPSEEK_WORKER_ID,
} from "@/lib/services/research-runs";
import { planResearchQueries } from "@/lib/services/research-queries";
import { verifyCandidate } from "@/lib/deepseek/verify-candidate";
import { resolveResearchProvider, type ResearchProvider } from "@/lib/deepseek/research-provider";
import type { Category, ResearchJob, ResearchTickResult } from "@/lib/types";
import { domainFromUrl } from "@/lib/utils";

/* eslint-disable @typescript-eslint/no-explicit-any */

const SEARCH_RESULTS_PER_QUERY = 10;
const MAX_QUERIES_PER_TICK = 3;

export interface EngineOptions {
  /** Injected in tests; resolved from stored/env credentials when omitted. */
  provider?: ResearchProvider;
  workerId?: string;
  /** Caps verification work in one tick so a cron invocation stays bounded. */
  maxCandidatesPerTick?: number;
  searchQps?: number;
  fetchQps?: number;
}

/**
 * Runs one bounded unit of autonomous research for a single job.
 *
 * Everything the engine needs to continue lives in PostgreSQL: the job, its
 * candidates, its claims, the query plan offset and its spend. A tick that is
 * interrupted can therefore be repeated safely, and a restart never begins a
 * completed job from zero.
 */
export async function runResearchTick(
  jobId: string,
  options: EngineOptions = {},
): Promise<ResearchTickResult> {
  const workerId = options.workerId ?? DEEPSEEK_WORKER_ID;
  const notes: string[] = [];
  const result: ResearchTickResult = {
    jobId,
    status: "unknown",
    processed: 0,
    saved: 0,
    duplicates: 0,
    rejected: 0,
    failed: 0,
    searches: 0,
    fetches: 0,
    modelCalls: 0,
    spentUsd: 0,
    stopReason: null,
    notes,
  };

  const job = await getResearchJob(jobId);
  if (!job) {
    result.status = "missing";
    result.stopReason = "Research job not found.";
    return result;
  }
  if (job.engine !== "deepseek") {
    result.status = job.status;
    result.stopReason = "This job is not a DeepSeek engine job.";
    return result;
  }

  // Terminal states are never restarted from zero.
  if (job.status === "completed" || job.status === "cancelled") {
    result.status = job.status;
    result.stopReason =
      job.status === "completed"
        ? "Target already reached."
        : "Job was cancelled.";
    return result;
  }
  if (job.status !== "active") {
    result.status = job.status;
    result.stopReason = "Job is not active.";
    return result;
  }
  if (job.verifiedCount >= job.targetCount) {
    await refreshResearchJobStatus(jobId);
    result.status = "completed";
    result.stopReason = "Target reached.";
    return result;
  }

  // Recover work stranded by an interrupted worker before doing anything new.
  await markStaleRunsInterrupted().catch(() => 0);
  const requeued = await requeueExpiredCandidates(jobId).catch(() => 0);
  if (requeued) notes.push(`Requeued ${requeued} candidate(s) from an expired claim.`);
  await expireStaleClaims().catch(() => 0);

  const budget = await getJobBudget(jobId);
  if (!budget) {
    result.status = "failed";
    result.stopReason = "Research job not found.";
    return result;
  }
  if (budget.exhausted) {
    await pauseForBudget(jobId, budget.spentUsd, budget.budgetUsd, notes);
    result.status = "budget_paused";
    result.stopReason = `Budget exhausted ($${budget.spentUsd.toFixed(4)} of $${budget.budgetUsd.toFixed(2)}).`;
    return result;
  }

  const settings = await getWorkspaceSettings();
  let provider = options.provider ?? null;
  if (!provider) {
    const resolved = await resolveResearchProvider({
      searchQps: options.searchQps ?? settings.deepseekSearchQps,
      fetchQps: options.fetchQps ?? settings.deepseekFetchQps,
    });
    if (!resolved.provider) {
      const message =
        resolved.error ?? "DeepSeek is not configured for autonomous research.";
      await pauseForProviderFailure(jobId, message, notes);
      result.status = "paused";
      result.stopReason = message;
      return result;
    }
    provider = resolved.provider;
  }

  const runId = await startResearchRun({ jobId, workerId });
  notes.push(`Worker run ${runId} started as ${workerId}.`);

  try {
    const summary = await executeTick({
      job,
      provider,
      runId,
      workerId,
      budgetRemainingUsd: budget.remainingUsd,
      maxCandidates: Math.min(
        Math.max(options.maxCandidatesPerTick ?? job.concurrency, 1),
        8,
      ),
      result,
    });

    await finishResearchRun({
      runId,
      status: "completed",
      stopReason: summary.stopReason,
    });
    await refreshResearchJobStatus(jobId);
    const after = await getResearchJob(jobId);
    result.status = after?.status ?? job.status;
    result.stopReason = summary.stopReason ?? result.stopReason;
    result.spentUsd = after?.spentUsd ?? result.spentUsd;
    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Research tick failed.";
    result.status = "failed";
    result.stopReason = message;
    result.failed += 1;
    await finishResearchRun({ runId, status: "failed", stopReason: message });
    await getDb()
      .then((db) =>
        db.query(
          `UPDATE research_jobs
           SET last_error = $1, stopped_at = now(), status = 'failed',
             stop_reason = $2, updated_at = now()
           WHERE id = $3 AND status = 'active'`,
          [message.slice(0, 1000), message.slice(0, 500), jobId],
        ),
      )
      .catch(() => undefined);
    await recordResearchEvent(jobId, "job_failed", {
      detail: { error: message },
      actorType: "deepseek",
    }).catch(() => undefined);
    return result;
  }
}

async function pauseForBudget(
  jobId: string,
  spentUsd: number,
  budgetUsd: number,
  notes: string[],
): Promise<void> {
  const message = `Budget exhausted: $${spentUsd.toFixed(4)} of $${budgetUsd.toFixed(2)} spent. Progress preserved.`;
  const db = await getDb();
  await db.query(
    `UPDATE research_jobs
     SET status = 'budget_paused', stopped_at = now(), stop_reason = $1,
       updated_at = now()
     WHERE id = $2 AND status = 'active'`,
    [message, jobId],
  );
  await recordResearchEvent(jobId, "job_budget_paused", {
    detail: { spentUsd, budgetUsd },
    actorType: "deepseek",
  }).catch(() => undefined);
  notes.push(message);
}

async function pauseForProviderFailure(
  jobId: string,
  message: string,
  notes: string[],
): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE research_jobs
     SET status = 'paused', stopped_at = now(), stop_reason = $1, last_error = $1,
       updated_at = now()
     WHERE id = $2 AND status = 'active'`,
    [message.slice(0, 1000), jobId],
  );
  await recordResearchEvent(jobId, "job_paused", {
    detail: { reason: message },
    actorType: "deepseek",
  }).catch(() => undefined);
  notes.push(`Paused: ${message}`);
}

interface TickInput {
  job: ResearchJob;
  provider: ResearchProvider;
  runId: string;
  workerId: string;
  budgetRemainingUsd: number;
  maxCandidates: number;
  result: ResearchTickResult;
}

interface TickSummary {
  stopReason: string | null;
}

async function executeTick(input: TickInput): Promise<TickSummary> {
  const { job, provider, runId, result } = input;
  let stopReason: string | null = null;

  // 1) Top up discovery first when the pending queue is thin, so a single tick
  //    both finds and researches rather than needing two cron invocations.
  const pending = await countJobCandidates(job.id);
  const pendingCount = (pending.pending ?? 0) + (pending.researching ?? 0);
  if (pendingCount < input.maxCandidates) {
    const discovery = await discoverMore({ job, provider, result });
    if (discovery.stopReason) stopReason = discovery.stopReason;
  } else {
    result.notes.push(
      `Skipping discovery: ${pendingCount} candidate(s) already queued.`,
    );
  }

  // 2) Dispatch work already discovered but not yet researched.
  const claimed = await claimPendingCandidates({
    jobId: job.id,
    workerId: input.workerId,
    limit: input.maxCandidates,
  });

  if (!claimed.length) {
    if (!stopReason) {
      result.notes.push("No claimable candidates remained for this tick.");
    }
    return { stopReason };
  }

  result.notes.push(`Claimed ${claimed.length} candidate(s) to research.`);
  for (const candidate of claimed) {
    const spent = await getJobBudget(job.id);
    if (!spent || spent.exhausted) {
      // Hand the claim back so the work is not lost when budget is topped up.
      await releaseCandidateClaim({
        identityKey: candidate.identityKey,
        claimId: candidate.claimId ?? null,
      });
      await setCandidateResult({
        candidateId: candidate.id,
        identityKey: candidate.identityKey,
        jobId: job.id,
        status: "pending",
        releaseClaim: false,
      }).catch(() => undefined);
      stopReason = `Budget reached during this tick ($${spent?.spentUsd.toFixed(4) ?? "?"}).`;
      break;
    }
    const processed = await researchCandidate({
      job,
      provider,
      candidate,
      result,
    });
    await heartbeatResearchRun(runId, {
      processed: 1,
      saved: processed.saved ? 1 : 0,
      errors: processed.error ? 1 : 0,
    });
    if (processed.stop) {
      stopReason = processed.stop;
      break;
    }
  }

  return { stopReason };
}

async function discoverMore(input: {
  job: ResearchJob;
  provider: ResearchProvider;
  result: ResearchTickResult;
}): Promise<{ stopReason: string | null }> {
  const { job, provider, result } = input;
  const db = await getDb();

  // Continue deeper into the query plan each tick; only restart the plan once
  // the whole plan has been consumed, and never repeat an identical query
  // within the same cycle.
  const offset = job.searchQueriesUsed;
  const plan = planResearchQueries({
    categories: job.categories,
    regions: job.regions,
    offset,
    limit: MAX_QUERIES_PER_TICK,
  });

  if (!plan.length) {
    if (offset === 0) {
      result.notes.push("The query plan produced no usable queries.");
      return { stopReason: "No usable search queries could be generated." };
    }
    // Full cycle consumed. Reset so a still-unmet target can be retried with
    // refreshed results rather than stopping forever.
    await db.query(
      `UPDATE research_jobs SET search_queries_used = 0, updated_at = now()
       WHERE id = $1`,
      [job.id],
    );
    result.notes.push(
      `Query plan of ${offset} queries consumed without reaching the target.`,
    );
    const remaining = Math.max(0, job.targetCount - job.verifiedCount);
    return {
      stopReason:
        `Search plan exhausted with ${job.verifiedCount}/${job.targetCount} verified ` +
        `(${remaining} still needed). Sources did not yield more qualifying providers.`,
    };
  }

  let discoveredTotal = 0;
  for (const planned of plan) {
    const spent = await getJobBudget(job.id);
    if (!spent || spent.exhausted) {
      return {
        stopReason: `Budget exhausted during search ($${spent?.spentUsd.toFixed(4) ?? "?"}).`,
      };
    }

    let search;
    try {
      search = await provider.search({
        query: planned.query,
        count: SEARCH_RESULTS_PER_QUERY,
      });
      result.searches += 1;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Search request failed.";
      result.notes.push(`Search failed for "${planned.query}": ${message}`);
      await recordResearchUsage({
        jobId: job.id,
        operation: "search",
        model: provider.model,
        requestCount: 0,
        costUsd: 0,
        status: "error",
        metadata: { query: planned.query, error: message.slice(0, 300) },
      }).catch(() => undefined);
      await db.query(
        `UPDATE research_jobs SET search_queries_used = search_queries_used + 1,
           updated_at = now() WHERE id = $1`,
        [job.id],
      );
      continue;
    }

    await recordResearchUsage({
      jobId: job.id,
      operation: "search",
      model: provider.model,
      costUsd: search.costUsd,
      metadata: { query: planned.query, results: search.results.length },
    }).catch(() => undefined);

    await db.query(
      `UPDATE research_jobs SET search_queries_used = search_queries_used + 1,
         last_worker_at = now(), updated_at = now() WHERE id = $1`,
      [job.id],
    );
    await recordResearchEvent(job.id, "search_completed", {
      detail: { query: planned.query, results: search.results.length },
      actorType: "deepseek",
    }).catch(() => undefined);

    const candidates = search.results
      .filter((entry) => entry.url && domainFromUrl(entry.url))
      .map((entry) => ({
        businessName: entry.title || null,
        websiteUrl: entry.url,
        sourceUrl: entry.url,
        searchQuery: planned.query,
        evidence: {
          snippet: entry.snippet,
          summary: entry.summary,
          siteName: entry.siteName,
          authority: entry.authority,
          rerankScore: entry.rerankScore,
          market: planned.market,
          language: planned.language,
        },
      }));

    const discovery: DiscoveryResult = await recordDiscoveredCandidates(
      job.id,
      candidates,
    );
    discoveredTotal += discovery.created.length;
    result.notes.push(
      `"${planned.query}" → ${search.results.length} result(s), ` +
        `${discovery.created.length} new, ${discovery.existing} known, ${discovery.claimed} claimed elsewhere.`,
    );
  }

  result.notes.push(`Discovered ${discoveredTotal} new candidate(s) this tick.`);
  if (!discoveredTotal) {
    return {
      stopReason: null,
    };
  }
  return { stopReason: null };
}

async function researchCandidate(input: {
  job: ResearchJob;
  provider: ResearchProvider;
  candidate: {
    id: string;
    identityKey: string;
    businessName: string | null;
    websiteUrl: string | null;
    sourceUrl: string | null;
    claimId?: string | null;
  };
  result: ResearchTickResult;
}): Promise<{ saved: boolean; error: boolean; stop: string | null }> {
  const { job, provider, candidate, result } = input;
  const label = candidateDisplayName({
    businessName: candidate.businessName,
    websiteUrl: candidate.websiteUrl,
    domainKey: domainFromUrl(candidate.websiteUrl),
  });

  if (!candidate.websiteUrl) {
    await setCandidateResult({
      candidateId: candidate.id,
      identityKey: candidate.identityKey,
      jobId: job.id,
      status: "failed",
      lastError: "No website URL was discovered for this candidate.",
      releaseClaim: true,
    });
    result.failed += 1;
    result.processed += 1;
    return { saved: false, error: true, stop: null };
  }

  // Cheap, live duplicate gate before spending any fetch/model budget.
  const pre = await checkDuplicate({
    businessName: candidate.businessName,
    websiteUrl: candidate.websiteUrl,
  });
  if (pre.length) {
    await setCandidateResult({
      candidateId: candidate.id,
      identityKey: candidate.identityKey,
      jobId: job.id,
      status: "duplicate",
      prospectId: pre[0].prospect.id,
      lastError: null,
      evidence: { duplicateOf: pre[0].prospect.id, reasons: pre[0].reasons },
      releaseClaim: true,
    });
    // Record the rejection so database-derived progress counts it. The race path
    // below relies on saveProspect, which records its own event.
    await recordResearchEvent(job.id, "duplicate_rejected", {
      prospectId: pre[0].prospect.id,
      detail: {
        attemptedName: candidate.businessName,
        existingName: pre[0].prospect.businessName,
        reasons: pre[0].reasons,
        stage: "pre_check",
      },
      actorType: "deepseek",
    }).catch(() => undefined);
    result.duplicates += 1;
    result.processed += 1;
    return { saved: false, error: false, stop: null };
  }

  let verified;
  try {
    verified = await verifyCandidate({
      provider,
      businessName: candidate.businessName,
      websiteUrl: candidate.websiteUrl,
      requirements: job.requirements,
      categories: job.categories as Category[],
    });
    result.fetches += verified.pages.length;
    result.modelCalls += verified.usage ? 1 : 0;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Verification failed.";
    await setCandidateResult({
      candidateId: candidate.id,
      identityKey: candidate.identityKey,
      jobId: job.id,
      status: "failed",
      lastError: message,
      releaseClaim: true,
    });
    result.failed += 1;
    result.processed += 1;
    return { saved: false, error: true, stop: null };
  }

  // Record the real Fetch and model spend for this candidate. Fetch is billed
  // per successful request, so only pages actually retrieved are charged.
  if (verified.fetchCostUsd > 0 || verified.usage) {
    await recordResearchUsage({
      jobId: job.id,
      operation: "fetch",
      model: provider.model,
      requestCount: verified.pages.length,
      costUsd: verified.fetchCostUsd,
      metadata: {
        candidateId: candidate.id,
        pages: verified.pages.map((page) => page.url),
      },
    }).catch(() => undefined);
  }
  if (verified.usage) {
    await recordResearchUsage({
      jobId: job.id,
      operation: "chat",
      model: verified.usage.model,
      inputTokens: verified.usage.inputTokens,
      outputTokens: verified.usage.outputTokens,
      costUsd: verified.usage.costUsd,
      metadata: { candidateId: candidate.id, purpose: "signal_verification" },
    }).catch(() => undefined);
  }

  if (!verified.qualified || !verified.contactEmail || !verified.emailSourceUrl) {
    await setCandidateResult({
      candidateId: candidate.id,
      identityKey: candidate.identityKey,
      jobId: job.id,
      status: "rejected",
      lastError: verified.reason,
      evidence: {
        reason: verified.reason,
        pages: verified.pages.map((page) => page.url),
        emailsFound: verified.extractedEmails.map((entry) => entry.email),
      },
      releaseClaim: true,
    });
    result.rejected += 1;
    result.processed += 1;
    await recordResearchEvent(job.id, "candidate_rejected", {
      detail: { businessName: label, reason: verified.reason },
      actorType: "deepseek",
    }).catch(() => undefined);
    return { saved: false, error: false, stop: null };
  }

  const sources = verified.pages.map((page, index) => ({
    url: page.url,
    label:
      index === 0
        ? "Official website"
        : page.url.toLowerCase().includes("pric") ||
            page.url.toLowerCase().includes("plan")
          ? "Official pricing page"
          : "Official page",
    observedAt: new Date().toISOString(),
    notes: verified.evidenceSummary ?? undefined,
  }));

  let saved;
  try {
    saved = await saveProspect({
      businessName: verified.businessName ?? label,
      websiteUrl: verified.websiteUrl,
      country: verified.country,
      categories: verified.categories.length
        ? verified.categories
        : (job.categories as Category[]),
      signalDescription: verified.signalDescription,
      pricingDetails: verified.pricingDetails,
      evidenceSummary: verified.evidenceSummary,
      researchNotes: [
        verified.observation,
        `Verified automatically by the DeepSeek research engine.`,
        `Source pages: ${verified.pages.map((page) => page.url).join(", ")}`,
      ]
        .filter(Boolean)
        .join("\n"),
      email: verified.contactEmail,
      emailSourceUrl: verified.emailSourceUrl,
      emailSourceType: "official_website",
      sources,
      researchJobId: job.id,
      qualificationStatus: "verified",
      actorType: "deepseek",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Saving the lead failed.";
    await setCandidateResult({
      candidateId: candidate.id,
      identityKey: candidate.identityKey,
      jobId: job.id,
      status: "failed",
      lastError: message,
      releaseClaim: true,
    });
    result.failed += 1;
    result.processed += 1;
    return { saved: false, error: true, stop: null };
  }

  if (!saved.created || saved.duplicate) {
    // Lost a race with another agent between the pre-check and persistence.
    // That is a successful deduplication, not an error.
    await setCandidateResult({
      candidateId: candidate.id,
      identityKey: candidate.identityKey,
      jobId: job.id,
      status: "duplicate",
      prospectId: saved.prospect.id,
      evidence: { matchedOn: saved.matchedOn ?? [], race: true },
      releaseClaim: true,
    });
    result.duplicates += 1;
    result.processed += 1;
    return { saved: false, error: false, stop: null };
  }

  const prospectId = saved.prospect.id;
  result.saved += 1;
  result.processed += 1;

  // Draft generation is best effort: a saved verified lead is still valuable
  // even if drafting fails, and the failure is recorded rather than hidden.
  let draftId: string | null = null;
  try {
    const draft = await generateDraftForProspect({
      prospectId,
      actorType: "deepseek",
      provider: "deepseek",
    });
    draftId = draft.id;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Draft generation failed.";
    input.result.notes.push(`Draft failed for ${label}: ${message}`);
    await recordResearchEvent(job.id, "note", {
      prospectId,
      detail: { step: "draft_failed", error: message },
      actorType: "deepseek",
    }).catch(() => undefined);
  }

  await setCandidateResult({
    candidateId: candidate.id,
    identityKey: candidate.identityKey,
    jobId: job.id,
    status: "qualified",
    prospectId,
    draftId,
    evidence: {
      businessName: verified.businessName,
      email: verified.contactEmail,
      pages: verified.pages.map((page) => page.url),
      observation: verified.observation,
    },
    releaseClaim: true,
  });

  const current = await getResearchJob(job.id);
  const stop =
    current && current.verifiedCount >= current.targetCount
      ? "Target reached."
      : null;
  return { saved: true, error: false, stop };
}

/* --------------------------------- helpers -------------------------------- */

export async function countJobCandidates(jobId: string) {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT status, count(*) AS count FROM research_candidates
     WHERE job_id = $1 GROUP BY status`,
    [jobId],
  );
  return Object.fromEntries(
    result.rows.map((row) => [row.status, Number(row.count)]),
  ) as Record<string, number>;
}

export async function listJobCandidatePage(
  jobId: string,
  limit = 25,
): Promise<{ label: string; status: string; updatedAt: string }[]> {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT business_name, website_url, domain_key, status, updated_at
     FROM research_candidates WHERE job_id = $1
     ORDER BY updated_at DESC LIMIT $2`,
    [jobId, Math.min(Math.max(limit, 1), 100)],
  );
  return result.rows.map((row) => ({
    label: candidateDisplayName({
      businessName: row.business_name,
      websiteUrl: row.website_url,
      domainKey: row.domain_key,
    }),
    status: row.status,
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

/** Picks the job the worker should advance next: oldest active, due to run. */
export async function selectNextResearchJob(): Promise<string | null> {
  const db = await getDb();
  const result = await db.query<{ id: string }>(
    `SELECT id FROM research_jobs
     WHERE engine = 'deepseek' AND status = 'active'
       AND next_run_at <= now()
     ORDER BY coalesce(last_worker_at, created_at) ASC
     LIMIT 1`,
  );
  return result.rows[0]?.id ?? null;
}

export async function touchJobWorker(jobId: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE research_jobs SET last_worker_at = now(), next_run_at = now(),
       updated_at = now() WHERE id = $1`,
    [jobId],
  );
}

export { getProductTruth, getProspect };
