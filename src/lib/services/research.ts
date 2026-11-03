import { getDb } from "@/lib/db/client";
import { AppError, asStringArray, iso, number } from "@/lib/utils";
import type { Category, ResearchJob } from "@/lib/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const JOB_SELECT = `
  SELECT j.*,
    (SELECT count(*) FROM prospects p
      WHERE p.research_job_id = j.id AND p.qualification_status = 'verified'
        AND p.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM prospect_emails e WHERE e.prospect_id = p.id)
    ) AS verified_count,
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
    ) AS duplicates_rejected
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
    status: row.status,
    notes: row.notes,
    createdAt: iso(row.created_at) ?? "",
    completedAt: iso(row.completed_at),
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
  userId: string;
}): Promise<ResearchJob> {
  if (!input.name.trim()) throw new AppError("Give the research job a name.");
  if (input.targetCount < 1 || input.targetCount > 10_000) {
    throw new AppError("Research targets must be between 1 and 10,000.");
  }
  if (!input.categories.length) {
    throw new AppError("Select at least one category for the research job.");
  }
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO research_jobs
      (id, name, target_count, categories, regions, requirements, notes, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
    [
      id,
      input.name.trim(),
      input.targetCount,
      JSON.stringify(input.categories),
      input.regions?.trim() || "Worldwide",
      input.requirements?.trim() ||
        "Commercial trading-signal providers only, with a publicly published business email and source URL.",
      input.notes?.trim() || "",
      input.userId,
    ],
  );
  return (await getResearchJob(id))!;
}

export async function updateResearchJobStatus(
  id: string,
  status: "active" | "paused" | "completed" | "archived",
): Promise<ResearchJob> {
  const db = await getDb();
  const result = await db.query(
    `UPDATE research_jobs
     SET status = $1, completed_at = $2, updated_at = now()
     WHERE id = $3`,
    [status, status === "completed" ? new Date().toISOString() : null, id],
  );
  if (!result.rowCount) throw new AppError("Research job not found.", 404);
  return (await getResearchJob(id))!;
}

export async function refreshResearchJobStatus(jobId: string): Promise<void> {
  const job = await getResearchJob(jobId);
  if (!job) return;
  if (job.verifiedCount >= job.targetCount && job.status === "active") {
    const db = await getDb();
    await db.query(
      `UPDATE research_jobs
       SET status = 'completed', completed_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'active'`,
      [jobId],
    );
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
  totalVerified: number;
  totalDrafts: number;
  totalDuplicates: number;
  targetRemaining: number;
}> {
  const jobs = await listResearchJobs();
  return {
    activeJobs: jobs.filter((job) => job.status === "active").length,
    totalVerified: jobs.reduce((sum, job) => sum + job.verifiedCount, 0),
    totalDrafts: jobs.reduce((sum, job) => sum + job.draftCount, 0),
    totalDuplicates: jobs.reduce((sum, job) => sum + job.duplicatesRejected, 0),
    targetRemaining: jobs
      .filter((job) => job.status === "active")
      .reduce((sum, job) => sum + job.remaining, 0),
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
