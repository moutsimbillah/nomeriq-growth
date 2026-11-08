import { generatedBodyOnly, previewEmailContent } from "@/lib/email/message-content";
import { getEmailPresentation } from "./email-presentation";
import { getDb } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import { tagsFromActorType } from "@/lib/agent/agentTag";
import { recordFounderEnteredEmail } from "./prospects";
import { addedWindow, COUNTED_ADDED_RANGES, type AddedRange } from "@/lib/dates/pakistan";
import type { AgentTag, ChannelTag } from "@/lib/types";
import { generateFirstContact } from "@/lib/ai/writer";
import { validateDraft } from "@/lib/ai/claims";
import {
  AppError,
  isEmail,
  iso,
  normalizeEmail,
  truncate,
  wordCount,
} from "@/lib/utils";
import type { Draft, DraftWarning } from "@/lib/types";
import { getProspect, getProspectEmails } from "./prospects";
import { getProductTruth, getWorkspaceSettings } from "./settings";
import { recordDraftSaved } from "./research";
import { recordResearchUsage } from "./research-usage";
import { mapDraft } from "./mappers";
import { assertLeadOutreachAllowed } from "./lead-outreach-guard";

/* eslint-disable @typescript-eslint/no-explicit-any */

const DRAFT_SELECT = `
  SELECT d.*, p.business_name AS prospect_name, p.sending_profile_id AS sending_profile_id,
    (SELECT email FROM prospect_emails pe WHERE pe.prospect_id = p.id
      ORDER BY is_primary DESC LIMIT 1) AS prospect_email
  FROM drafts d
  JOIN prospects p ON p.id = d.prospect_id
`;

export async function getDraft(id: string): Promise<Draft | null> {
  const db = await getDb();
  const result = await db.query<any>(`${DRAFT_SELECT} WHERE d.id = $1`, [id]);
  return result.rows[0] ? mapDraft(result.rows[0]) : null;
}

export async function getFirstContactDraft(
  prospectId: string,
): Promise<Draft | null> {
  const db = await getDb();
  const result = await db.query<any>(
    `${DRAFT_SELECT} WHERE d.prospect_id = $1 AND d.kind = 'first_contact' LIMIT 1`,
    [prospectId],
  );
  return result.rows[0] ? mapDraft(result.rows[0]) : null;
}

export async function listDraftsForProspect(
  prospectId: string,
): Promise<Draft[]> {
  const db = await getDb();
  const result = await db.query<any>(
    `${DRAFT_SELECT} WHERE d.prospect_id = $1
     ORDER BY CASE d.kind WHEN 'first_contact' THEN 0 ELSE 1 END, d.sequence ASC`,
    [prospectId],
  );
  return result.rows.map(mapDraft);
}

export interface DraftFilters {
  /** Which agent saved the draft, normalised. Reporting only. */
  agent?: string;
  /** The lead's sending profile: a profile id, or "default" for a lead not tied to one yet. */
  sender?: string;
  /** Which workspace-zone day window it was saved in. */
  added?: AddedRange;
  addedFrom?: string;
  addedTo?: string;
  /** The workspace's IANA zone; resolved from settings when the caller omits it. */
  timezone?: string;
  /** Injectable clock, so day boundaries are testable. */
  now?: Date;
}

/** The SQL for a workspace-zone day window, pushing its two instants as params. */
function addedCondition(filters: DraftFilters, params: unknown[]): string | null {
  if (!filters.added) return null;
  const window = addedWindow(
    filters.added,
    filters.now ?? new Date(),
    filters.addedFrom,
    filters.addedTo,
    filters.timezone,
  );
  if (!window) return null;
  params.push(window.from.toISOString(), window.to.toISOString());
  return `d.created_at >= $${params.length - 1} AND d.created_at < $${params.length}`;
}

/** The row cap for one page of the Drafts list; "Load more" grows the window by this much. */
export const DRAFT_PAGE_SIZE = 120;

/** A ceiling for callers that pass their own limit to `listDrafts`. The Drafts page does not use it. */
const MAX_DRAFT_LIMIT = 200;

