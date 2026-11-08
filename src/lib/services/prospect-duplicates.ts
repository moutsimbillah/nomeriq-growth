import { getDb, type DbClient } from "@/lib/db/client";
import { assertFounder } from "@/lib/auth/session";
import { listProspects } from "@/lib/services/prospects";
import { AppError } from "@/lib/utils";
import type { SessionUser } from "@/lib/types";

/**
 * "Duplicate of" — the founder's reversible way to retire a second record of the same business.
 *
 * Marking archives the duplicate, sets do-not-contact, cancels its unsent drafts and blocks any queued
 * send, and links it to the lead that stays (the canonical lead). Nothing is deleted and nothing is
 * merged: qualification, pipeline status, messages and outcomes are left exactly as they were.
 *
 * Deliberately NO email suppression: a duplicate often shares the canonical lead's address, and an
 * address-wide suppression would silently stop outreach to the real lead.
 *
 * Every value the mark changes is stored, with exact database timestamps (`::text`), in
 * `prospect_duplicate_links.previous_state`. Restore puts the lead back only when nothing has touched
 * it since the mark (the lead row, its drafts, its send ledger and campaign items all still equal the
 * recorded post-mark state); otherwise it refuses with 409 rather than guess. Restore never approves,
 * re-queues or sends anything: the cancelled drafts and blocked sends stay as they are, and the
 * snapshot keeps their earlier states for the audit trail.
 *
 * Founder-only, and never exposed as an agent/MCP tool (AGENTS.md rule 5).
 */

export const DUPLICATE_SNAPSHOT_VERSION = 1;
const CANCEL_NOTE = "Cancelled: lead marked as a duplicate of another lead.";

type Actor = Pick<SessionUser, "id" | "role">;

interface ProspectStateRow {
  archived_at: string | null;
  do_not_contact: boolean;
  next_action: string | null;
  updated_at: string;
  status: string;
  qualification_status: string;
}

interface DraftStateRow {
  id: string;
  status: string;
  updated_at: string;
}

interface SendStateRow {
  id: string;
  draft_id: string | null;
  status: string;
  queued_at: string | null;
  error: string | null;
  completed_at: string | null;
}

interface CampaignItemStateRow {
  id: string;
  status: string;
  error: string | null;
  updated_at: string;
}

export interface DuplicateStateSet {
  prospect: ProspectStateRow;
  drafts: DraftStateRow[];
  sends: SendStateRow[];
  campaignItems: CampaignItemStateRow[];
}

/** What `previous_state` holds. `before` is restored; `after` is the exact state restore requires. */
export interface DuplicateSnapshot {
  version: typeof DUPLICATE_SNAPSHOT_VERSION;
  canonical: { id: string; businessName: string };
  before: DuplicateStateSet;
  after: DuplicateStateSet;
  cancelledDraftIds: string[];
  blockedSendIds: string[];
  skippedCampaignItemIds: string[];
}

export interface DuplicateLinkView {
  id: string;
  prospectId: string;
  prospectName: string;
  canonicalProspectId: string;
  canonicalName: string;
  /** False when the canonical lead itself has since been archived. */
  canonicalActive: boolean;
  createdAt: string;
  restoredAt: string | null;
  cancelledDrafts: number;
  blockedSends: number;
}

export interface CanonicalCandidate {
  id: string;
  businessName: string;
  domainKey: string | null;
  contactEmail: string | null;
  qualificationStatus: string;
  status: string;
}

const PROSPECT_STATE_SQL = `SELECT archived_at::text AS archived_at, do_not_contact, next_action,
  updated_at::text AS updated_at, status, qualification_status FROM prospects WHERE id = $1`;

/** Reads every row the mark may touch, locked, ordered by id so two reads compare exactly. */
async function readStateSet(tx: DbClient, prospectId: string, lock: boolean): Promise<DuplicateStateSet | null> {
  const forUpdate = lock ? " FOR UPDATE" : "";
  const prospect = await tx.query<ProspectStateRow>(`${PROSPECT_STATE_SQL}${forUpdate}`, [prospectId]);
  if (!prospect.rows[0]) return null;
  const drafts = await tx.query<DraftStateRow>(
    `SELECT id::text AS id, status, updated_at::text AS updated_at FROM drafts
      WHERE prospect_id = $1 ORDER BY id${forUpdate}`,
    [prospectId],
  );
  const sends = await tx.query<SendStateRow>(
    `SELECT id::text AS id, draft_id::text AS draft_id, status, queued_at::text AS queued_at, error,
            completed_at::text AS completed_at
       FROM outbound_sends
      WHERE prospect_id = $1 OR draft_id IN (SELECT d.id FROM drafts d WHERE d.prospect_id = $1)
      ORDER BY id${forUpdate}`,
    [prospectId],
  );
  const campaignItems = await tx.query<CampaignItemStateRow>(
    `SELECT id::text AS id, status, error, updated_at::text AS updated_at FROM campaign_items
      WHERE prospect_id = $1 ORDER BY id${forUpdate}`,
    [prospectId],
  );
  return {
    prospect: normalizeProspectState(prospect.rows[0]),
    drafts: drafts.rows,
    sends: sends.rows,
    campaignItems: campaignItems.rows,
  };
}

