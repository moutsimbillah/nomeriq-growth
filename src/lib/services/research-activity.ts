import { getDb } from "@/lib/db/client";
import { iso, number } from "@/lib/utils";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * A single line in a research job's live transcript.
 *
 * Every field is derived from a row the engine actually wrote. Nothing here is
 * invented, estimated or animated: if the transcript is empty, the engine has
 * genuinely done nothing yet.
 */
export interface ResearchActivityItem {
  id: string;
  at: string;
  kind:
    | "job"
    | "run"
    | "plan"
    | "search"
    | "found"
    | "fetch"
    | "verdict"
    | "lead"
    | "draft"
    | "duplicate"
    | "rejected"
    | "failed"
    | "spend"
    | "note";
  tone: "neutral" | "progress" | "good" | "warn" | "bad";
  title: string;
  detail: string | null;
  costUsd: number | null;
  costUnknown?: boolean;
  businessName: string | null;
}

function truncate(value: string, max = 160): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function describeEvent(row: any): ResearchActivityItem {
  const detail = (row.detail ?? {}) as Record<string, any>;
  const businessName: string | null =
    row.business_name ?? detail.businessName ?? null;
  const base = {
    id: `event:${row.id}`,
    at: iso(row.created_at) ?? "",
    costUsd: null as number | null,
    businessName,
  };

  switch (row.event_type) {
    case "job_started":
      return { ...base, kind: "job", tone: "progress", title: "Research started.", detail: null };
    case "job_resumed":
      return { ...base, kind: "job", tone: "progress", title: "Research resumed.", detail: null };
    case "job_paused":
      return {
        ...base,
        kind: "job",
        tone: "warn",
        title: "Research paused.",
        detail: detail.reason ? truncate(String(detail.reason)) : null,
      };
    case "job_budget_paused":
      return {
        ...base,
        kind: "job",
        tone: "warn",
        title: "Paused: the budget was reached.",
        detail:
          detail.spentUsd !== undefined && detail.budgetUsd !== undefined
            ? `$${Number(detail.spentUsd).toFixed(4)} of $${Number(detail.budgetUsd).toFixed(2)} spent. Progress is kept.`
            : null,
      };
    case "job_completed":
      return {
        ...base,
        kind: "job",
        tone: "good",
        title: "Target reached — research complete.",
        detail:
          detail.verifiedCount !== undefined
            ? `${detail.verifiedCount} of ${detail.target} counted leads (eligible Tier 1 / Other).`
            : null,
      };
    case "job_cancelled":
      return { ...base, kind: "job", tone: "warn", title: "Research cancelled.", detail: null };
    case "job_failed":
      return {
        ...base,
        kind: "failed",
        tone: "bad",
        title: "Research failed.",
        detail: detail.error ? truncate(String(detail.error)) : null,
      };
    case "search_completed":
      return {
        ...base,
        kind: "search",
        tone: "progress",
        title: `Searched: ${detail.query ? truncate(String(detail.query), 90) : "query"}`,
        detail:
          detail.results !== undefined
            ? `${detail.results} result(s) returned.`
            : null,
      };
    case "candidate_found":
      return {
        ...base,
        kind: "found",
        tone: "progress",
        title:
          detail.count !== undefined
            ? `Found ${detail.count} new candidate(s).`
            : "Found new candidate(s).",
        detail: Array.isArray(detail.names) && detail.names.length
          ? truncate(detail.names.join(", "), 200)
          : null,
      };
    case "fetch_completed":
      return {
        ...base,
        kind: "fetch",
        tone: "progress",
        title: businessName
          ? `Read ${detail.pages ?? "the"} page(s) for ${truncate(businessName, 60)}.`
          : "Read candidate pages.",
        detail: Array.isArray(detail.urls) && detail.urls.length
          ? truncate(detail.urls.join(", "), 200)
          : null,
      };
    case "verified_saved":
      return {
        ...base,
        kind: "lead",
        tone: "good",
        title: `Verified lead saved — ${truncate(businessName ?? "candidate", 70)}`,
        detail: null,
      };
    case "draft_saved":
      return {
        ...base,
        kind: "draft",
        tone: "good",
        title: `Draft written for ${truncate(businessName ?? "the lead", 70)}`,
        detail: "Awaiting your review. Nothing is sent.",
      };
    case "duplicate_rejected":
      return {
        ...base,
        kind: "duplicate",
        tone: "warn",
        title: `Duplicate blocked — ${truncate(
          String(detail.attemptedName ?? businessName ?? "candidate"),
          70,
        )}`,
        detail: detail.existingName
          ? `Already recorded as ${truncate(String(detail.existingName), 70)}.`
          : null,
      };
    case "candidate_rejected":
      return {
        ...base,
        kind: "rejected",
        tone: "warn",
        title: `Not qualified — ${truncate(businessName ?? "candidate", 70)}`,
        detail: detail.reason ? truncate(String(detail.reason), 200) : null,
      };
    case "candidate_failed":
      return {
        ...base,
        kind: "failed",
        tone: "bad",
        title: `Could not verify ${truncate(businessName ?? "candidate", 70)}`,
        detail: detail.error ? truncate(String(detail.error), 200) : null,
      };
    case "candidate_saved":
      return {
        ...base,
        kind: "lead",
        tone: "good",
        title: `Candidate saved — ${truncate(businessName ?? "prospect", 70)}`,
        detail: null,
      };
    default:
      return {
        ...base,
        kind: "note",
        tone: "neutral",
        title: truncate(String(row.event_type).replace(/_/g, " "), 90),
        detail:
          detail.reason || detail.error || detail.step
            ? truncate(String(detail.reason ?? detail.error ?? detail.step), 200)
            : null,
      };
  }
}

