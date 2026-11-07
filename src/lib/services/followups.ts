import { getDb } from "@/lib/db/client";
import { generateFollowUp } from "@/lib/ai/writer";
import { AppError } from "@/lib/utils";
import type { Draft } from "@/lib/types";
import { listDrafts } from "./drafts";
import { getProspect } from "./prospects";
import { getWorkspaceSettings } from "./settings";
import { mapDraft } from "./mappers";
import { FOLLOW_UP_BATCH_MAX, followUpRoom, persistPreparedFollowUp, readFollowUpCandidates } from "./agent-followups";
export { FOLLOW_UP_BATCH_MAX } from "./agent-followups";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FollowUpCandidate {
  conversationId: string;
  prospectId: string;
  businessName: string;
  contactEmail: string;
  lastOutboundAt: string | null;
  daysSinceLastOutbound: number;
  sentFollowUps: number;
  nextSequence: number;
  delayDays: number;
  due: boolean;
  activeDraftId: string | null;
  status: string;
  classification: string;
}

export async function listFollowUpCandidates(): Promise<FollowUpCandidate[]> {
  const db = await getDb();
  // Preserve the public reader's bootstrap behavior; transaction guards read through their tx.
  return readFollowUpCandidates(db, await getWorkspaceSettings());
}

/**
 * The result of a preparation run, and a plain reason whenever it produced nothing.
 *
 * The button used to report "No follow-ups are due right now" for every empty outcome, including the
 * two that are not about timing at all: automatic follow-ups switched off in Settings, and the day's
 * preparation cap already used up. Those are the two most likely answers on a fresh workspace, so the
 * caller now gets the real reason and can say it.
 */
export interface PrepareFollowUpOutcome {
  drafts: Draft[];
  /** Why nothing was prepared, or null when at least one draft was created. */
  reason: string | null;
  /** How many drafts the day's cap still allowed when this run started. */
  room: number;
}


export async function prepareFollowUpDraftOutcome(input: {
  userId: string;
  prospectIds?: string[];
  /** At most this many drafts in this run (still within the day's limit). */
  limit?: number;
  /**
   * Who asked. The scheduled job honours the "Automatic follow-ups" switch; a founder click
   * (Prepare selected / Prepare next N) is itself the decision, so it works with the switch off.
   * Both stay within "Follow-ups per day", and preparing never sends anything.
   */
  trigger?: "scheduler" | "founder";
}): Promise<PrepareFollowUpOutcome> {
  const trigger = input.trigger ?? "scheduler";
  const settings = await getWorkspaceSettings();
  if (settings.followUpMax <= 0) {
    throw new AppError(
      "Follow-ups are disabled in Settings. Set a follow-up count before preparing drafts.",
      409,
    );
  }
  if (trigger === "scheduler" && !settings.followUpAutoEnabled) {
    // Off by default, so an import of hundreds of contacted leads cannot turn into hundreds of drafts
    // on the first night. The founder switches this on in Settings when the backlog should start moving.
    const candidates = await listFollowUpCandidates();
    return {
      drafts: [],
      room: 0,
      reason: candidates.some((candidate) => candidate.due)
        ? `Automatic follow-ups are switched off in Settings, so nothing was prepared. ${candidates.filter((candidate) => candidate.due).length} conversation${candidates.filter((candidate) => candidate.due).length === 1 ? " is" : "s are"} due and waiting.`
        : "Automatic follow-ups are switched off in Settings, so nothing was prepared. Nothing is due yet either.",
    };
  }
  const db0 = await getDb();
  const room = await followUpRoom(db0, settings);
  if (room === 0) {
    return {
      drafts: [],
      room: 0,
      reason: `Today's preparation limit of ${settings.followUpDailyLimit} follow-up drafts is already used. It resets with the workspace day.`,
    };
  }
  const candidates = (await listFollowUpCandidates())
    .filter(
      (candidate) =>
        candidate.due &&
        !candidate.activeDraftId &&
        (!input.prospectIds?.length ||
          input.prospectIds.includes(candidate.prospectId)),
    )
    // Newest last send first: recent contacts get a timely follow-up and the oldest backlog comes last.
    .slice(0, Math.min(room, input.limit && input.limit > 0 ? Math.floor(input.limit) : room, trigger === "founder" ? FOLLOW_UP_BATCH_MAX : room));
  const created: Draft[] = [];
  const db = await getDb();
  for (const candidate of candidates) {
    const prospect = await getProspect(candidate.prospectId);
    if (!prospect?.contactEmail) continue;
    const initial = await db.query<any>(
      `SELECT d.* FROM drafts d
       WHERE d.prospect_id = $1 AND d.kind = 'first_contact'
       ORDER BY d.created_at ASC LIMIT 1`,
      [prospect.id],
    );
    const original = initial.rows[0];
    if (!original) continue;
    const previousBodies = await db.query<{ body: string }>(
      `SELECT body FROM drafts WHERE prospect_id = $1 AND kind = 'follow_up'
       AND status IN ('sent', 'draft', 'approved') ORDER BY sequence ASC`,
      [prospect.id],
    );
    const generated = await generateFollowUp({
      prospect,
      originalSubject: original.subject,
      previousBody: original.body,
      sequence: candidate.nextSequence,
      settings,
    });

    const comparable = generated.body.replace(/\s+/g, " ").trim();
    if (
      previousBodies.rows.some(
        (row) => row.body.replace(/\s+/g, " ").trim() === comparable,
      )
    ) {
      continue;
    }
    // Generation is deliberately outside the final guarded transaction. A concurrent agent may
    // consume room, or a reply/suppression/settings edit may make this candidate ineligible.
    const result = await persistPreparedFollowUp({ prospectId: prospect.id,
      expectedSequence: candidate.nextSequence, subject: generated.subject, body: generated.body,
      actor: { actorType: "founder" }, userId: input.userId, scheduler: trigger === "scheduler",
      aiGenerated: generated.usedAi, model: generated.model, provider: generated.provider });
    if (result.status === "saved" && result.draft) created.push(result.draft);
  }
  return { drafts: created, room, reason: created.length === 0 ? "No conversation is due for a follow-up right now." : null };
}

