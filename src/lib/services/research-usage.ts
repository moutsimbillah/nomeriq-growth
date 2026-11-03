import { getDb } from "@/lib/db/client";
import { number } from "@/lib/utils";

export type ResearchOperation = "search" | "fetch" | "chat" | "draft";

export interface UsageInput {
  jobId?: string | null;
  /** Which provider served the call; defaults to the single legacy 'deepseek' value. */
  provider?: string | null;
  operation: ResearchOperation;
  model?: string | null;
  requestCount?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  costUsd: number;
  status?: "success" | "error";
  metadata?: Record<string, unknown>;
}

export async function recordResearchUsage(input: UsageInput): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO research_usage
        (id, job_id, provider, operation, model, request_count, input_tokens,
         cached_input_tokens, output_tokens, cost_usd, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
      [
        crypto.randomUUID(),
        input.jobId ?? null,
        input.provider ?? "deepseek",
        input.operation,
        input.model ?? null,
        input.requestCount ?? 1,
        input.inputTokens ?? 0,
        input.cachedInputTokens ?? 0,
        input.outputTokens ?? 0,
        Math.max(0, input.costUsd),
        input.status ?? "success",
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    if (input.jobId) {
      await tx.query(
        `UPDATE research_jobs SET spent_usd = spent_usd + $1, updated_at = now()
         WHERE id = $2`,
        [Math.max(0, input.costUsd), input.jobId],
      );
    }
  });
}

export async function getResearchUsage(jobId: string) {
  const db = await getDb();
  const [totals, recent] = await Promise.all([
    db.query<any>(
      `SELECT
        coalesce(sum(cost_usd), 0) AS cost_usd,
        coalesce(sum(request_count), 0) AS requests,
        coalesce(sum(input_tokens), 0) AS input_tokens,
        coalesce(sum(output_tokens), 0) AS output_tokens,
        count(*) FILTER (WHERE operation = 'search') AS searches,
        count(*) FILTER (WHERE operation = 'fetch') AS fetches,
        count(*) FILTER (WHERE operation = 'chat' OR operation = 'draft') AS model_calls
       FROM research_usage WHERE job_id = $1`,
      [jobId],
    ),
    db.query<any>(
      `SELECT operation, model, request_count, input_tokens, output_tokens,
        cost_usd, status, created_at
       FROM research_usage WHERE job_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [jobId],
    ),
  ]);
  const row = totals.rows[0] ?? {};
  return {
    costUsd: number(row.cost_usd),
    requests: number(row.requests),
    inputTokens: number(row.input_tokens),
    outputTokens: number(row.output_tokens),
    searches: number(row.searches),
    fetches: number(row.fetches),
    modelCalls: number(row.model_calls),
    recent: recent.rows.map((entry) => ({
      operation: entry.operation,
      model: entry.model,
      requestCount: number(entry.request_count),
      inputTokens: number(entry.input_tokens),
      outputTokens: number(entry.output_tokens),
      costUsd: number(entry.cost_usd),
      status: entry.status,
      createdAt: entry.created_at ? new Date(entry.created_at).toISOString() : null,
    })),
  };
}

export async function getAllResearchUsage() {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT
      coalesce(sum(cost_usd), 0) AS cost_usd,
      count(*) AS calls,
      count(*) FILTER (WHERE created_at >= now() - interval '24 hours') AS calls_24h,
      coalesce(sum(cost_usd) FILTER (WHERE created_at >= now() - interval '24 hours'), 0) AS cost_24h
     FROM research_usage`,
  );
  const row = result.rows[0] ?? {};
  return {
    costUsd: number(row.cost_usd),
    calls: number(row.calls),
    calls24h: number(row.calls_24h),
    cost24h: number(row.cost_24h),
  };
}
