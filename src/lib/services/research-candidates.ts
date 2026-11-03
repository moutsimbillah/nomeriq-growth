import { getDb, type DbClient } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import {
  asStringArray,
  domainFromUrl,
  isEmail,
  iso,
  normalizeEmail,
  normalizeName,
  normalizeWebsiteUrl,
  number,
} from "@/lib/utils";
import type { ResearchCandidate, ResearchCandidateStatus } from "@/lib/types";
import { mapResearchCandidate } from "./mappers";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** How long a claimed identity stays reserved before another worker may take it. */
export const CANDIDATE_CLAIM_TTL_SECONDS = 900;
/** A candidate is retried at most this many times before it is parked as failed. */
export const MAX_CANDIDATE_ATTEMPTS = 3;

/**
 * Builds the cross-agent identity key for a candidate. This is deliberately
 * built from a canonical domain when one exists, because the same business is
 * frequently discovered through several different search queries, and the
 * domain is the strongest single identity signal available before verification.
 */
export function candidateIdentityKey(input: {
  websiteUrl?: string | null;
  businessName?: string | null;
}): string | null {
  const domain = domainFromUrl(input.websiteUrl);
  if (domain) return `domain:${domain}`;
  const name = input.businessName?.trim();
  if (!name) return null;
  const key = normalizeName(name);
  return key ? `name:${key}` : null;
}

export async function getResearchCandidate(
  id: string,
): Promise<ResearchCandidate | null> {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT * FROM research_candidates WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapResearchCandidate(result.rows[0]) : null;
}

