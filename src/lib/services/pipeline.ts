import { getDb } from "@/lib/db/client";
import { calendarDaysBetween } from "@/lib/dates/timezone";
import { formatDate, iso } from "@/lib/utils";
import { CATEGORIES, type AgentTag, type Category, type ChannelTag } from "@/lib/types";
import { getWorkspaceSettings } from "./settings";
import type { FounderStage } from "./stage";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The pipeline board (email item 5). Eight columns; every eligible, unarchived lead sits in exactly
 * one, worked out from recorded facts — the same population as the folder inbox. Research, Outreach,
 * Follow-up and Engaged move automatically (a send, a follow-up, a reply); Demo, Commercial, Won and
 * Lost are the founder's decisions, set through the audited stage service. Opt-outs and permanent
 * bounces close a lead automatically.
 */

export type PipelineColumnKey =
  | "research"
  | "outreach"
  | "follow_up"
  | "engaged"
  | "demo"
  | "commercial"
  | "won"
  | "closed";

export interface PipelineColumnDefinition {
  key: PipelineColumnKey;
  label: string;
  hint: string;
  /** The stage a founder move into this column sets; absent for the automatic columns. */
  stage?: FounderStage;
}

export const PIPELINE_COLUMNS: readonly PipelineColumnDefinition[] = [
  { key: "research", label: "Research", hint: "Not contacted yet" },
  { key: "outreach", label: "Outreach", hint: "First email sent, waiting" },
  { key: "follow_up", label: "Follow-up", hint: "A follow-up due or sent" },
  { key: "engaged", label: "Engaged", hint: "They replied" },
  { key: "demo", label: "Demo", hint: "Your decision", stage: "demo" },
  { key: "commercial", label: "Commercial", hint: "Proposal or negotiation", stage: "proposal" },
  { key: "won", label: "Won", hint: "Your decision", stage: "won" },
  { key: "closed", label: "Closed", hint: "Lost, opted out or bounced", stage: "lost" },
];

export const PIPELINE_PAGE_SIZE = 12;

export interface PipelineFacts {
  status: string;
  suppressionReason?: string | null;
  hasOutbound?: boolean;
  sentFollowUps?: number;
  followUpDue?: boolean;
  hasReplied?: boolean;
}

/** Precedence: closed facts first, then the founder's stages, then what the mail record shows. */
export function columnFor(facts: PipelineFacts): PipelineColumnKey {
  const reason = (facts.suppressionReason ?? "").toLowerCase();
  if (["unsubscribe", "opt_out", "complaint", "bounce"].includes(reason)) return "closed";
  const status = facts.status;
  if (status === "lost") return "closed";
  if (status === "won") return "won";
  if (status === "proposal") return "commercial";
  if (status === "demo") return "demo";
  if (facts.hasReplied || status === "replied" || status === "interested") return "engaged";
  if ((facts.sentFollowUps ?? 0) > 0 || facts.followUpDue) return "follow_up";
  if (facts.hasOutbound || status === "contacted") return "outreach";
  return "research";
}

/** "12.5K", "1,200", "3M+", "45 000" → a comparable number; null when there is no number. */
export function audienceValue(text: string | null | undefined): number | null {
  if (!text) return null;
  // Drop thousands separators only ("1,200", "45 000"), then read an optional K/M that is a unit on
  // its own — the "m" of "members" is not millions.
  const cleaned = String(text).replace(/(\d)[,\s](?=\d{3}(?:\D|$))/g, "$1");
  const match = cleaned.match(/(\d+(?:\.\d+)?)\s*(?:([kKmM])(?![a-zA-Z]))?/);
  if (!match) return null;
  const base = Number.parseFloat(match[1]!);
  const unit = (match[2] ?? "").toLowerCase();
  return Math.round(base * (unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1));
}

export function audienceLabel(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 100_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(value);
}

export interface PipelineCard {
  prospectId: string;
  businessName: string;
  column: PipelineColumnKey;
  status: string;
  /** At least one email was sent to this lead (a recorded send, not the column it sits in). */
  contacted: boolean;
  /** Not recorded yet (a later phase adds tier); the card keeps the slot. */
  tier: string | null;
  audience: string | null;
  country: string | null;
  categories: Category[];
  sendingProfileId: string | null;
  sourceAgent: AgentTag | null;
  sourceChannel: ChannelTag | null;
  sourceClient: string | null;
  conversationId: string | null;
  statusLine: string;
  followUpLine: string | null;
  lastActivityAt: string | null;
  /** Set while their message is the latest one and waits for the founder. */
  replyWaitingSince: string | null;
  /** What makes a next step visible: a written next action, a draft waiting, or a follow-up due. */
  nextAction: string | null;
  draftWaiting: boolean;
  followUpDue: boolean;
}

