import { z } from "zod";
import { getDb, type DbClient } from "@/lib/db/client";
import { validateDraft } from "@/lib/ai/claims";
import { tagsFromActorType } from "@/lib/agent/agentTag";
import { addedWindow, calendarDaysBetween, DEFAULT_TIMEZONE, isValidTimezone } from "@/lib/dates/timezone";
import { AppError, isEmail, iso, truncate } from "@/lib/utils";
import type { AgentTag, ChannelTag } from "@/lib/types";
import { mapDraft, mapProductTruth } from "./mappers";
import type { FollowUpCandidate } from "./followups";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const FOLLOW_UP_BATCH_MAX = 50;

type FollowUpSettings = {
  followUpMax: number; followUpDailyLimit: number; followUpDelay1Days: number;
  followUpDelay2Days: number; followUpAutoEnabled: boolean; timezone: string;
};

/** Read through the caller's transaction: never call a root-client service inside a PGlite tx. */
export async function readFollowUpSettings(db: DbClient, lock = false): Promise<FollowUpSettings> {
  const { rows } = await db.query<any>(`SELECT * FROM workspace_settings WHERE id = 'default'${lock ? " FOR UPDATE" : ""}`);
  const row = rows[0];
  if (!row) throw new AppError("Workspace settings are not initialized.", 409, "settings_missing");
  return {
    followUpMax: Number(row.follow_up_max), followUpDailyLimit: Number(row.follow_up_daily_limit),
    followUpDelay1Days: Number(row.follow_up_delay_1_days), followUpDelay2Days: Number(row.follow_up_delay_2_days),
    followUpAutoEnabled: row.follow_up_auto_enabled === true,
    timezone: isValidTimezone(row.timezone) ? row.timezone : DEFAULT_TIMEZONE,
  };
}

/** Shared by listing AND the final INSERT snapshot, so late replies/suppressions cannot bypass it. */
const FOLLOW_UP_CANDIDATE_SQL = `
    SELECT p.id AS prospect_id, p.business_name, p.status, c.id AS conversation_id, c.classification,
      pe.email AS contact_email, activity.last_outbound_at,
      (SELECT count(*) FROM drafts d WHERE d.prospect_id=p.id AND d.kind='follow_up' AND d.status='sent') AS sent_follow_ups,
      (SELECT max(sequence) FROM drafts d WHERE d.prospect_id=p.id AND d.kind='follow_up' AND d.status='sent') AS last_sequence,
      (SELECT d.id FROM drafts d WHERE d.prospect_id=p.id AND d.kind='follow_up'
        AND (d.status IN ('draft','approved') OR d.sequence = COALESCE((SELECT max(s.sequence) FROM drafts s
          WHERE s.prospect_id=p.id AND s.kind='follow_up' AND s.status='sent'),0)+1)
        ORDER BY d.sequence DESC LIMIT 1) AS active_draft_id
    FROM prospects p
    JOIN LATERAL (SELECT co.* FROM conversations co WHERE co.prospect_id=p.id
      ORDER BY COALESCE((SELECT max(COALESCE(m.sent_at,m.received_at)) FROM messages m
        WHERE m.conversation_id=co.id AND m.direction='outbound'),co.last_outbound_at) DESC NULLS LAST, co.id LIMIT 1) c ON true
    JOIN LATERAL (SELECT email FROM prospect_emails WHERE prospect_id=p.id ORDER BY is_primary DESC,id LIMIT 1) pe ON true
    JOIN LATERAL (
      SELECT
        COALESCE(GREATEST((SELECT max(COALESCE(m.sent_at,m.received_at)) FROM messages m
          WHERE m.direction='outbound' AND (m.prospect_id=p.id OR m.conversation_id IN (SELECT id FROM conversations WHERE prospect_id=p.id))),
          (SELECT max(sent_at) FROM drafts WHERE prospect_id=p.id AND status='sent')),
          (SELECT max(last_outbound_at) FROM conversations WHERE prospect_id=p.id)) AS last_outbound_at,
        COALESCE((SELECT max(COALESCE(m.received_at,m.sent_at)) FROM messages m
          WHERE m.direction='inbound' AND (m.prospect_id=p.id OR m.conversation_id IN (SELECT id FROM conversations WHERE prospect_id=p.id))),
          (SELECT max(last_inbound_at) FROM conversations WHERE prospect_id=p.id)) AS last_inbound_at
    ) activity ON true
    WHERE ($1::uuid IS NULL OR p.id=$1) AND p.archived_at IS NULL
      AND NOT p.do_not_contact AND NOT p.follow_up_excluded
      AND p.status NOT IN ('replied','interested','demo','proposal','won','lost')
      AND NOT EXISTS (SELECT 1 FROM conversations co WHERE co.prospect_id=p.id AND co.classification IN ('unsubscribe','not_interested'))
      AND NOT EXISTS (SELECT 1 FROM prospect_emails e JOIN suppressions s
        ON (s.normalized_email=lower(trim(e.email)) OR s.normalized_email=e.normalized_email)
          AND s.active=true WHERE e.prospect_id=p.id)
      -- An undated inbound is not proof that the thread is unanswered. Fail closed rather than
      -- treating its import/created time as the message date or silently ignoring a possible reply.
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.direction='inbound'
        AND COALESCE(m.received_at,m.sent_at) IS NULL
        AND (m.prospect_id=p.id OR m.conversation_id IN (SELECT id FROM conversations WHERE prospect_id=p.id)))
      AND activity.last_outbound_at IS NOT NULL
      AND (activity.last_inbound_at IS NULL OR activity.last_inbound_at < activity.last_outbound_at)
    ORDER BY activity.last_outbound_at DESC,p.id`;

