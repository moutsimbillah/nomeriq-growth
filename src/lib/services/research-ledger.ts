import { getDb } from "@/lib/db/client";

export const LEDGER_REPEAT_WINDOW_DAYS = 30;

interface QueryKeyRow {
  id: string;
}

interface RecentUseRow {
  job_id: string;
  used_at: string;
}

interface LedgerRow {
  id: string;
  job_id: string;
  query: string;
  status: string;
  result_count: number;
  new_lead_count: number;
  market: string | null;
  language: string | null;
  error: string | null;
  used_at: string | null;
  created_at: string | null;
}

export function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface LedgerEntry {
  id: string;
  jobId: string;
  query: string;
  status: string;
  resultCount: number;
  newLeadCount: number;
  market: string | null;
  language: string | null;
  error: string | null;
  usedAt: string | null;
  createdAt: string | null;
}

export async function recordQueryPlanned(input: {
  jobId: string;
  query: string;
  market?: string | null;
  language?: string | null;
}): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const query = input.query.trim();
  const queryKey = normalizeQuery(input.query);
  const market = input.market ?? null;
  const language = input.language ?? null;

  await db.query(
    `INSERT INTO research_queries (id, job_id, query, query_key, market, language, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     ON CONFLICT (job_id, query) DO UPDATE
       SET market = COALESCE(EXCLUDED.market, research_queries.market),
           language = COALESCE(EXCLUDED.language, research_queries.language)`,
    [id, input.jobId, query, queryKey, market, language],
  );

  const result = await db.query<QueryKeyRow>(
    `SELECT id FROM research_queries WHERE job_id = $1 AND query = $2`,
    [input.jobId, query],
  );

  return result.rows[0]!.id;
}

export async function markQueryRunning(input: {
  jobId: string;
  query: string;
}): Promise<void> {
  const db = await getDb();

  await db.query(
    `UPDATE research_queries
     SET status = 'running'
     WHERE job_id = $1 AND query = $2 AND status <> 'used'`,
    [input.jobId, input.query.trim()],
  );
}

export async function recordQueryOutcome(input: {
  jobId: string;
  query: string;
  status: "used" | "failed";
  resultCount?: number;
  newLeadCount?: number;
  error?: string | null;
}): Promise<void> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const query = input.query.trim();
  const queryKey = normalizeQuery(input.query);
  const resultCount = input.resultCount ?? 0;
  const newLeadCount = input.newLeadCount ?? 0;
  const error = input.error ?? null;

  await db.query(
    `INSERT INTO research_queries
       (id, job_id, query, query_key, status, result_count, new_lead_count, error, used_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8,
        CASE WHEN $5 = 'used' THEN now() ELSE NULL END)
     ON CONFLICT (job_id, query) DO UPDATE
       SET status = EXCLUDED.status,
           result_count = COALESCE(EXCLUDED.result_count, 0),
           new_lead_count = COALESCE(EXCLUDED.new_lead_count, 0),
           error = EXCLUDED.error,
           used_at = CASE WHEN EXCLUDED.status = 'used' THEN now() ELSE NULL END`,
    [id, input.jobId, query, queryKey, input.status, resultCount, newLeadCount, error],
  );
}

export async function isQueryRecentlyUsed(
  query: string,
  withinDays: number = LEDGER_REPEAT_WINDOW_DAYS,
): Promise<{ used: boolean; lastUsedAt: string | null; jobId: string | null }> {
  const db = await getDb();
  const queryKey = normalizeQuery(query);

  const result = await db.query<RecentUseRow>(
    `SELECT job_id, used_at
     FROM research_queries
     WHERE query_key = $1
       AND status = 'used'
       AND used_at IS NOT NULL
       AND used_at >= now() - ($2 || ' days')::interval
     ORDER BY used_at DESC
     LIMIT 1`,
    [queryKey, String(withinDays)],
  );

  const row = result.rows[0];
  if (!row) {
    return { used: false, lastUsedAt: null, jobId: null };
  }

  return {
    used: true,
    lastUsedAt: new Date(row.used_at).toISOString(),
    jobId: row.job_id,
  };
}

export async function getJobQueryLedger(jobId: string): Promise<LedgerEntry[]> {
  const db = await getDb();

  const result = await db.query<LedgerRow>(
    `SELECT id, job_id, query, status, result_count, new_lead_count,
            market, language, error, used_at, created_at
     FROM research_queries
     WHERE job_id = $1
     ORDER BY created_at DESC`,
    [jobId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    jobId: row.job_id,
    query: row.query,
    status: row.status,
    resultCount: Number(row.result_count),
    newLeadCount: Number(row.new_lead_count),
    market: row.market,
    language: row.language,
    error: row.error,
    usedAt: row.used_at ? new Date(row.used_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  }));
}