function describeUsage(row: any): ResearchActivityItem {
  const metadata = (row.metadata ?? {}) as Record<string, any>;
  const costUsd = row.cost_known === false ? null : number(row.cost_usd);
  const base = {
    id: `usage:${row.id}`,
    at: iso(row.created_at) ?? "",
    costUsd,
    costUnknown: row.cost_known === false,
    businessName: null as string | null,
  };
  const failed = row.status === "error";

  if (row.operation === "search") {
    return {
      ...base,
      kind: "search",
      tone: failed ? "bad" : "progress",
      title: failed
        ? `Search failed${metadata.query ? `: ${truncate(String(metadata.query), 80)}` : ""}`
        : `Searched the web${metadata.query ? `: ${truncate(String(metadata.query), 80)}` : ""}`,
      detail: failed
        ? metadata.error
          ? truncate(String(metadata.error), 200)
          : null
        : metadata.results !== undefined
          ? `${metadata.results} result(s).`
          : null,
    };
  }
  if (row.operation === "fetch") {
    const pages = Array.isArray(metadata.pages) ? metadata.pages : [];
    return {
      ...base,
      kind: "fetch",
      tone: failed ? "bad" : "progress",
      title: failed ? "Could not read the official page." : `Read ${number(row.request_count)} page(s) from the official site.`,
      detail: pages.length ? truncate(pages.join(", "), 200) : null,
    };
  }
  return {
    ...base,
    kind: "verdict",
    tone: failed ? "bad" : "progress",
    title:
      row.operation === "draft"
        ? failed ? "Draft model request failed." : "Requested a personalized draft."
        : failed ? "Verification model request failed." : "Asked the model for a verdict on the evidence.",
    detail: row.model ? `Model: ${row.model}` : null,
  };
}

function describeRun(row: any): ResearchActivityItem {
  const started = iso(row.started_at) ?? "";
  const processed = number(row.processed);
  const saved = number(row.saved);
  const errors = number(row.errors);

  // Summarise what the step actually did, so "a step ran" is never a blank line.
  const did: string[] = [];
  if (processed) did.push(`${processed} candidate(s) checked`);
  if (saved) did.push(`${saved} lead(s) saved`);
  if (errors) did.push(`${errors} failed`);
  const summary = did.length ? did.join(", ") + "." : null;

  const label =
    row.status === "completed"
      ? "Step finished."
      : row.status === "interrupted"
        ? "Step was interrupted — it will resume."
        : row.status === "failed"
          ? "Step failed."
          : "Working…";
  return {
    id: `run:${row.id}:${row.status}`,
    at: iso(row.ended_at ?? row.last_heartbeat_at ?? row.started_at) ?? started,
    kind: "run",
    tone:
      row.status === "failed"
        ? "bad"
        : row.status === "interrupted"
          ? "warn"
          : row.status === "running"
            ? "progress"
            : "neutral",
    title: label,
    detail: row.stop_reason
      ? truncate(String(row.stop_reason), 200)
      : summary,
    costUsd: null,
    businessName: null,
  };
}

