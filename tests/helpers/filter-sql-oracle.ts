// Independent SQL oracle for date-range filters; never imports production helpers.
import { getDb } from "@/lib/db/client";
const DEFAULT_CLOCK = "2026-11-05T20:00:00.000Z";
const DEFAULT_ZONE = "Asia/Karachi";

type OracleDateFilter = {
  added?: string; addedFrom?: string; addedTo?: string; now?: Date; timezone?: string;
};

export function oracleDateClause(
  column: string,
  f: OracleDateFilter,
  params: unknown[],
): string | null {
  const clock = f.now ? f.now.toISOString() : DEFAULT_CLOCK;
  const zone = f.timezone || DEFAULT_ZONE;

  if (f.added === "custom") {
    // Custom ranges bind only the zone and the two dates; no clock parameter is used.
    if (!f.addedFrom || !f.addedTo) return null;
    const zoneIdx = params.push(zone);
    const lower = `$${params.push(f.addedFrom)}::date`;
    const upper = `$${params.push(f.addedTo)}::date + 1`;
    return `${column} >= ((${lower})::timestamp AT TIME ZONE $${zoneIdx})` +
      ` AND ${column} < ((${upper})::timestamp AT TIME ZONE $${zoneIdx})`;
  }

  const range = f.added;
  if (
    range !== "today" && range !== "yesterday" && range !== "last7" &&
    range !== "last30" && range !== "this_month" && range !== "last_month"
  ) {
    return null;
  }

  const clockIdx = params.push(clock);
  const zoneIdx = params.push(zone);
  const d = `($${clockIdx}::timestamptz AT TIME ZONE $${zoneIdx})::date`;

  let lower: string;
  let upper: string;
  switch (range) {
    case "today": lower = `${d}`; upper = `${d} + 1`; break;
    case "yesterday": lower = `${d} - 1`; upper = `${d}`; break;
    case "last7": lower = `${d} - 6`; upper = `${d} + 1`; break;
    case "last30": lower = `${d} - 29`; upper = `${d} + 1`; break;
    case "this_month":
      lower = `date_trunc('month', ${d})`;
      upper = `date_trunc('month', ${d}) + interval '1 month'`;
      break;
    default: // last_month
      lower = `date_trunc('month', ${d}) - interval '1 month'`;
      upper = `date_trunc('month', ${d})`;
      break;
  }
  return `${column} >= ((${lower})::timestamp AT TIME ZONE $${zoneIdx})` +
    ` AND ${column} < ((${upper})::timestamp AT TIME ZONE $${zoneIdx})`;
}

/**
 * The ids a saved view matches, read straight from the database with SQL hand-written here rather
 * than borrowed from the production builders — a test compares the two and sees a real disagreement.
 */
export async function oracleIds(
  surface: "leads" | "drafts",
  f: Record<string, any>,
): Promise<string[]> {
  const alias = surface === "leads" ? "p" : "d";
  const params: any[] = [];
  const bind = (v: any): string => `$${params.push(v)}`;
  const where: string[] = [];

  if (f.status) where.push(`${alias}.status = ${bind(f.status)}`);
  if (surface === "leads") {
    where.push("p.archived_at IS NULL");
    if (f.qualification) where.push(`p.qualification_status = ${bind(f.qualification)}`);
    if (f.category) where.push(`p.categories @> ${bind(JSON.stringify([f.category]))}::jsonb`);
    if (f.jobId) where.push(`p.research_job_id = ${bind(f.jobId)}`);
    if (typeof f.query === "string" && f.query.trim()) {
      const like = bind(`%${f.query.trim()}%`);
      where.push(
        `(p.business_name ILIKE ${like} OR p.website_url ILIKE ${like} OR p.country ILIKE ${like}` +
          ` OR EXISTS (SELECT 1 FROM prospect_emails pe WHERE pe.prospect_id = p.id AND pe.email ILIKE ${like}))`,
      );
    }
    if (f.channel) where.push(`coalesce(p.source_channel, 'unknown') = ${bind(f.channel)}`);
    if (f.hasEmail === true) {
      where.push("EXISTS (SELECT 1 FROM prospect_emails pe WHERE pe.prospect_id = p.id)");
    }
    if (f.hasEmail === false) {
      where.push("NOT EXISTS (SELECT 1 FROM prospect_emails pe WHERE pe.prospect_id = p.id)");
    }
  }
  if (f.agent) where.push(`coalesce(${alias}.source_agent, 'unknown') = ${bind(f.agent)}`);
  if (f.sender === "default") where.push("p.sending_profile_id IS NULL");
  else if (f.sender) where.push(`p.sending_profile_id = ${bind(f.sender)}`);
  const added = oracleDateClause(`${alias}.created_at`, f, params);
  if (added) where.push(added);

  const from =
    surface === "leads"
      ? "prospects p"
      : "drafts d JOIN prospects p ON p.id = d.prospect_id";
  const sql =
    `SELECT ${alias}.id AS id FROM ${from}` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY ${alias}.id`;
  const db = await getDb();
  const result = await db.query<{ id: string }>(sql, params);
  return result.rows.map((row) => row.id);
}