function normalizeProspectState(row: ProspectStateRow): ProspectStateRow {
  return {
    archived_at: row.archived_at ?? null,
    do_not_contact: Boolean(row.do_not_contact),
    next_action: row.next_action ?? null,
    updated_at: row.updated_at,
    status: row.status,
    qualification_status: row.qualification_status,
  };
}

/** Exact comparison of two recorded state sets (same keys, same order, same text timestamps). */
export function sameStateSet(a: DuplicateStateSet, b: DuplicateStateSet): boolean {
  const canon = (set: DuplicateStateSet) =>
    JSON.stringify({
      prospect: normalizeProspectState(set.prospect),
      drafts: [...set.drafts].sort((x, y) => x.id.localeCompare(y.id)).map((d) => [d.id, d.status, d.updated_at]),
      sends: [...set.sends]
        .sort((x, y) => x.id.localeCompare(y.id))
        .map((s) => [s.id, s.draft_id ?? null, s.status, s.queued_at ?? null, s.error ?? null, s.completed_at ?? null]),
      campaignItems: [...set.campaignItems]
        .sort((x, y) => x.id.localeCompare(y.id))
        .map((c) => [c.id, c.status, c.error ?? null, c.updated_at]),
    });
  return canon(a) === canon(b);
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "23505");
}

async function lockProspects(tx: DbClient): Promise<void> {
  await tx.query("LOCK TABLE prospects IN SHARE ROW EXCLUSIVE MODE");
}

async function activeLinkFor(tx: DbClient, prospectId: string) {
  const result = await tx.query<{ id: string; canonical_prospect_id: string }>(
    `SELECT id::text AS id, canonical_prospect_id::text AS canonical_prospect_id
       FROM prospect_duplicate_links WHERE prospect_id = $1 AND restored_at IS NULL`,
    [prospectId],
  );
  return result.rows[0] ?? null;
}

/**
 * Marks `prospectId` as a duplicate of `canonicalProspectId`.
 *
 * Repeating the same mark is idempotent (returns the existing link). Refused: self-links, chains (the
 * canonical is itself a duplicate, or other leads already point at the one being retired), an already
 * archived lead, an inactive canonical lead, and any send currently in flight for the lead.
 */