/**
 * Builds the live transcript for one research job.
 *
 * Read-only and bounded: a fixed number of rows per source, merged and sorted.
 * The caller polls this while a job is active, so it must stay cheap.
 */
export async function getResearchActivity(
  jobId: string,
  limit = 60,
): Promise<ResearchActivityItem[]> {
  const db = await getDb();
  const capped = Math.min(Math.max(limit, 1), 200);

  const [events, usage, runs, candidates] = await Promise.all([
    db.query<any>(
      `SELECT ev.*, p.business_name
       FROM research_events ev
       LEFT JOIN prospects p ON p.id = ev.prospect_id
       WHERE ev.job_id = $1
       ORDER BY ev.created_at DESC LIMIT $2`,
      [jobId, capped],
    ),
    db.query<any>(
      `SELECT * FROM research_usage WHERE job_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [jobId, capped],
    ),
    db.query<any>(
      `SELECT * FROM research_runs WHERE job_id = $1
       ORDER BY started_at DESC LIMIT 10`,
      [jobId],
    ),
    db.query<any>(
      `SELECT id, business_name, status, last_error, updated_at
       FROM research_candidates
       WHERE job_id = $1 AND status IN ('failed', 'rejected')
       ORDER BY updated_at DESC LIMIT 20`,
      [jobId],
    ),
  ]);

  // A search writes both a `search_completed` event and a `research_usage` row
  // describing the same physical request, and a fetch does the same. Rendering
  // both would show every operation twice, so each event claims its matching
  // usage row: the event supplies the human description, the usage row supplies
  // the real cost. A usage row no event claims is still shown, so an operation
  // that errored before its event could be written is never hidden.
  const claimedUsage = new Set<string>();
  const eventItems = events.rows.map((row: any) => {
    const item = describeEvent(row);
    const detail = (row.detail ?? {}) as Record<string, any>;
    const wanted =
      row.event_type === "search_completed"
        ? { operation: "search", key: "query", value: String(detail.query ?? "").trim() }
        : row.event_type === "fetch_completed"
          ? {
              operation: "fetch",
              key: "businessName",
              value: String(detail.businessName ?? "").trim(),
            }
          : null;
    if (!wanted) return item;
    const match = usage.rows.find((usageRow: any) => {
      if (claimedUsage.has(usageRow.id)) return false;
      if (usageRow.operation !== wanted.operation) return false;
      const metadata = (usageRow.metadata ?? {}) as Record<string, any>;
      if (wanted.operation === "search") {
        return String(metadata.query ?? "").trim() === wanted.value;
      }
      // Fetch usage rows do not carry the business name, so match on the pages
      // actually read, which the event records too. This keeps a rejection's cost
      // attached to the right candidate instead of to whichever came first.
      const urls = Array.isArray(detail.urls) ? detail.urls.map(String) : [];
      const pages = Array.isArray(metadata.pages) ? metadata.pages.map(String) : [];
      return urls.length > 0 && pages.length > 0 && urls.some((url) => pages.includes(url));
    });
    if (!match) return item;
    claimedUsage.add(match.id);
    return { ...item, costUsd: match.cost_known === false ? null : number(match.cost_usd), costUnknown: match.cost_known === false };
  });

  const usageItems = usage.rows
    .filter((row: any) => !claimedUsage.has(row.id))
    .map(describeUsage);

  const items: ResearchActivityItem[] = [
    ...eventItems,
    ...usageItems,
    ...runs.rows.map(describeRun),
    ...candidates.rows.map((row: any) => ({
      id: `candidate:${row.id}`,
      at: iso(row.updated_at) ?? "",
      kind: row.status === "failed" ? ("failed" as const) : ("rejected" as const),
      tone: row.status === "failed" ? ("bad" as const) : ("warn" as const),
      title:
        row.status === "failed"
          ? `Could not verify ${truncate(row.business_name ?? "candidate", 70)}`
          : `Not qualified — ${truncate(row.business_name ?? "candidate", 70)}`,
      detail: row.last_error ? truncate(String(row.last_error), 200) : null,
      costUsd: null,
      businessName: row.business_name ?? null,
    })),
  ];

  return items
    .filter((item) => item.at)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, capped);
}