/** One row per lead. Actual mail chronology wins over cached/imported conversation timestamps. */
export async function readFollowUpCandidates(db: DbClient, settings: FollowUpSettings, prospectId?: string): Promise<FollowUpCandidate[]> {
  const { rows } = await db.query<any>(FOLLOW_UP_CANDIDATE_SQL, [prospectId ?? null]);
  return rows.flatMap((row) => {
    const nextSequence = Math.max(Number(row.sent_follow_ups), Number(row.last_sequence ?? 0)) + 1;
    if (nextSequence > settings.followUpMax || !isEmail(row.contact_email)) return [];
    const delayDays = nextSequence === 1 ? settings.followUpDelay1Days : settings.followUpDelay2Days;
    const days = calendarDaysBetween(new Date(row.last_outbound_at), new Date(), settings.timezone);
    return [{ conversationId: row.conversation_id, prospectId: row.prospect_id, businessName: row.business_name,
      contactEmail: row.contact_email, lastOutboundAt: iso(row.last_outbound_at), daysSinceLastOutbound: Math.floor(days),
      sentFollowUps: Number(row.sent_follow_ups), nextSequence, delayDays, due: days >= delayDays,
      activeDraftId: row.active_draft_id, status: row.status, classification: row.classification }];
  });
}

export async function followUpRoom(db: DbClient, settings: FollowUpSettings): Promise<number> {
  const window = addedWindow("today", new Date(), undefined, undefined, settings.timezone)!;
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM drafts
    WHERE kind='follow_up' AND created_at >= $1 AND created_at < $2`, [window.from.toISOString(), window.to.toISOString()]);
  return Math.max(0, settings.followUpDailyLimit - Number(rows[0]?.n ?? 0));
}

export interface AgentFollowUpActor {
  actorType: "chatgpt" | "claude" | "deepseek" | "api";
  actorKeyId?: string | null; sourceClient?: string | null;
  sourceAgent?: AgentTag; sourceChannel?: ChannelTag;
}
export interface AgentFollowUpDraftInput { prospectId: string; expectedSequence: number; subject: string; body: string }
export interface AgentFollowUpSaveResult {
  prospectId: string; status: "saved" | "preserved" | "refused";
  draftId?: string; code?: string; reason?: string;
}

const schema = z.object({
  drafts: z.array(z.object({ prospectId: z.string().uuid(), expectedSequence: z.number().int().min(1).max(2),
    subject: z.string().trim().min(2).max(200), body: z.string().trim().min(20).max(20000) }).strict()).min(1).max(FOLLOW_UP_BATCH_MAX)
    .refine((rows) => new Set(rows.map((r) => r.prospectId.toLowerCase())).size === rows.length),
  actor: z.object({ actorType: z.enum(["chatgpt","claude","deepseek","api"]),
    actorKeyId: z.string().min(1).max(300).nullable().optional(), sourceClient: z.string().max(120).nullable().optional(),
    sourceAgent: z.enum(["claude","chatgpt","gemini","hermes","deepseek","other","unknown"]).optional(),
    sourceChannel: z.enum(["mcp_oauth","api_key","engine"]).optional() }).strict(),
}).strict();

type PreparedFollowUp = AgentFollowUpDraftInput & {
  actor: { actorType: AgentFollowUpActor["actorType"] | "founder"; actorKeyId?: string | null;
    sourceClient?: string | null; sourceAgent?: AgentTag; sourceChannel?: ChannelTag };
  userId?: string; aiGenerated?: boolean; model?: string | null; provider?: string | null;
  scheduler?: boolean;
};

/** Shared final guard for agents AND founder/scheduler. No model calls or root-client reads here. */
export async function persistPreparedFollowUp(input: PreparedFollowUp): Promise<AgentFollowUpSaveResult & { draft?: ReturnType<typeof mapDraft> }> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    // A common workspace row serializes every preparer; count and INSERT are in this same tx.
    const settings = await readFollowUpSettings(tx, true);
    await tx.query(`SELECT id FROM prospects WHERE id=$1 FOR UPDATE`, [input.prospectId]);
    const existing = await tx.query<{ id: string }>(`SELECT id FROM drafts WHERE prospect_id=$1 AND kind='follow_up' AND sequence=$2`, [input.prospectId,input.expectedSequence]);
    if (existing.rows[0]) return { prospectId: input.prospectId, status: "preserved", draftId: existing.rows[0].id };
    const refuse = (code: string, reason: string): AgentFollowUpSaveResult => ({ prospectId: input.prospectId, status: "refused", code, reason });
    if (input.scheduler && !settings.followUpAutoEnabled) return refuse("automatic_disabled", "Automatic follow-ups are disabled.");
    const candidate = (await readFollowUpCandidates(tx,settings,input.prospectId))[0];
    if (!candidate) return refuse("not_eligible", "This lead is no longer eligible for a follow-up.");
    if (candidate.nextSequence !== input.expectedSequence) return refuse("stale_sequence", "The expected follow-up sequence is stale.");
    if (!candidate.due) return refuse("not_due", "The follow-up delay has not elapsed.");
    if (candidate.activeDraftId) return refuse("draft_waiting", "An existing follow-up draft is waiting.");
    if (await followUpRoom(tx,settings) === 0) return refuse("daily_limit", "The daily follow-up preparation limit is used.");
    const truthRow = (await tx.query<any>(`SELECT * FROM product_truth ORDER BY version DESC LIMIT 1`)).rows[0];
    if (!truthRow) return refuse("product_truth_missing", "Product Truth is not initialized.");
    const truth = mapProductTruth(truthRow);
    const warnings = validateDraft({ subject: input.subject, body: input.body, recipientEmail: candidate.contactEmail,
      truth, aiGenerated: input.aiGenerated ?? true });
    const tags = tagsFromActorType(input.actor.actorType);
    // A founder clicking Prepare is not the author of AI-generated text. Leave that agent slot
    // empty so draftProvenance displays the recorded provider/model or truthful No-AI fallback.
    const agent = input.actor.sourceAgent ?? (input.actor.actorType === "founder" ? null : input.actor.actorType === "api" ? "unknown" : tags.agent);
    const channel = input.actor.sourceChannel ?? (input.actor.actorType === "api" ? "api_key" : tags.channel);
    const id = crypto.randomUUID();
    const inserted = await tx.query<any>(`WITH eligible AS (${FOLLOW_UP_CANDIDATE_SQL.replaceAll("$1","$2")})
      INSERT INTO drafts (id,prospect_id,research_job_id,kind,sequence,status,
      subject,body,recipient_email,ai_generated,ai_model,ai_provider,product_truth_version,warnings,
      created_by_type,created_by_user_id,source_client,source_agent,source_channel)
      SELECT $1,p.id,p.research_job_id,'follow_up',$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16
      FROM prospects p JOIN eligible e ON e.prospect_id=p.id WHERE p.id=$2
        AND e.contact_email=$6 AND date_trunc('milliseconds',e.last_outbound_at)=$17::timestamptz
        AND GREATEST(e.sent_follow_ups,COALESCE(e.last_sequence,0))+1=$3::int AND e.active_draft_id IS NULL
      ON CONFLICT DO NOTHING RETURNING *`,
      [id,input.prospectId,candidate.nextSequence,input.subject,input.body,candidate.contactEmail,input.aiGenerated ?? true,
        input.model ?? null,input.provider ?? null,truth.version,JSON.stringify(warnings),
        input.actor.actorType,input.userId ?? null,input.actor.sourceClient ?? null,agent,channel,candidate.lastOutboundAt]);
    if (!inserted.rows[0]) {
      const race = await tx.query<{id:string}>(`SELECT id FROM drafts WHERE prospect_id=$1 AND kind='follow_up' AND sequence=$2`,[input.prospectId,input.expectedSequence]);
      if (race.rows[0]) return { prospectId: input.prospectId, status: "preserved", draftId: race.rows[0].id };
      return refuse("eligibility_changed", "The lead changed while the draft was being saved. Refresh the due list.");
    }
    await tx.query(`INSERT INTO draft_revisions (id,draft_id,subject,body,recipient_email,warnings,edited_by,edited_by_type)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,[crypto.randomUUID(),id,input.subject,input.body,candidate.contactEmail,JSON.stringify(warnings),input.userId ?? null,input.actor.actorType]);
    await tx.query(`INSERT INTO audit_log (id,actor_type,actor_id,action,entity_type,entity_id,metadata)
      VALUES ($1,$2,$3,'follow_up.draft_saved','draft',$4,$5::jsonb)`,[crypto.randomUUID(),input.actor.actorType,
      input.actor.actorKeyId ?? input.userId ?? null,id,JSON.stringify({prospectId:input.prospectId,sequence:candidate.nextSequence,sourceAgent:agent,sourceChannel:channel})]);
    if (input.actor.actorType === "founder") {
      await tx.query(`UPDATE prospects SET next_action=$1,updated_at=now() WHERE id=$2`,
        [`Review follow-up #${candidate.nextSequence} (${truncate(candidate.businessName,40)})`,input.prospectId]);
    }
    // No stage, next-action, approval, queue, job, or settings mutation on the agent path.
    return { prospectId: input.prospectId, status: "saved", draftId: id, draft: mapDraft(inserted.rows[0]) };
  });
}

export async function saveAgentFollowUpDrafts(input: {
  drafts: AgentFollowUpDraftInput[]; actor: AgentFollowUpActor;
}): Promise<{ results: AgentFollowUpSaveResult[]; saved: number; preserved: number; refused: number }> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AppError("Invalid follow-up draft batch.",400,"invalid_follow_up_batch");
  const results: AgentFollowUpSaveResult[] = [];
  for (const draft of parsed.data.drafts) {
    const { draft: _privateDraft, ...result } = await persistPreparedFollowUp({...draft,actor:parsed.data.actor});
    void _privateDraft;
    results.push(result);
  }
  return {results,saved:results.filter((r)=>r.status==="saved").length,
    preserved:results.filter((r)=>r.status==="preserved").length,refused:results.filter((r)=>r.status==="refused").length};
}