/** The WHERE for a draft filter, shared by the list, the count and the page. */
function draftWhere(
  status: string | undefined,
  agent: string | undefined,
  filters: DraftFilters,
): { conditions: string[]; params: unknown[] } {
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (status) {
    params.push(status);
    conditions.push(`d.status = $${params.length}`);
  }
  if (agent) {
    params.push(agent);
    conditions.push(`coalesce(d.source_agent, 'unknown') = $${params.length}`);
  }
  if (filters.sender === "default") {
    conditions.push("p.sending_profile_id IS NULL");
  } else if (filters.sender) {
    params.push(filters.sender);
    conditions.push(`p.sending_profile_id = $${params.length}`);
  }
  const added = addedCondition(filters, params);
  if (added) conditions.push(added);
  return { conditions, params };
}

const DRAFT_COUNT_SELECT = `SELECT count(*)::int AS n FROM drafts d
  JOIN prospects p ON p.id = d.prospect_id`;

export async function listDrafts(
  status?: string,
  limit = 100,
  agent?: string,
  filters: DraftFilters = {},
): Promise<Draft[]> {
  filters = {
    ...filters,
    timezone: filters.timezone ?? (await getWorkspaceSettings()).timezone,
    now: filters.now ?? new Date(),
  };
  const db = await getDb();
  const { conditions, params } = draftWhere(status, agent, filters);
  const queryParams = [...params, Math.min(Math.max(limit, 1), MAX_DRAFT_LIMIT)];
  const result = await db.query<any>(
    `${DRAFT_SELECT}
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY d.updated_at DESC LIMIT $${queryParams.length}`,
    queryParams,
  );
  return result.rows.map(mapDraft);
}

/**
 * How many drafts match the filters, over the whole set. The page size never changes this number, so
 * it is safe to print beside a capped window as its true total.
 */
export async function countDrafts(
  status?: string,
  agent?: string,
  filters: DraftFilters = {},
): Promise<number> {
  filters = {
    ...filters,
    timezone: filters.timezone ?? (await getWorkspaceSettings()).timezone,
    now: filters.now ?? new Date(),
  };
  const db = await getDb();
  const { conditions, params } = draftWhere(status, agent, filters);
  const result = await db.query<{ n: number }>(
    `${DRAFT_COUNT_SELECT}
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}`,
    params,
  );
  return Number(result.rows[0]?.n ?? 0);
}

export interface DraftListPage {
  rows: Draft[];
  /** How many drafts match the filters in total — the whole set, never just this window. */
  total: number;
  /** The window size actually used. */
  limit: number;
  /** True while matching rows remain beyond this window. */
  hasMore: boolean;
}

/**
 * One window of the Drafts list together with the true filtered total. The window never exceeds what
 * matches, so repeated "Load more" steps always reach the last row, and the total is what the header
 * shows — never the loaded rows.
 */
export async function listDraftsPage(
  status?: string,
  limit?: number,
  agent?: string,
  filters: DraftFilters = {},
): Promise<DraftListPage> {
  filters = {
    ...filters,
    timezone: filters.timezone ?? (await getWorkspaceSettings()).timezone,
    now: filters.now ?? new Date(),
  };
  const db = await getDb();
  const { conditions, params } = draftWhere(status, agent, filters);
  const total = await countDrafts(status, agent, filters);
  const requested = Math.max(limit ?? DRAFT_PAGE_SIZE, 1);
  const window = Math.min(requested, total);
  const queryParams = [...params, window];
  const result = await db.query<any>(
    `${DRAFT_SELECT}
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY d.updated_at DESC LIMIT $${queryParams.length}`,
    queryParams,
  );
  const rows = result.rows.map(mapDraft);
  return { rows, total, limit: window, hasMore: rows.length < total };
}

async function recipientIsVerified(
  prospectId: string,
  recipient: string,
): Promise<boolean> {
  const emails = await getProspectEmails(prospectId);
  return emails.some((email) => normalizeEmail(email) === normalizeEmail(recipient));
}