export async function listResearchCandidates(
  jobId: string,
  options: { status?: ResearchCandidateStatus; limit?: number } = {},
): Promise<ResearchCandidate[]> {
  const db = await getDb();
  const params: unknown[] = [jobId];
  let filter = "";
  if (options.status) {
    params.push(options.status);
    filter = ` AND status = $${params.length}`;
  }
  params.push(Math.min(Math.max(options.limit ?? 50, 1), 200));
  const result = await db.query<any>(
    `SELECT * FROM research_candidates WHERE job_id = $1${filter}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(mapResearchCandidate);
}

export interface DiscoveredCandidate {
  businessName?: string | null;
  websiteUrl?: string | null;
  sourceUrl?: string | null;
  searchQuery?: string | null;
  evidence?: Record<string, unknown>;
}

export interface DiscoveryResult {
  /** Newly recorded identities that this worker may research. */
  created: ResearchCandidate[];
  /** Identities already known to this job, so the caller can skip them. */
  existing: number;
  /** Identities another agent is researching right now. */
  claimed: number;
}

/**
 * Records search results as candidates, skipping anything already known to the
 * job. The unique (job_id, identity_key) constraint is the authority: a losing
 * racer treats the unique violation as "already discovered" rather than an
 * error, so two agents searching at once never double-record a business.
 *
 * This deliberately does not take a research claim. Claims are taken at
 * dispatch time by `claimPendingCandidates`, which is the only place that can
 * decide atomically which worker researches what. Taking a claim here would
 * immediately block that dispatch.
 */
export async function recordDiscoveredCandidates(
  jobId: string,
  candidates: DiscoveredCandidate[],
): Promise<DiscoveryResult> {
  const db = await getDb();
  const created: ResearchCandidate[] = [];
  let existing = 0;
  let claimed = 0;

  for (const candidate of candidates) {
    const identityKey = candidateIdentityKey({
      websiteUrl: candidate.websiteUrl,
      businessName: candidate.businessName,
    });
    if (!identityKey) continue;

    const id = crypto.randomUUID();
    try {
      await db.query(
        `INSERT INTO research_candidates
          (id, job_id, identity_key, business_name, website_url, domain_key,
           source_url, search_query, evidence, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'pending')`,
        [
          id,
          jobId,
          identityKey,
          candidate.businessName?.trim() || null,
          normalizeWebsiteUrl(candidate.websiteUrl) ??
            candidate.websiteUrl?.trim() ??
            null,
          domainFromUrl(candidate.websiteUrl),
          candidate.sourceUrl?.trim() || null,
          candidate.searchQuery?.trim() || null,
          JSON.stringify(candidate.evidence ?? {}),
        ],
      );
      const stored = await getResearchCandidate(id);
      if (stored) created.push(stored);
    } catch (error) {
      if (isUniqueViolation(error)) {
        existing += 1;
        continue;
      }
      throw error;
    }

    // Report, without acting on it, whether another agent currently holds this
    // identity. The claim table is intentionally job independent: one business
    // must not be researched twice at the same moment, even across jobs.
    const live = await db.query(
      `SELECT 1 FROM candidate_claims
       WHERE identity_key = $1 AND claim_expires_at > now()`,
      [identityKey],
    );
    if (live.rows.length) claimed += 1;
  }

  if (created.length) {
    await db.query(
      `UPDATE research_jobs
       SET candidates_discovered = candidates_discovered + $1, updated_at = now()
       WHERE id = $2`,
      [created.length, jobId],
    );
  }

  return { created, existing, claimed };
}

export interface ClaimResult {
  claimed: boolean;
  claimId: string | null;
  claimedBy: string | null;
  expiresAt: string | null;
}

/**
 * Takes a short-lived, database-backed claim on a business identity.
 *
 * The claim row's primary key is the identity itself, so the database — not the
 * application — decides the winner. A live claim held by another worker is
 * refused. An expired claim is taken over, which is what makes a crashed worker
 * recoverable rather than permanently blocking an identity.
 */
export async function claimCandidateIdentity(input: {
  identityKey: string;
  jobId: string;
  workerId?: string;
  businessName?: string | null;
  websiteUrl?: string | null;
  ttlSeconds?: number;
}): Promise<ClaimResult> {
  const db = await getDb();
  const workerId = input.workerId ?? "deepseek-worker";
  const ttl = Math.min(
    Math.max(input.ttlSeconds ?? CANDIDATE_CLAIM_TTL_SECONDS, 30),
    24 * 60 * 60,
  );
  const claimId = crypto.randomUUID();

  // A conditional upsert: only an expired existing claim can be overwritten.
  const result = await db.query<any>(
    `INSERT INTO candidate_claims
      (identity_key, claim_id, job_id, business_name, website_url, claimed_by,
       claim_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' seconds')::interval)
     ON CONFLICT (identity_key) DO UPDATE SET
       claim_id = excluded.claim_id,
       job_id = excluded.job_id,
       business_name = excluded.business_name,
       website_url = excluded.website_url,
       claimed_by = excluded.claimed_by,
       claim_expires_at = excluded.claim_expires_at,
       created_at = now()
     WHERE candidate_claims.claim_expires_at <= now()
     RETURNING claim_id, claimed_by, claim_expires_at`,
    [
      input.identityKey,
      claimId,
      input.jobId,
      input.businessName ?? null,
      input.websiteUrl ?? null,
      workerId,
      String(ttl),
    ],
  );

  const row = result.rows[0];
  if (row) {
    return {
      claimed: true,
      claimId: row.claim_id,
      claimedBy: row.claimed_by,
      expiresAt: iso(row.claim_expires_at),
    };
  }

  const held = await db.query<any>(
    `SELECT claim_id, claimed_by, claim_expires_at FROM candidate_claims
     WHERE identity_key = $1`,
    [input.identityKey],
  );
  const holder = held.rows[0];
  return {
    claimed: false,
    claimId: holder?.claim_id ?? null,
    claimedBy: holder?.claimed_by ?? null,
    expiresAt: iso(holder?.claim_expires_at),
  };
}

/** Releases a claim this worker owns. Safe to call twice. */
export async function releaseCandidateClaim(input: {
  identityKey: string;
  claimId?: string | null;
}): Promise<void> {
  const db = await getDb();
  if (input.claimId) {
    await db.query(
      `DELETE FROM candidate_claims WHERE identity_key = $1 AND claim_id = $2`,
      [input.identityKey, input.claimId],
    );
    return;
  }
  await db.query(`DELETE FROM candidate_claims WHERE identity_key = $1`, [
    input.identityKey,
  ]);
}

/** Removes expired claims so a crashed worker cannot block an identity. */
export async function expireStaleClaims(): Promise<number> {
  const db = await getDb();
  const result = await db.query(
    `DELETE FROM candidate_claims WHERE claim_expires_at <= now()`,
  );
  return result.rowCount;
}

export interface ClaimableCandidateOptions {
  jobId: string;
  workerId: string;
  limit?: number;
}

/**
 * Atomically claims up to `limit` pending candidates for one job.
 *
 * Selection and claiming happen in a single transaction using
 * `FOR UPDATE SKIP LOCKED`, so concurrent workers dispatch disjoint sets rather
 * than racing on the same rows.
 */
export async function claimPendingCandidates(
  options: ClaimableCandidateOptions,
): Promise<ResearchCandidate[]> {
  const db = await getDb();
  const limit = Math.min(Math.max(options.limit ?? 1, 1), 8);

  return db.transaction(async (tx) => {
    const rows = await tx.query<any>(
      `SELECT * FROM research_candidates
       WHERE job_id = $1
         AND status = 'pending'
         AND attempts < $2
       ORDER BY created_at ASC
       LIMIT $3
       FOR UPDATE SKIP LOCKED`,
      [options.jobId, MAX_CANDIDATE_ATTEMPTS, limit],
    );

    const claimed: ResearchCandidate[] = [];
    for (const row of rows.rows) {
      const claim = await claimCandidateIdentityWithin(tx, {
        identityKey: row.identity_key,
        jobId: options.jobId,
        workerId: options.workerId,
        businessName: row.business_name,
        websiteUrl: row.website_url,
      });
      if (!claim.claimed) continue;
      await tx.query(
        `UPDATE research_candidates
         SET status = 'researching', claim_id = $1, attempts = attempts + 1,
           updated_at = now()
         WHERE id = $2`,
        [claim.claimId, row.id],
      );
      claimed.push(
        mapResearchCandidate({
          ...row,
          status: "researching",
          claim_id: claim.claimId,
          attempts: number(row.attempts) + 1,
        }),
      );
    }
    return claimed;
  });
}

async function claimCandidateIdentityWithin(
  tx: DbClient,
  input: {
    identityKey: string;
    jobId: string;
    workerId: string;
    businessName?: string | null;
    websiteUrl?: string | null;
    ttlSeconds?: number;
  },
): Promise<ClaimResult> {
  const ttl = input.ttlSeconds ?? CANDIDATE_CLAIM_TTL_SECONDS;
  const claimId = crypto.randomUUID();
  const result = await tx.query<any>(
    `INSERT INTO candidate_claims
      (identity_key, claim_id, job_id, business_name, website_url, claimed_by,
       claim_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' seconds')::interval)
     ON CONFLICT (identity_key) DO UPDATE SET
       claim_id = excluded.claim_id,
       job_id = excluded.job_id,
       business_name = excluded.business_name,
       website_url = excluded.website_url,
       claimed_by = excluded.claimed_by,
       claim_expires_at = excluded.claim_expires_at,
       created_at = now()
     WHERE candidate_claims.claim_expires_at <= now()
     RETURNING claim_id`,
    [
      input.identityKey,
      claimId,
      input.jobId,
      input.businessName ?? null,
      input.websiteUrl ?? null,
      input.workerId,
      String(ttl),
    ],
  );
  const row = result.rows[0];
  return {
    claimed: Boolean(row),
    claimId: row?.claim_id ?? null,
    claimedBy: row?.claimed_by ?? null,
    expiresAt: null,
  };
}

export async function setCandidateResult(input: {
  candidateId: string;
  identityKey: string;
  jobId: string;
  status: ResearchCandidateStatus;
  prospectId?: string | null;
  draftId?: string | null;
  lastError?: string | null;
  evidence?: Record<string, unknown>;
  releaseClaim?: boolean;
}): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE research_candidates SET
         status = $1,
         prospect_id = coalesce($2, prospect_id),
         draft_id = coalesce($3, draft_id),
         last_error = $4,
         evidence = CASE WHEN $5::jsonb = '{}'::jsonb THEN evidence ELSE $5::jsonb END,
         claim_id = null,
         updated_at = now()
       WHERE id = $6`,
      [
        input.status,
        input.prospectId ?? null,
        input.draftId ?? null,
        input.lastError?.slice(0, 1000) ?? null,
        JSON.stringify(input.evidence ?? {}),
        input.candidateId,
      ],
    );
    if (input.status === "failed") {
      await tx.query(
        `UPDATE research_jobs
         SET failed_verifications = failed_verifications + 1, updated_at = now()
         WHERE id = $1`,
        [input.jobId],
      );
    }
    if (input.status === "qualified") {
      await tx.query(
        `UPDATE research_jobs SET updated_at = now() WHERE id = $1`,
        [input.jobId],
      );
    }
  });
  if (input.releaseClaim !== false) {
    await releaseCandidateClaim({ identityKey: input.identityKey });
  }
}

