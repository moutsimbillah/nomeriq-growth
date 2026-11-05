import { getDb } from "@/lib/db/client";
import { buildFollowUp } from "@/lib/ai/writer";
import { validateDraft } from "@/lib/ai/claims";
import { AppError, iso, normalizeEmail, truncate } from "@/lib/utils";
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
     ORDER BY c.last_outbound_at DESC`,
  );
  const candidates: FollowUpCandidate[] = [];
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
    const daysSince =
      (Date.now() - new Date(row.last_outbound_at).getTime()) / 86_400_000;
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

export async function prepareFollowUpDrafts(input: {
  userId: string;
  prospectIds?: string[];
}): Promise<Draft[]> {
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
    return [];
  }
  const db0 = await getDb();
  const madeToday = await db0.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM drafts
      WHERE kind = 'follow_up' AND created_by_type = 'founder'
        AND created_at >= date_trunc('day', now())`,
  );
  const room = Math.max(0, settings.followUpDailyLimit - Number(madeToday.rows[0]?.n ?? 0));
  if (room === 0) return [];
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
    const generated = buildFollowUp({
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
      aiGenerated: false,
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
          recipient_email, ai_generated, ai_model, product_truth_version, warnings,
          created_by_type, created_by_user_id, created_at, updated_at
        ) VALUES ($1, $2, $3, 'follow_up', $4, 'draft', $5, $6, $7, false, null,
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
  return created;
}

export async function listFollowUpDrafts(): Promise<Draft[]> {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT d.*, p.business_name AS prospect_name,
      (SELECT email FROM prospect_emails pe WHERE pe.prospect_id = p.id
        ORDER BY is_primary DESC LIMIT 1) AS prospect_email
     FROM drafts d JOIN prospects p ON p.id = d.prospect_id
     WHERE d.kind = 'follow_up' AND d.status IN ('draft', 'approved', 'sent', 'cancelled')
     ORDER BY CASE d.status WHEN 'draft' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
       d.updated_at DESC LIMIT 100`,
  );
  return result.rows.map(mapDraft);
}

export async function getFollowUpOverview() {
  const candidates = await listFollowUpCandidates();
  const drafts = await listFollowUpDrafts();
  return {
    waiting: candidates.length,
    due: candidates.filter((candidate) => candidate.due).length,
    readyDrafts: drafts.filter((draft) => draft.status === "draft").length,
    approvedDrafts: drafts.filter((draft) => draft.status === "approved").length,
    sent: drafts.filter((draft) => draft.status === "sent").length,
    cancelled: drafts.filter((draft) => draft.status === "cancelled").length,
  };
}

export async function prepareAllFollowUps(userId: string): Promise<Draft[]> {
  return prepareFollowUpDrafts({ userId });
}

export async function listAllDraftsForEmail(): Promise<Draft[]> {
  return listDrafts();
}