export async function generateDraftForProspect(input: {
  prospectId: string;
  actorType: "founder" | "chatgpt" | "claude" | "deepseek" | "api" | "seed" | "legacy";
  actorUserId?: string | null;
  force?: boolean;
  provider?: "openai" | "anthropic" | "deepseek";
}): Promise<Draft> {
  const prospect = await getProspect(input.prospectId);
  if (!prospect) throw new AppError("Prospect not found.", 404, "prospect_not_found");
  await assertLeadOutreachAllowed(prospect.id);
  if (prospect.qualificationStatus !== "verified") {
    throw new AppError(
      "A draft can only be prepared for a verified prospect.",
      409,
      "not_verified",
    );
  }
  if (!prospect.contactEmail) {
    throw new AppError(
      "This prospect has no source-confirmed contact email.",
      409,
      "no_email",
    );
  }

  const existing = await getFirstContactDraft(prospect.id);
  if (existing && !input.force) return existing;
  if (existing && input.actorType !== "founder") {
    throw new AppError(
      "An existing draft is preserved. Only the founder can regenerate it.",
      409,
      "draft_locked",
    );
  }

  const [truth, settings] = await Promise.all([
    getProductTruth(),
    getWorkspaceSettings(),
  ]);
  const generated = await generateFirstContact(prospect, truth, settings, {
    provider: input.provider,
  });
  if (generated.usage && prospect.researchJobId) {
    await recordResearchUsage({
      jobId: prospect.researchJobId,
      operation: "draft",
      model: generated.usage.model,
      inputTokens: generated.usage.inputTokens,
      cachedInputTokens: generated.usage.cachedInputTokens,
      outputTokens: generated.usage.outputTokens,
      costUsd: generated.usage.costUsd,
      metadata: { prospectId: prospect.id, usedAi: generated.usedAi },
    }).catch((error) => {
      console.error("Could not record DeepSeek draft usage", error);
    });
  }
  const warnings = validateDraft({
    subject: generated.subject,
    body: generated.body,
    recipientEmail: prospect.contactEmail,
    truth,
    aiGenerated: generated.usedAi,
  });

  const db = await getDb();
  const now = new Date().toISOString();
  let draftId = existing?.id;

  if (existing) {
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO draft_revisions
          (id, draft_id, subject, body, recipient_email, warnings, edited_by,
           edited_by_type)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [
          crypto.randomUUID(),
          existing.id,
          existing.subject,
          existing.body,
          existing.recipientEmail,
          JSON.stringify(existing.warnings),
          input.actorUserId ?? null,
          "regeneration",
        ],
      );
      await tx.query(
        `UPDATE drafts SET
          subject = $1, body = $2, recipient_email = $3, status = 'draft',
          ai_generated = $4, ai_model = $5, ai_provider = $10, product_truth_version = $6,
          warnings = $7::jsonb, founder_edited = false, approved_at = null,
          approved_by = null, updated_at = $8
         WHERE id = $9`,
        [
          generated.subject,
          generated.body,
          prospect.contactEmail,
          generated.usedAi,
          generated.model,
          truth.version,
          JSON.stringify(warnings),
          now,
          existing.id,
          generated.provider ?? null,
        ],
      );
    });
  } else {
    draftId = crypto.randomUUID();
    try {
      await db.query(
        `INSERT INTO drafts (
          id, prospect_id, research_job_id, kind, sequence, status, subject, body,
          recipient_email, ai_generated, ai_model, ai_provider, product_truth_version, warnings,
          created_by_type, created_by_user_id, created_at, updated_at
        ) VALUES ($1, $2, $3, 'first_contact', 0, 'draft', $4, $5, $6, $7, $8, $14,
          $9, $10::jsonb, $11, $12, $13, $13)`,
        [
          draftId,
          prospect.id,
          prospect.researchJobId,
          generated.subject,
          generated.body,
          prospect.contactEmail,
          generated.usedAi,
          generated.model,
          truth.version,
          JSON.stringify(warnings),
          input.actorType,
          input.actorUserId ?? null,
          now,
          generated.provider ?? null,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        return (await getFirstContactDraft(prospect.id))!;
      }
      throw error;
    }
  }

  await db.query(
    `UPDATE prospects SET status = CASE
       WHEN status = 'new' OR status = 'verified' THEN 'draft_prepared'
       ELSE status END,
       next_action = COALESCE(next_action, 'Review the personalized first-contact draft'),
       updated_at = now()
     WHERE id = $1`,
    [prospect.id],
  ).catch(() => undefined);
  await recordDraftSaved(
    prospect.researchJobId,
    prospect.id,
    input.actorType,
  );

  return (await getDraft(draftId!))!;
}

