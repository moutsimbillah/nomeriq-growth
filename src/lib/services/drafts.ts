import { getDb } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
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

/* eslint-disable @typescript-eslint/no-explicit-any */

const DRAFT_SELECT = `
  SELECT d.*, p.business_name AS prospect_name,
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

export async function listDrafts(
  status?: string,
  limit = 100,
): Promise<Draft[]> {
  const db = await getDb();
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (status) {
    params.push(status);
    conditions.push(`d.status = $${params.length}`);
  }
  params.push(Math.min(limit, 200));
  const result = await db.query<any>(
    `${DRAFT_SELECT}
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY d.updated_at DESC LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(mapDraft);
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
  actorType: "founder" | "chatgpt" | "claude" | "deepseek" | "api" | "seed";
  actorUserId?: string | null;
  force?: boolean;
  provider?: "openai" | "anthropic" | "deepseek";
}): Promise<Draft> {
  const prospect = await getProspect(input.prospectId);
  if (!prospect) throw new AppError("Prospect not found.", 404);
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
          ai_generated = $4, ai_model = $5, product_truth_version = $6,
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
        ],
      );
    });
  } else {
    draftId = crypto.randomUUID();
    try {
      await db.query(
        `INSERT INTO drafts (
          id, prospect_id, research_job_id, kind, sequence, status, subject, body,
          recipient_email, ai_generated, ai_model, product_truth_version, warnings,
          created_by_type, created_by_user_id, created_at, updated_at
        ) VALUES ($1, $2, $3, 'first_contact', 0, 'draft', $4, $5, $6, $7, $8,
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
): Promise<void> {
  if (!sourceClient) return;
  const db = await getDb();
  await db.query(`UPDATE drafts SET source_client = $1 WHERE id = $2`, [sourceClient, draftId]);
}

export async function savePreparedFirstContactDraft(input: {
  prospectId: string;
  subject: string;
  body: string;
  actorType: "chatgpt" | "claude" | "deepseek" | "api";
  actorUserId?: string | null;
  /** The connector that produced this draft, already sanitised. Reporting only. */
  sourceClient?: string | null;
}): Promise<{ draft: Draft; preserved: boolean }> {
  const prospect = await getProspect(input.prospectId);
  if (!prospect) throw new AppError("Prospect not found.", 404);
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
    await stampSourceClient(existing.id, input.sourceClient);
    return { draft, preserved: false };
  }
  const subject = input.subject.trim();
  const body = input.body.trim();
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
  const db = await getDb();
  const id = crypto.randomUUID();
  try {
    await db.query(
      `INSERT INTO drafts (
        id, prospect_id, research_job_id, kind, sequence, status, subject, body,
        recipient_email, ai_generated, ai_model, product_truth_version, warnings,
        created_by_type, created_by_user_id, source_client, created_at, updated_at
      ) VALUES ($1, $2, $3, 'first_contact', 0, 'draft', $4, $5, $6, true,
        $7, $8, $9::jsonb, $10, $11, $12, now(), now())`,
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
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const race = await getFirstContactDraft(prospect.id);
      if (race) return { draft: race, preserved: true };
    }
    throw error;
  }
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
  actorType: "founder" | "chatgpt" | "claude" | "deepseek" | "api" | "seed";
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
  const body = input.body.trim();
  const recipientEmail = normalizeEmail(input.recipientEmail);
  if (subject.length < 2) throw new AppError("Add a subject line.");
  if (body.length < 20) throw new AppError("The email body is too short.");
  if (!isEmail(recipientEmail)) {
    throw new AppError("Add a valid recipient email address.");
  }
  if (!(await recipientIsVerified(draft.prospectId, recipientEmail))) {
    throw new AppError(
      "The recipient must match a publicly sourced, verified email on this prospect.",
      422,
      "unverified_recipient",
    );
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
    throw new AppError(
      "The recipient is not a verified public contact email.",
      422,
    );
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
  return [
    `To: ${draft.recipientEmail}`,
    `Subject: ${draft.subject}`,
    "",
    draft.body,
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