/**
 * Returns 'researching' rows whose claim has expired back to 'pending' so an
 * interrupted worker's work is resumed rather than lost. Bounded by attempts.
 */
export async function requeueExpiredCandidates(jobId?: string): Promise<number> {
  const db = await getDb();
  const params: unknown[] = [];
  let jobFilter = "";
  if (jobId) {
    params.push(jobId);
    jobFilter = ` AND rc.job_id = $${params.length}`;
  }
  const result = await db.query(
    `UPDATE research_candidates rc SET status = 'pending', claim_id = null,
       updated_at = now()
     WHERE rc.status = 'researching'
       AND rc.attempts < ${MAX_CANDIDATE_ATTEMPTS}
       AND NOT EXISTS (
         SELECT 1 FROM candidate_claims cc
         WHERE cc.identity_key = rc.identity_key
           AND cc.claim_expires_at > now()
       )${jobFilter}`,
    params,
  );
  return result.rowCount;
}

export function candidateDisplayName(candidate: {
  businessName: string | null;
  websiteUrl: string | null;
  domainKey: string | null;
}): string {
  return (
    candidate.businessName?.trim() ||
    candidate.domainKey ||
    candidate.websiteUrl ||
    "Unnamed candidate"
  );
}

export function candidateEvidenceEmails(evidence: unknown): string[] {
  const record = (evidence ?? {}) as Record<string, unknown>;
  const raw = record.emails;
  const list = asStringArray(raw);
  return list.filter((value) => isEmail(value)).map(normalizeEmail);
}
