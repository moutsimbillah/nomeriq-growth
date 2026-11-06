import { getDb } from "@/lib/db/client";
import { generateFollowUp } from "@/lib/ai/writer";
import { validateDraft } from "@/lib/ai/claims";
import { AppError, iso, normalizeEmail, truncate } from "@/lib/utils";
import { addedWindow, calendarDaysBetween } from "@/lib/dates/timezone";
import type { Draft } from "@/lib/types";
import { getDraft, listDrafts } from "./drafts";
import { getProspect } from "./prospects";
import { getProductTruth, getWorkspaceSettings } from "./settings";
import { mapDraft } from "./mappers";

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
  const settings = await getWorkspaceSettings();
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT c.id AS conversation_id, c.prospect_id, c.last_outbound_at, c.status,
       c.classification, p.business_name, p.status AS prospect_status,
       p.do_not_contact,
       (SELECT pe.email FROM prospect_emails pe WHERE pe.prospect_id = p.id
         ORDER BY pe.is_primary DESC LIMIT 1) AS contact_email,
       (SELECT count(*) FROM drafts d WHERE d.prospect_id = p.id
         AND d.kind = 'follow_up' AND d.status = 'sent') AS sent_follow_ups,
       (SELECT d.id FROM drafts d WHERE d.prospect_id = p.id
         AND d.kind = 'follow_up' AND d.status IN ('draft', 'approved')
         ORDER BY d.sequence DESC LIMIT 1) AS active_draft_id,
       (SELECT max(m.created_at) FROM messages m
         WHERE m.conversation_id = c.id AND m.direction = 'inbound') AS last_inbound_at
     FROM conversations c
     JOIN prospects p ON p.id = c.prospect_id
     WHERE c.last_outbound_at IS NOT NULL AND p.archived_at IS NULL
       AND p.do_not_contact = false
       -- a lead excluded from automatic follow-ups is not suppressed, only left out of the job
       AND p.follow_up_excluded = false
     ORDER BY c.last_outbound_at DESC`,
  );
  const candidates: FollowUpCandidate[] = [];
  const now = new Date();
  for (const row of result.rows) {
    if (
      row.last_inbound_at &&
      new Date(row.last_inbound_at).getTime() >=
        new Date(row.last_outbound_at).getTime()
    ) {
      continue;
    }
    if (["unsubscribe", "not_interested"].includes(row.classification)) continue;
    if (["interested", "demo", "proposal", "won", "lost"].includes(row.prospect_status)) {
      continue;
    }
    const suppressed = row.contact_email
      ? await db.query(
          `SELECT 1 FROM suppressions WHERE normalized_email = $1 AND active = true`,
          [normalizeEmail(row.contact_email)],
        )
      : { rows: [] };
    if (suppressed.rows.length) continue;
    const sentFollowUps = Number(row.sent_follow_ups ?? 0);
    if (sentFollowUps >= settings.followUpMax) continue;
    const nextSequence = sentFollowUps + 1;
    const delayDays =
      nextSequence === 1
        ? settings.followUpDelay1Days
        : settings.followUpDelay2Days;
    const daysSince = calendarDaysBetween(
      new Date(row.last_outbound_at),
      now,
      settings.timezone,
    );
    candidates.push({
      conversationId: row.conversation_id,
      prospectId: row.prospect_id,
      businessName: row.business_name,
      contactEmail: row.contact_email,
      lastOutboundAt: iso(row.last_outbound_at),
      daysSinceLastOutbound: Math.floor(daysSince),
      sentFollowUps,
      nextSequence,
      delayDays,
      due: daysSince >= delayDays,
      activeDraftId: row.active_draft_id,
      status: row.prospect_status,
      classification: row.classification,
    });
  }
  return candidates;
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
}): Promise<PrepareFollowUpOutcome> {
  const settings = await getWorkspaceSettings();
  if (settings.followUpMax <= 0) {
    throw new AppError(
      "Follow-ups are disabled in Settings. Set a follow-up count before preparing drafts.",
      409,
    );
  }
  if (!settings.followUpAutoEnabled) {
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
  const window = addedWindow(
    "today",
    new Date(),
    undefined,
    undefined,
    settings.timezone,
  )!;
  const madeToday = await db0.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM drafts
      WHERE kind = 'follow_up' AND created_by_type = 'founder'
        AND created_at >= $1 AND created_at < $2`,
    [window.from.toISOString(), window.to.toISOString()],
  );
  const room = Math.max(0, settings.followUpDailyLimit - Number(madeToday.rows[0]?.n ?? 0));
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
    .slice(0, room);
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
    const truth = await getProductTruth();
    const warnings = validateDraft({
      subject: generated.subject,
      body: generated.body,
      recipientEmail: candidate.contactEmail,
      truth,
      aiGenerated: generated.usedAi,
    });
    const comparable = generated.body.replace(/\s+/g, " ").trim();
    if (
      previousBodies.rows.some(
        (row) => row.body.replace(/\s+/g, " ").trim() === comparable,
      )
    ) {
      continue;
    }
    const id = crypto.randomUUID();
    try {
      await db.query(
        `INSERT INTO drafts (
          id, prospect_id, research_job_id, kind, sequence, status, subject, body,
          recipient_email, ai_generated, ai_model, ai_provider, product_truth_version, warnings,
          created_by_type, created_by_user_id, created_at, updated_at
        ) VALUES ($1, $2, $3, 'follow_up', $4, 'draft', $5, $6, $7, $11, $12, $13,
          $8, $9::jsonb, 'founder', $10, now(), now())`,
        [
          id,
          prospect.id,
          prospect.researchJobId,
          candidate.nextSequence,
          generated.subject,
          generated.body,
          candidate.contactEmail,
          truth.version,
          JSON.stringify(warnings),
          input.userId,
          generated.usedAi,
          generated.model,
          generated.provider ?? null,
        ],
      );
      await db.query(
        `UPDATE prospects SET next_action = $1, updated_at = now() WHERE id = $2`,
        [
          `Review follow-up #${candidate.nextSequence} (${truncate(candidate.businessName, 40)})`,
          prospect.id,
        ],
      );
      const draft = await getDraft(id);
      if (draft) created.push(draft);
    } catch (error) {
      if (String((error as { code?: string }).code) === "23505") continue;
      throw error;
    }
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
export async function getFollowUpOverview() {
  const candidates = await listFollowUpCandidates();
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
    waiting: candidates.length,
    due: candidates.filter((candidate) => candidate.due).length,
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