export async function markProspectDuplicate(input: {
  prospectId: string;
  canonicalProspectId: string;
  actor: Actor;
}): Promise<{ link: DuplicateLinkView; alreadyLinked: boolean }> {
  assertFounder(input.actor);
  const { prospectId, canonicalProspectId } = input;
  if (prospectId === canonicalProspectId) {
    throw new AppError("A lead cannot be a duplicate of itself.", 400, "duplicate_self");
  }
  const db = await getDb();
  const linkId = await db.transaction(async (tx) => {
    await lockProspects(tx);

    const existing = await activeLinkFor(tx, prospectId);
    if (existing) {
      if (existing.canonical_prospect_id === canonicalProspectId) return { id: existing.id, repeated: true };
      throw new AppError(
        "This lead is already marked as a duplicate of another lead. Restore it first.",
        409,
        "already_duplicate",
      );
    }

    const before = await readStateSet(tx, prospectId, true);
    if (!before) throw new AppError("Lead not found.", 404, "prospect_not_found");
    if (before.prospect.archived_at) {
      throw new AppError("This lead is already archived.", 409, "already_archived");
    }

    const canonical = await tx.query<{ business_name: string; archived_at: string | null }>(
      `SELECT business_name, archived_at::text AS archived_at FROM prospects WHERE id = $1`,
      [canonicalProspectId],
    );
    const target = canonical.rows[0];
    if (!target || target.archived_at) {
      throw new AppError(
        "The lead to keep must be an active, non-archived lead.",
        409,
        "canonical_unavailable",
      );
    }
    if (await activeLinkFor(tx, canonicalProspectId)) {
      throw new AppError(
        "The lead to keep is itself marked as a duplicate. Pick the lead it points to.",
        409,
        "canonical_is_duplicate",
      );
    }
    const dependants = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM prospect_duplicate_links
        WHERE canonical_prospect_id = $1 AND restored_at IS NULL`,
      [prospectId],
    );
    if (Number(dependants.rows[0]?.n ?? 0) > 0) {
      throw new AppError(
        "Other leads are marked as duplicates of this one. Restore them first so no chain is created.",
        409,
        "duplicate_chain",
      );
    }

    if (
      before.sends.some((row) => row.status === "sending") ||
      before.campaignItems.some((row) => row.status === "sending")
    ) {
      throw new AppError(
        "An email for this lead is being sent right now. Wait for it to finish, then try again.",
        409,
        "send_in_progress",
      );
    }

    const nextAction = `Duplicate of ${target.business_name}`.slice(0, 300);
    await tx.query(
      `UPDATE prospects SET archived_at = now(), do_not_contact = true, next_action = $2, updated_at = now()
        WHERE id = $1`,
      [prospectId, nextAction],
    );
    const cancelled = await tx.query<{ id: string }>(
      `UPDATE drafts SET status = 'cancelled', updated_at = now()
        WHERE prospect_id = $1 AND status IN ('draft', 'approved') RETURNING id::text AS id`,
      [prospectId],
    );
    const blocked = await tx.query<{ id: string }>(
      `UPDATE outbound_sends SET status = 'blocked', error = $2, completed_at = now()
        WHERE status = 'queued'
          AND (prospect_id = $1 OR draft_id IN (SELECT d.id FROM drafts d WHERE d.prospect_id = $1))
        RETURNING id::text AS id`,
      [prospectId, CANCEL_NOTE],
    );
    const skipped = await tx.query<{ id: string }>(
      `UPDATE campaign_items SET status = 'skipped', error = $2, updated_at = now()
        WHERE prospect_id = $1 AND status = 'queued' RETURNING id::text AS id`,
      [prospectId, CANCEL_NOTE],
    );

    const after = await readStateSet(tx, prospectId, false);
    const snapshot: DuplicateSnapshot = {
      version: DUPLICATE_SNAPSHOT_VERSION,
      canonical: { id: canonicalProspectId, businessName: target.business_name },
      before,
      after: after!,
      cancelledDraftIds: cancelled.rows.map((row) => row.id),
      blockedSendIds: blocked.rows.map((row) => row.id),
      skippedCampaignItemIds: skipped.rows.map((row) => row.id),
    };
    const id = crypto.randomUUID();
    await tx.query(
      `INSERT INTO prospect_duplicate_links
         (id, prospect_id, canonical_prospect_id, previous_state, created_by_user_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [id, prospectId, canonicalProspectId, JSON.stringify(snapshot), input.actor.id],
    );
    await tx.query(
      `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'founder', $2, 'prospect.duplicate_marked', 'prospect', $3, $4::jsonb)`,
      [
        crypto.randomUUID(),
        input.actor.id,
        prospectId,
        JSON.stringify({
          linkId: id,
          canonicalProspectId,
          cancelledDrafts: snapshot.cancelledDraftIds.length,
          blockedSends: snapshot.blockedSendIds.length,
          skippedCampaignItems: snapshot.skippedCampaignItemIds.length,
        }),
      ],
    );
    return { id, repeated: false };
  });
  const link = await getDuplicateLink(linkId.id);
  return { link: link!, alreadyLinked: linkId.repeated };
}

/**
 * Puts a duplicate back. Idempotent: restoring an already-restored lead returns its latest link.
 * Refuses (409) when anything recorded at mark time has changed since, and never revives the cancelled
 * drafts or blocked sends.
 */