/** Backwards-compatible entry point: the drafts only. */
export async function prepareFollowUpDrafts(input: {
  userId: string;
  prospectIds?: string[];
}): Promise<Draft[]> {
  return (await prepareFollowUpDraftOutcome(input)).drafts;
}

/** How many follow-up drafts the review list loads per step. */
export const FOLLOW_UP_DRAFT_PAGE_SIZE = 100;

export interface FollowUpDraftPage {
  rows: Draft[];
  /** Every follow-up draft in a reviewable state — the list prints this as its total. */
  total: number;
  limit: number;
  hasMore: boolean;
}

/**
 * The follow-up drafts shown for review, with the true total beside them.
 *
 * This list was capped at 100 rows and its length was presented as the count, which is the same
 * "capped page reads as the total" fault the Leads page had. The window comes from the caller (the
 * `limit` in the URL, raised by "Load more") and is clamped to the counted total.
 */
export async function listFollowUpDraftsPage(
  limit = FOLLOW_UP_DRAFT_PAGE_SIZE,
): Promise<FollowUpDraftPage> {
  const db = await getDb();
  const counted = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM drafts
      WHERE kind = 'follow_up' AND status IN ('draft', 'approved', 'sent', 'cancelled')`,
  );
  const total = Number(counted.rows[0]?.n ?? 0);
  const requested = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : FOLLOW_UP_DRAFT_PAGE_SIZE;
  const window = Math.min(requested, total);
  const result = await db.query<any>(
    `SELECT d.*, p.business_name AS prospect_name,
      (SELECT email FROM prospect_emails pe WHERE pe.prospect_id = p.id
        ORDER BY is_primary DESC LIMIT 1) AS prospect_email
     FROM drafts d JOIN prospects p ON p.id = d.prospect_id
     WHERE d.kind = 'follow_up' AND d.status IN ('draft', 'approved', 'sent', 'cancelled')
     ORDER BY CASE d.status WHEN 'draft' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
       d.updated_at DESC LIMIT $1`,
    [window],
  );
  return {
    rows: result.rows.map(mapDraft),
    total,
    limit: window,
    hasMore: window < total,
  };
}

export async function listFollowUpDrafts(): Promise<Draft[]> {
  return (await listFollowUpDraftsPage()).rows;
}

/**
 * The four counters above the Follow-ups tab.
 *
 * The draft counters are counted in SQL rather than derived from the loaded list: the list is a
 * window, so counting its rows would report "100 drafts ready" on a backlog of 300. The candidate
 * counters come from the candidate list itself, which is already uncapped (every contacted thread is
 * considered, and the list is filtered in code by reply state and suppression).
 */
export async function getFollowUpOverview(candidates?: FollowUpCandidate[]) {
  const resolved = candidates ?? (await listFollowUpCandidates());
  const db = await getDb();
  const counted = await db.query<{
    ready: number;
    approved: number;
    sent: number;
    cancelled: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE status = 'draft')::int AS ready,
       count(*) FILTER (WHERE status = 'approved')::int AS approved,
       count(*) FILTER (WHERE status = 'sent')::int AS sent,
       count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
     FROM drafts WHERE kind = 'follow_up'`,
  );
  const row = counted.rows[0];
  return {
    waiting: resolved.length,
    due: resolved.filter((candidate) => candidate.due).length,
    readyDrafts: Number(row?.ready ?? 0),
    approvedDrafts: Number(row?.approved ?? 0),
    sent: Number(row?.sent ?? 0),
    cancelled: Number(row?.cancelled ?? 0),
  };
}

export async function prepareAllFollowUps(userId: string): Promise<Draft[]> {
  return prepareFollowUpDrafts({ userId });
}

export async function listAllDraftsForEmail(): Promise<Draft[]> {
  return listDrafts();
}