export interface PipelineColumn extends PipelineColumnDefinition {
  count: number;
  cards: PipelineCard[];
  limit: number;
  hasMore: boolean;
}

export interface PipelineFilters {
  sender?: string | null;
  agent?: string | null;
  market?: string | null;
  country?: string | null;
  limits?: Partial<Record<PipelineColumnKey, number>>;
}

function latest(...values: (string | null)[]): string | null {
  const times = values.filter((v): v is string => Boolean(v)).map((v) => Date.parse(v)).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function addDays(value: string, days: number): Date {
  return new Date(Date.parse(value) + days * 86_400_000);
}

/** Whole inbox-eligible population. Board windows must never be used as analytics input. */
export async function getPipelineCards(filters: Omit<PipelineFilters, "limits"> = {}): Promise<PipelineCard[]> {
  const settings = await getWorkspaceSettings();
  const db = await getDb();
  const conditions = [`(p.qualification_status = 'verified'
    OR EXISTS (SELECT 1 FROM conversations ic WHERE ic.prospect_id = p.id)
    OR EXISTS (SELECT 1 FROM messages im WHERE im.prospect_id = p.id)
    OR EXISTS (SELECT 1 FROM drafts sd WHERE sd.prospect_id = p.id AND sd.status = 'sent'))`,
    "p.archived_at IS NULL"];
  const params: unknown[] = [];
  if (filters.sender === "none") conditions.push("p.sending_profile_id IS NULL");
  else if (filters.sender) {
    params.push(filters.sender);
    conditions.push(`p.sending_profile_id::text = $${params.length}`);
  }
  if (filters.agent === "unknown") conditions.push("coalesce(p.source_agent, 'unknown') = 'unknown'");
  else if (filters.agent) {
    params.push(filters.agent);
    conditions.push(`p.source_agent = $${params.length}`);
  }
  if (filters.market) {
    params.push(JSON.stringify([filters.market]));
    conditions.push(`p.categories @> $${params.length}::jsonb`);
  }
  if (filters.country) {
    params.push(filters.country);
    conditions.push(`lower(coalesce(p.country, '')) = lower($${params.length})`);
  }

  const result = await db.query<any>(
    `SELECT p.id, p.business_name, p.status, p.country, p.categories, p.follower_count, p.subscriber_count,
        p.do_not_contact, p.follow_up_excluded, p.sending_profile_id, p.source_agent, p.source_channel,
        p.source_client, p.updated_at, p.last_contacted_at, p.next_action,
        (SELECT s.reason FROM suppressions s
          JOIN prospect_emails pe ON pe.normalized_email = s.normalized_email
          WHERE pe.prospect_id = p.id AND s.active = true
          ORDER BY CASE s.reason WHEN 'unsubscribe' THEN 0 WHEN 'opt_out' THEN 1 WHEN 'complaint' THEN 2
            WHEN 'bounce' THEN 3 ELSE 4 END LIMIT 1) AS suppression_reason,
        c.id AS conversation_id, c.classification,
        history.last_inbound_at, history.last_outbound_at,
        (SELECT count(*) FROM drafts d WHERE d.prospect_id = p.id AND d.kind = 'follow_up' AND d.status = 'sent') AS sent_follow_ups,
        (SELECT max(d.sent_at) FROM drafts d WHERE d.prospect_id = p.id AND d.kind = 'follow_up' AND d.status = 'sent') AS last_follow_up_at,
        (SELECT min(d.sent_at) FROM drafts d WHERE d.prospect_id = p.id AND d.kind = 'first_contact' AND d.status = 'sent') AS first_sent_at,
        w.kind AS draft_kind, w.sequence AS draft_sequence, w.status AS draft_status, w.updated_at AS draft_updated_at,
        EXISTS (SELECT 1 FROM messages m JOIN prospect_emails pe ON pe.normalized_email = lower(m.from_email)
          WHERE pe.prospect_id = p.id AND m.direction = 'inbound' AND m.prospect_id IS NULL) AS held_unmatched
       FROM prospects p
       LEFT JOIN LATERAL (
         SELECT max(inbound_at) AS last_inbound_at, max(outbound_at) AS last_outbound_at FROM (
           SELECT c2.last_inbound_at AS inbound_at, c2.last_outbound_at AS outbound_at
             FROM conversations c2 WHERE c2.prospect_id = p.id
           UNION ALL
           SELECT CASE WHEN m.direction = 'inbound' THEN coalesce(m.received_at, m.created_at) END,
                  CASE WHEN m.direction = 'outbound' THEN coalesce(m.sent_at, m.created_at) END
             FROM messages m LEFT JOIN conversations mc ON mc.id = m.conversation_id
            WHERE coalesce(m.prospect_id, mc.prospect_id) = p.id AND m.delivery_status <> 'failed'
              AND NOT EXISTS (SELECT 1 FROM email_bounces eb WHERE eb.message_id = m.id)
           UNION ALL
           SELECT NULL::timestamptz, sd.sent_at FROM drafts sd WHERE sd.prospect_id = p.id AND sd.status = 'sent'
         ) activity
       ) history ON true
       LEFT JOIN LATERAL (
         SELECT id, classification, last_inbound_at, last_outbound_at FROM conversations
          WHERE prospect_id = p.id ORDER BY coalesce(last_message_at, created_at) DESC LIMIT 1) c ON true
       LEFT JOIN LATERAL (
         SELECT kind, sequence, status, updated_at FROM drafts
          WHERE prospect_id = p.id AND status IN ('draft', 'approved') ORDER BY updated_at DESC LIMIT 1) w ON true
      WHERE ${conditions.join(" AND ")}`,
    params,
  );

  const now = new Date();
  const day = (value: Date | string) => formatDate(value, { day: "numeric", month: "short" }, settings.timezone);
  const cards: PipelineCard[] = result.rows.map((row) => {
    const lastInboundAt = iso(row.last_inbound_at);
    const lastOutboundAt = iso(row.last_outbound_at);
    const reason: string | null = row.suppression_reason ?? null;
    const sentFollowUps = Number(row.sent_follow_ups ?? 0);
    const hasOutbound = Boolean(lastOutboundAt || row.first_sent_at);
    const theirsLatest = Boolean(lastInboundAt && (!lastOutboundAt || Date.parse(lastInboundAt) >= Date.parse(lastOutboundAt)));
    const hasReplied = Boolean(lastInboundAt);
    const held = row.do_not_contact === true && !reason;

    // Follow-up timing, by the same rule the follow-up job uses.
    const nextSequence = sentFollowUps + 1;
    const delay = nextSequence === 1 ? settings.followUpDelay1Days : settings.followUpDelay2Days;
    const followUpsOpen =
      hasOutbound && !hasReplied && !reason && !held && row.follow_up_excluded !== true &&
      !["interested", "demo", "proposal", "won", "lost"].includes(row.status) && sentFollowUps < settings.followUpMax;
    const followUpDue = Boolean(
      followUpsOpen && lastOutboundAt && calendarDaysBetween(new Date(lastOutboundAt), now, settings.timezone) >= delay,
    );

    const column = columnFor({ status: row.status, suppressionReason: reason, hasOutbound, sentFollowUps, followUpDue, hasReplied });

    const draftLabel = row.draft_status
      ? `${row.draft_kind === "follow_up" ? `Follow-up #${row.draft_sequence}` : "First email"} ${row.draft_status === "approved" ? "approved, waiting to send" : "drafted, waiting for your approval"}`
      : null;
    let statusLine: string;
    if (reason === "unsubscribe" || reason === "opt_out") statusLine = "Opted out — never contacted again";
    else if (reason === "complaint") statusLine = "Complained — never contacted again";
    else if (reason === "bounce") statusLine = "Bounced — the address is suppressed";
    else if (row.status === "won") statusLine = "Won";
    else if (row.status === "lost") statusLine = row.classification === "not_interested" ? "Said not interested" : "Closed as lost";
    else if (held) statusLine = "On hold — you marked do-not-contact";
    else if (row.held_unmatched === true) statusLine = "Held: unmatched message from them";
    else if (theirsLatest) statusLine = row.classification === "not_interested"
      ? "Said not interested"
      : "They replied and are waiting for your answer";
    else if (draftLabel) statusLine = draftLabel;
    else if (row.status === "demo") statusLine = "Demo stage — next step is yours";
    else if (row.status === "proposal") statusLine = "Proposal or negotiation";
    else if (hasReplied) statusLine = "You answered — waiting for them";
    else if (hasOutbound) statusLine = sentFollowUps > 0 ? `Follow-up #${sentFollowUps} sent — no reply yet` : "First email sent — no reply yet";
    else statusLine = "Not contacted yet";

    let followUpLine: string | null = null;
    if (hasOutbound) {
      if (reason === "unsubscribe" || reason === "opt_out" || reason === "complaint") followUpLine = "Stopped: opted out";
      else if (reason === "bounce") followUpLine = "Stopped: bounced";
      else if (held) followUpLine = "Stopped: on hold";
      else if (row.follow_up_excluded === true) followUpLine = "Follow-ups off for this lead";
      else if (row.status === "lost") followUpLine = "Stopped: closed";
      // Demo, Commercial and Won: follow-ups do not apply, so the card shows no follow-up line.
      else if (["demo", "proposal", "won"].includes(row.status)) followUpLine = null;
      else if (hasReplied) followUpLine = sentFollowUps > 0 ? `Stopped: they replied after follow-up #${sentFollowUps}` : "Stopped: they replied";
      else if (lastOutboundAt) {
        const next = sentFollowUps < settings.followUpMax ? addDays(lastOutboundAt, delay) : null;
        const sent = sentFollowUps > 0 && row.last_follow_up_at ? `Follow-up #${sentFollowUps} sent ${day(row.last_follow_up_at)}` : null;
        const due = next ? (followUpDue ? `#${nextSequence} due now` : `next due ${day(next)}`) : "no more planned";
        followUpLine = sent ? `${sent} · ${due}` : next ? `Follow-up #1 ${followUpDue ? "due now" : `due ${day(next)}`}` : null;
      }
    }

    const audienceValues = [audienceValue(row.follower_count), audienceValue(row.subscriber_count)].filter((v): v is number => v !== null);
    return {
      prospectId: row.id,
      businessName: row.business_name,
      column,
      status: row.status,
      contacted: hasOutbound,
      tier: null,
      audience: audienceValues.length ? audienceLabel(Math.max(...audienceValues)) : null,
      country: row.country ?? null,
      categories: CATEGORIES.filter(({ value }) => (row.categories ?? []).includes(value)).map(({ value }) => value),
      sendingProfileId: row.sending_profile_id ?? null,
      sourceAgent: row.source_agent ?? null,
      sourceChannel: row.source_channel ?? null,
      sourceClient: row.source_client ?? null,
      conversationId: row.conversation_id ?? null,
      statusLine,
      followUpLine,
      lastActivityAt: latest(lastInboundAt, lastOutboundAt, iso(row.draft_updated_at)) ?? iso(row.updated_at),
      replyWaitingSince: theirsLatest && !reason && !held && !["won", "lost"].includes(row.status) ? lastInboundAt : null,
      nextAction: row.next_action?.trim() ? row.next_action.trim() : null,
      draftWaiting: Boolean(row.draft_status),
      followUpDue,
    };
  });

  return cards;
}

export async function getPipelineBoard(filters: PipelineFilters = {}): Promise<{ columns: PipelineColumn[]; total: number }> {
  const cards = await getPipelineCards(filters);
  const columns = PIPELINE_COLUMNS.map((definition) => {
    const all = cards
      .filter((card) => card.column === definition.key)
      .sort((a, b) => (Date.parse(b.lastActivityAt ?? "") || 0) - (Date.parse(a.lastActivityAt ?? "") || 0)
        || a.prospectId.localeCompare(b.prospectId));
    const requested = filters.limits?.[definition.key];
    const limit = Number.isFinite(requested) ? Math.max(1, Math.floor(requested!)) : PIPELINE_PAGE_SIZE;
    return { ...definition, count: all.length, cards: all.slice(0, limit), limit, hasMore: all.length > limit };
  });
  return { columns, total: cards.length };
}

/** Canonical signal markets, not countries; include empty markets so filters are stable. */
export async function listMarkets(): Promise<string[]> {
  return CATEGORIES.map(({ value }) => value);
}