export async function restoreProspectDuplicate(input: {
  prospectId: string;
  actor: Actor;
}): Promise<{ link: DuplicateLinkView; alreadyRestored: boolean }> {
  assertFounder(input.actor);
  const { prospectId } = input;
  const db = await getDb();
  const result = await db.transaction(async (tx) => {
    await lockProspects(tx);
    const active = await tx.query<{ id: string; previous_state: DuplicateSnapshot | string }>(
      `SELECT id::text AS id, previous_state FROM prospect_duplicate_links
        WHERE prospect_id = $1 AND restored_at IS NULL FOR UPDATE`,
      [prospectId],
    );
    const row = active.rows[0];
    if (!row) {
      const latest = await tx.query<{ id: string }>(
        `SELECT id::text AS id FROM prospect_duplicate_links
          WHERE prospect_id = $1 ORDER BY restored_at DESC NULLS LAST, created_at DESC LIMIT 1`,
        [prospectId],
      );
      if (!latest.rows[0]) {
        throw new AppError("This lead is not marked as a duplicate.", 404, "duplicate_not_found");
      }
      return { id: latest.rows[0].id, repeated: true };
    }
    const snapshot: DuplicateSnapshot =
      typeof row.previous_state === "string" ? JSON.parse(row.previous_state) : row.previous_state;
    if (snapshot?.version !== DUPLICATE_SNAPSHOT_VERSION) {
      throw new AppError("The stored duplicate snapshot is not readable.", 409, "duplicate_snapshot_unreadable");
    }
    const current = await readStateSet(tx, prospectId, true);
    if (!current || !sameStateSet(current, snapshot.after)) {
      throw new AppError(
        "This lead, its drafts or its sends changed after it was marked as a duplicate, so it cannot be restored automatically.",
        409,
        "duplicate_state_changed",
      );
    }
    const prior = snapshot.before.prospect;
    try {
      // Lead visibility only. Cancelled drafts and blocked sends stay as they are: nothing is approved,
      // queued or sent by a restore.
      await tx.query(
        `UPDATE prospects SET archived_at = $2::timestamptz, do_not_contact = $3, next_action = $4,
           updated_at = now() WHERE id = $1`,
        [prospectId, prior.archived_at, prior.do_not_contact, prior.next_action],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(
          "Another active lead now holds this lead's website or social identity, so it cannot be restored.",
          409,
          "duplicate_restore_conflict",
        );
      }
      throw error;
    }
    await tx.query(`UPDATE prospect_duplicate_links SET restored_at = now() WHERE id = $1`, [row.id]);
    await tx.query(
      `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'founder', $2, 'prospect.duplicate_restored', 'prospect', $3, $4::jsonb)`,
      [
        crypto.randomUUID(),
        input.actor.id,
        prospectId,
        JSON.stringify({ linkId: row.id, canonicalProspectId: snapshot.canonical.id }),
      ],
    );
    return { id: row.id, repeated: false };
  });
  const link = await getDuplicateLink(result.id);
  return { link: link!, alreadyRestored: result.repeated };
}

const LINK_SELECT = `SELECT l.id::text AS id, l.prospect_id::text AS prospect_id,
    l.canonical_prospect_id::text AS canonical_prospect_id, l.created_at::text AS created_at,
    l.restored_at::text AS restored_at, l.previous_state,
    p.business_name AS prospect_name, c.business_name AS canonical_name,
    (c.archived_at IS NULL) AS canonical_active
  FROM prospect_duplicate_links l
  JOIN prospects p ON p.id = l.prospect_id
  JOIN prospects c ON c.id = l.canonical_prospect_id`;

function mapLink(row: any): DuplicateLinkView {
  const snapshot: Partial<DuplicateSnapshot> =
    typeof row.previous_state === "string" ? JSON.parse(row.previous_state) : row.previous_state ?? {};
  return {
    id: row.id,
    prospectId: row.prospect_id,
    prospectName: row.prospect_name,
    canonicalProspectId: row.canonical_prospect_id,
    canonicalName: row.canonical_name,
    canonicalActive: Boolean(row.canonical_active),
    createdAt: row.created_at,
    restoredAt: row.restored_at ?? null,
    cancelledDrafts: snapshot.cancelledDraftIds?.length ?? 0,
    blockedSends: snapshot.blockedSendIds?.length ?? 0,
  };
}

export async function getDuplicateLink(linkId: string): Promise<DuplicateLinkView | null> {
  const db = await getDb();
  const result = await db.query<any>(`${LINK_SELECT} WHERE l.id = $1`, [linkId]);
  return result.rows[0] ? mapLink(result.rows[0]) : null;
}

/** The live "Duplicate of" link for a lead, or null when it is not currently marked. */
export async function getActiveDuplicateLink(prospectId: string): Promise<DuplicateLinkView | null> {
  const db = await getDb();
  const result = await db.query<any>(
    `${LINK_SELECT} WHERE l.prospect_id = $1 AND l.restored_at IS NULL`,
    [prospectId],
  );
  return result.rows[0] ? mapLink(result.rows[0]) : null;
}

/** Leads currently marked as duplicates of this one, newest first. */
export async function listDuplicatesOf(canonicalProspectId: string): Promise<DuplicateLinkView[]> {
  const db = await getDb();
  const result = await db.query<any>(
    `${LINK_SELECT} WHERE l.canonical_prospect_id = $1 AND l.restored_at IS NULL ORDER BY l.created_at DESC`,
    [canonicalProspectId],
  );
  return result.rows.map(mapLink);
}

/**
 * Candidates for the lead to keep: active leads matching the founder's search, excluding the lead
 * itself. Archived leads (which includes every current duplicate) are never offered.
 */
export async function searchCanonicalCandidates(
  prospectId: string,
  query: string,
): Promise<CanonicalCandidate[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  const rows = await listProspects({ query: trimmed, limit: 11, sort: "updated" });
  return rows
    .filter((row) => row.id !== prospectId)
    .slice(0, 10)
    .map((row) => ({
      id: row.id,
      businessName: row.businessName,
      domainKey: row.domainKey,
      contactEmail: row.contactEmail,
      qualificationStatus: row.qualificationStatus,
      status: row.status,
    }));
}