/**
 * Records which client saved a draft. Reporting only: never read for permissions, scopes or trust.
 */
async function stampSourceClient(
  draftId: string,
  sourceClient: string | null | undefined,
  agent?: AgentTag | null,
  channel?: ChannelTag | null,
): Promise<void> {
  if (!sourceClient) return;
  const db = await getDb();
  await db.query(
    `UPDATE drafts SET source_client = $1, source_agent = coalesce($3, source_agent),
            source_channel = coalesce($4, source_channel) WHERE id = $2`,
    [sourceClient, draftId, agent ?? null, channel ?? null],
  );
}

export async function savePreparedFirstContactDraft(input: {
  prospectId: string;
  subject: string;
  body: string;
  actorType: "chatgpt" | "claude" | "deepseek" | "api";
  actorUserId?: string | null;
  /** The connector that produced this draft, already sanitised. Reporting only. */
  sourceClient?: string | null;
  sourceAgent?: AgentTag | null;
  sourceChannel?: ChannelTag | null;
}): Promise<{ draft: Draft; preserved: boolean }> {
  const prospect = await getProspect(input.prospectId);
  if (!prospect) throw new AppError("Prospect not found.", 404, "prospect_not_found");
  await assertLeadOutreachAllowed(prospect.id);
  if (prospect.qualificationStatus !== "verified" || !prospect.contactEmail) {
    throw new AppError(
      "A draft needs a verified prospect with a source-confirmed email.",
      409,
      "not_verified",
    );
  }
  const existing = await getFirstContactDraft(prospect.id);
  if (existing) {
    if (
      existing.founderEdited ||
      existing.status === "approved" ||
      existing.status === "sent"
    ) {
      return { draft: existing, preserved: true };
    }
    const draft = await saveDraft({
      id: existing.id,
      subject: input.subject,
      body: input.body,
      recipientEmail: prospect.contactEmail,
      actorType: input.actorType,
      actorUserId: input.actorUserId,
    });
    await stampSourceClient(existing.id, input.sourceClient, input.sourceAgent, input.sourceChannel);
    return { draft, preserved: false };
  }
  const subject = input.subject.trim();
  const presentation = await getEmailPresentation({ prospectId: prospect.id });
  const body = generatedBodyOnly(input.body, [presentation.settings.senderSignature, presentation.profileSignature]);
  if (!subject || body.length < 20) {
    throw new AppError("A complete subject and email body are required.");
  }
  const truth = await getProductTruth();
  const warnings = validateDraft({
    subject,
    body,
    recipientEmail: prospect.contactEmail,
    truth,
    aiGenerated: true,
  });
  // Where this draft came from. An explicit tag wins; otherwise the actor type decides.
  const draftTags = { agent: input.sourceAgent ?? tagsFromActorType(input.actorType).agent,
                      channel: input.sourceChannel ?? tagsFromActorType(input.actorType).channel };
  const db = await getDb();
  const id = crypto.randomUUID();
  try {
    await db.query(
      `INSERT INTO drafts (
        id, prospect_id, research_job_id, kind, sequence, status, subject, body,
        recipient_email, ai_generated, ai_model, product_truth_version, warnings,
        created_by_type, created_by_user_id, source_client, source_agent, source_channel,
        created_at, updated_at
      ) VALUES ($1, $2, $3, 'first_contact', 0, 'draft', $4, $5, $6, true,
        $7, $8, $9::jsonb, $10, $11, $12, $13, $14, now(), now())`,
      [
        id,
        prospect.id,
        prospect.researchJobId,
        subject,
        body,
        prospect.contactEmail,
        input.actorType,
        truth.version,
        JSON.stringify(warnings),
        input.actorType,
        input.actorUserId ?? null,
        input.sourceClient ?? null,
        input.sourceAgent ?? draftTags.agent,
        input.sourceChannel ?? draftTags.channel,
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const race = await getFirstContactDraft(prospect.id);
      if (race) return { draft: race, preserved: true };
    }
    throw error;
  }
  // draft_revisions is the version history of a draft: every text it has carried, with the current
  // row holding the newest. The version created here used to be the one version missing from it, so
  // a later assistant save that replaced the draft left the original text nowhere at all.
  await db.query(
    `INSERT INTO draft_revisions
       (id, draft_id, subject, body, recipient_email, warnings, edited_by, edited_by_type)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      id,
      subject,
      body,
      prospect.contactEmail,
      JSON.stringify(warnings),
      input.actorUserId ?? null,
      input.actorType,
    ],
  );

  await db.query(
    `UPDATE prospects SET status = CASE WHEN status IN ('new', 'verified') THEN 'draft_prepared' ELSE status END,
      next_action = COALESCE(next_action, 'Review the personalized first-contact draft'),
      updated_at = now()
     WHERE id = $1`,
    [prospect.id],
  );
  await recordDraftSaved(prospect.researchJobId, prospect.id, input.actorType);
  return { draft: (await getDraft(id))!, preserved: false };
}

export async function saveDraft(input: {
  id: string;
  subject: string;
  body: string;
  recipientEmail: string;
  actorType: "founder" | "chatgpt" | "claude" | "deepseek" | "api" | "seed" | "legacy";
  actorUserId?: string | null;
}): Promise<Draft> {
  const draft = await getDraft(input.id);
  if (!draft) throw new AppError("Draft not found.", 404);
  if (draft.status === "sent") {
    throw new AppError("A sent draft cannot be edited.", 409, "draft_sent");
  }
  if (draft.status === "cancelled" || draft.status === "discarded") {
    throw new AppError("This draft is no longer active.", 409);
  }
  await assertLeadOutreachAllowed(draft.prospectId);
  if (input.actorType !== "founder" && draft.founderEdited) {
    throw new AppError(
      "The founder has edited this draft. Research assistants cannot overwrite it.",
      409,
      "founder_edited",
    );
  }
  if (input.actorType !== "founder" && draft.status === "approved") {
    throw new AppError(
      "Approved drafts can only be changed by the founder.",
      409,
      "approved_draft",
    );
  }
  const subject = input.subject.trim();
  const presentation = input.actorType === "founder" ? null : await getEmailPresentation({ prospectId: draft.prospectId });
  const body = presentation ? generatedBodyOnly(input.body, [presentation.settings.senderSignature, presentation.profileSignature]) : input.body.trim();
  const recipientEmail = normalizeEmail(input.recipientEmail);
  if (subject.length < 2) throw new AppError("Add a subject line.");
  if (body.length < 20) throw new AppError("The email body is too short.");
  if (!isEmail(recipientEmail)) {
    throw new AppError("Add a valid recipient email address.");
  }
  if (!(await recipientIsVerified(draft.prospectId, recipientEmail))) {
    // The founder typed an address the research did not find. Keep it, as a founder-entered contact,
    // rather than refusing the edit. AI-written drafts never reach here with a recipient of their own:
    // the tool path always takes the prospect's confirmed address.
    await recordFounderEnteredEmail(draft.prospectId, recipientEmail);
  }
  const truth = await getProductTruth();
  const warnings = validateDraft({
    subject,
    body,
    recipientEmail,
    truth,
    aiGenerated: false,
  });
  const changed =
    subject !== draft.subject ||
    body !== draft.body ||
    recipientEmail !== draft.recipientEmail;
  const founderEdited =
    input.actorType === "founder" ? true : draft.founderEdited;

  const db = await getDb();
  // Replacing a draft keeps the text it is replacing: draft_revisions is the version history, so a
  // second save leaves the earlier text retrievable rather than overwriting it into oblivion.
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO draft_revisions
        (id, draft_id, subject, body, recipient_email, warnings, edited_by,
         edited_by_type)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        crypto.randomUUID(),
        draft.id,
        subject,
        body,
        recipientEmail,
        JSON.stringify(warnings),
        input.actorUserId ?? null,
        input.actorType,
      ],
    );
    await tx.query(
      `UPDATE drafts SET
        subject = $1, body = $2, recipient_email = $3, warnings = $4::jsonb,
        founder_edited = $5,
        status = CASE WHEN status = 'approved' AND $6 = true THEN 'draft' ELSE status END,
        approved_at = CASE WHEN status = 'approved' AND $6 = true THEN null ELSE approved_at END,
        approved_by = CASE WHEN status = 'approved' AND $6 = true THEN null ELSE approved_by END,
        updated_at = now()
       WHERE id = $7`,
      [
        subject,
        body,
        recipientEmail,
        JSON.stringify(warnings),
        founderEdited,
        changed,
        draft.id,
      ],
    );
  });
  return (await getDraft(draft.id))!;
}

export async function approveDraft(
  id: string,
  userId: string,
): Promise<Draft> {
  const draft = await getDraft(id);
  if (!draft) throw new AppError("Draft not found.", 404);
  if (draft.status === "sent") {
    throw new AppError("This draft has already been sent.", 409);
  }
  if (!(await recipientIsVerified(draft.prospectId, draft.recipientEmail))) {
    // Same rule as the edit path: approving a draft addressed to a founder-entered contact is allowed,
    // and the address is recorded as founder-entered so the send gate agrees.
    await recordFounderEnteredEmail(draft.prospectId, draft.recipientEmail);
  }
  const db = await getDb();
  await db.query(
    `UPDATE drafts SET status = 'approved', approved_at = now(), approved_by = $1,
      updated_at = now()
     WHERE id = $2 AND status IN ('draft')`,
    [userId, id],
  );
  return (await getDraft(id))!;
}

/**
 * "Approve selected" / "Approve all": the same approval as one click per draft, for a list. Each
 * draft goes through approveDraft, so every rule still applies; one refusal does not stop the rest,
 * and every refusal comes back with its reason. Approving never sends — sending stays a separate,
 * founder-started step (a campaign, within each profile's daily limit).
 */
export async function approveDrafts(
  ids: string[],
  userId: string,
): Promise<{ approved: string[]; refused: { id: string; reason: string }[] }> {
  const approved: string[] = [];
  const refused: { id: string; reason: string }[] = [];
  for (const id of [...new Set(ids)]) {
    try {
      const draft = await approveDraft(id, userId);
      if (draft.status === "approved") approved.push(id);
      else refused.push({ id, reason: `It is ${draft.status}, not a draft awaiting approval.` });
    } catch (error) {
      refused.push({ id, reason: error instanceof Error ? error.message : "Could not approve." });
    }
  }
  return { approved, refused };
}

export async function discardDraft(id: string): Promise<void> {
  const db = await getDb();
  const result = await db.query(
    `UPDATE drafts SET status = 'discarded', updated_at = now()
     WHERE id = $1 AND status IN ('draft', 'approved')`,
    [id],
  );
  if (!result.rowCount) throw new AppError("Draft cannot be discarded.", 409);
}

export async function draftPlainText(draft: Draft): Promise<string> {
  if (draft.status === "sent") return [`To: ${draft.recipientEmail}`, `Subject: ${draft.subject}`, "", draft.body].join("\n");
  const presentation = await getEmailPresentation({ prospectId: draft.prospectId });
  return [
    `To: ${draft.recipientEmail}`,
    `Subject: ${draft.subject}`,
    "",
    previewEmailContent(draft.body, presentation.settings, presentation.profileSignature),
  ].join("\n");
}

export function draftSummary(draft: Draft): string {
  return truncate(draft.body.replace(/\n+/g, " "), 120);
}

export function draftWordCount(draft: Draft): number {
  return wordCount(draft.body);
}

export function latestWarning(draft: Draft): DraftWarning | null {
  return draft.warnings[0] ?? null;
}

/**
 * Counts for the two filters on Email, Drafts. Like the leads facets, each axis is counted with every
 * other filter applied but not its own, so an option shows what choosing it would return.
 */
export async function getDraftOriginFacets(
  status?: string,
  filters: DraftFilters = {},
): Promise<{
  agents: Record<string, number>;
  senders: Record<string, number>;
  added: Record<string, number>;
}> {
  filters = {
    ...filters,
    timezone: filters.timezone ?? (await getWorkspaceSettings()).timezone,
    now: filters.now ?? new Date(),
  };
  const db = await getDb();
  const base: string[] = [];
  const baseParams: unknown[] = [];
  if (status) {
    baseParams.push(status);
    base.push(`d.status = $${baseParams.length}`);
  }
  const where = base.length ? `WHERE ${base.join(" AND ")}` : "";

  // Each axis is counted with every other filter applied but not its own.
  const senderClause = (params: unknown[]) =>
    filters.sender === "default"
      ? "p.sending_profile_id IS NULL"
      : filters.sender
        ? (params.push(filters.sender), `p.sending_profile_id = $${params.length}`)
        : null;
  const senderJoin = "JOIN prospects p ON p.id = d.prospect_id";

  const agents: Record<string, number> = {};
  {
    const params = [...baseParams];
    const clause = senderClause(params);
    const condition = addedCondition(filters, params);
    const clauses = [clause, condition].filter(Boolean) as string[];
    const rows = await db.query<{ source_agent: string | null; n: number }>(
      `SELECT coalesce(d.source_agent, 'unknown') AS source_agent, count(*)::int AS n
         FROM drafts d ${senderJoin} ${where}${
           clauses.length ? `${where ? " AND" : "WHERE"} ${clauses.join(" AND ")}` : ""
         } GROUP BY 1`,
      params,
    );
    for (const row of rows.rows) agents[String(row.source_agent ?? "unknown")] = Number(row.n);
  }

  const senders: Record<string, number> = {};
  {
    const params = [...baseParams];
    const agentClause = filters.agent
      ? (params.push(filters.agent), `coalesce(d.source_agent, 'unknown') = $${params.length}`)
      : null;
    const condition = addedCondition(filters, params);
    const clauses = [agentClause, condition].filter(Boolean) as string[];
    const rows = await db.query<{ sender: string; n: number }>(
      `SELECT coalesce(p.sending_profile_id::text, 'default') AS sender, count(*)::int AS n
         FROM drafts d ${senderJoin} ${where}${
           clauses.length ? `${where ? " AND" : "WHERE"} ${clauses.join(" AND ")}` : ""
         } GROUP BY 1`,
      params,
    );
    for (const row of rows.rows) senders[String(row.sender ?? "default")] = Number(row.n);
  }

  const added: Record<string, number> = {};
  for (const range of COUNTED_ADDED_RANGES) {
    const params = [...baseParams];
    const agentClause = filters.agent
      ? (params.push(filters.agent), `coalesce(d.source_agent, 'unknown') = $${params.length}`)
      : null;
    const senderOnly = senderClause(params);
    const condition = addedCondition({ ...filters, added: range }, params);
    const clauses = [agentClause, senderOnly, condition].filter(Boolean) as string[];
    const rows = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM drafts d ${senderJoin} ${where}${
        clauses.length ? `${where ? " AND" : "WHERE"} ${clauses.join(" AND ")}` : ""
      }`,
      params,
    );
    added[range] = Number(rows.rows[0]?.n ?? 0);
  }

  return { agents, senders, added };
}

export async function getDraftRevisions(id: string) {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT r.*, u.name AS editor_name
     FROM draft_revisions r
     LEFT JOIN users u ON u.id = r.edited_by
     WHERE r.draft_id = $1 ORDER BY r.created_at DESC LIMIT 20`,
    [id],
  );
  return result.rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    body: row.body,
    warnings: row.warnings,
    editedByType: row.edited_by_type,
    editorName: row.editor_name,
    createdAt: iso(row.created_at),
  }));
}
