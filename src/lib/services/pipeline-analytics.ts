import { getDb } from "@/lib/db/client";
import { iso } from "@/lib/utils";
import { getPipelineCards, type PipelineCard } from "./pipeline";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Weekly event activity plus explicitly labelled all-history metrics and current snapshots.
 * Current stages are not evidence of past funnel transitions: no sequential conversion is inferred.
 */
export interface AnalyticsFilters {
  weeks?: number;
  sender?: string | null;
  agent?: string | null;
  market?: string | null;
  country?: string | null;
}

export interface WeekRow {
  start: string;
  firstEmails: number;
  followUps: number;
  replies: number;
  yourReplies: number;
  unknownOutbound: number;
  medianReplyHours: number | null;
}

export interface FunnelStep {
  key: string;
  label: string;
  count: number;
  /** Contact coverage / recorded response rate where the denominator is observed; null for later stage snapshots. */
  conversion: number | null;
}

export interface SequenceRow {
  label: string;
  /** Distinct leads receiving this email kind, over all recorded history. */
  sent: number;
  /** First inbound on the lead followed this kind of outbound. */
  repliedAfter: number;
  rate: number | null;
}

export interface RateRow {
  key: string;
  contacted: number;
  replied: number;
  /** Current demo/proposal/won status among contacted leads, not historical demo conversion. */
  demoPlus: number;
}

export interface MailboxBounceRow {
  accountId: string;
  /** Distinct accepted outbound_sends in the filtered lead population; excludes sandbox. */
  sends: number;
  /** Distinct sends attributed a permanent report, not the number of reports. */
  permanentBounces: number;
  rate: number | null;
}

export interface PipelineAnalytics {
  scope: {
    population: string;
    weekly: { from: string; through: string; timezone: "UTC"; label: string };
    snapshot: { at: string; label: string };
    history: { label: string };
    bounceAttribution: string;
  };
  weeks: WeekRow[];
  funnel: FunnelStep[];
  bySequence: SequenceRow[];
  replySpeed: { answered: number; medianHours: number | null; p90Hours: number | null; waitingNow: number; waitingOver24h: number };
  stageTime: { recordedSince: string | null; rows: { stage: string; medianDays: number | null; samples: number }[] };
  rates: { market: RateRow[]; country: RateRow[]; sender: RateRow[]; agent: RateRow[] };
  bounces: MailboxBounceRow[];
  stale: { count: number; rows: PipelineCard[] };
}

const STALE_DAYS = 14;
const HOUR = 3_600_000;

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}

/** Monday 00:00 UTC of the week holding `time`. */
export function weekStart(time: number): number {
  const date = new Date(time);
  const day = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day);
}

export async function getPipelineAnalytics(filters: AnalyticsFilters = {}): Promise<PipelineAnalytics> {
  const weeksWanted = Math.max(1, Math.min(Math.floor(filters.weeks ?? 8) || 8, 26));
  // Unwindowed cards share eligibility and every dimension filter with the board.
  const cards = await getPipelineCards(filters);
  const ids = cards.map((card) => card.prospectId);
  const db = await getDb();
  const now = Date.now();

  const [messages, audits, bounceCounts] = ids.length ? await Promise.all([
    db.query<any>(
      `SELECT m.id, coalesce(m.prospect_id, c.prospect_id) AS prospect_id, m.conversation_id, m.direction,
          CASE WHEN m.direction = 'inbound' THEN coalesce(m.received_at, m.created_at)
            ELSE coalesce(m.sent_at, m.created_at) END AS at,
          d.kind AS draft_kind, d.sequence AS draft_sequence
         FROM messages m LEFT JOIN drafts d ON d.id = m.draft_id
         LEFT JOIN conversations c ON c.id = m.conversation_id
        WHERE coalesce(m.prospect_id, c.prospect_id) = ANY($1::uuid[])
          AND m.delivery_status <> 'failed'
          AND NOT EXISTS (SELECT 1 FROM email_bounces eb WHERE eb.message_id = m.id)
        ORDER BY at, m.created_at, m.id`,
      [ids],
    ),
    db.query<any>(
      `SELECT entity_id, metadata, created_at FROM audit_log
        WHERE action = 'lead.stage_changed' AND entity_type = 'prospect' AND entity_id = ANY($1::text[])
        ORDER BY created_at, id`,
      [ids],
    ),
    db.query<any>(
      `WITH actual_sends AS (
         SELECT os.id, os.account_id, coalesce(os.prospect_id, c.prospect_id, d.prospect_id) AS prospect_id,
                lower(trim(os.recipient_email)) AS recipient, coalesce(os.completed_at, os.started_at) AS at
           FROM outbound_sends os LEFT JOIN conversations c ON c.id = os.conversation_id
           LEFT JOIN drafts d ON d.id = os.draft_id
          WHERE os.status = 'accepted' AND os.account_id IS NOT NULL
       ), attributed AS (
         SELECT DISTINCT matched.id FROM email_bounces eb
         LEFT JOIN messages report ON report.id = eb.message_id
         JOIN LATERAL (
           SELECT s.id FROM actual_sends s
            WHERE s.account_id = eb.account_id AND s.recipient = lower(trim(eb.normalized_email))
              AND s.at <= coalesce(report.received_at, eb.created_at)
            ORDER BY s.at DESC, s.id DESC LIMIT 1
         ) matched ON true
         WHERE eb.kind = 'permanent'
       )
       SELECT s.account_id, count(DISTINCT s.id)::int AS sends,
              count(DISTINCT a.id)::int AS bounces
         FROM actual_sends s LEFT JOIN attributed a ON a.id = s.id
        WHERE s.prospect_id = ANY($1::uuid[])
        GROUP BY s.account_id ORDER BY s.account_id`,
      [ids],
    ),
  ]) : [{ rows: [] as any[] }, { rows: [] as any[] }, { rows: [] as any[] }];

  type Msg = { conversationId: string | null; inbound: boolean; at: number; label: string };
  const byLead = new Map<string, Msg[]>();
  for (const row of messages.rows) {
    const at = Date.parse(iso(row.at) ?? "");
    if (!Number.isFinite(at) || at > now) continue;
    const list = byLead.get(row.prospect_id) ?? [];
    const inbound = row.direction === "inbound";
    const priorInbound = list.some((msg) => msg.inbound && msg.conversationId === row.conversation_id);
    const label = inbound ? "inbound"
      : row.draft_kind === "first_contact" ? "First email"
        : row.draft_kind === "follow_up" ? `Follow-up #${row.draft_sequence}`
          : priorInbound ? "Your reply"
            : list.length === 0 ? "First email" : "Unknown outbound";
    // A no-draft first outbound can be recognised from chronology; subsequent unexplained sends
    // are Unknown, never invented follow-ups or founder replies.
    list.push({ conversationId: row.conversation_id, inbound, at, label });
    byLead.set(row.prospect_id, list);
  }

  const thisWeek = weekStart(now);
  const weekKeys = Array.from({ length: weeksWanted }, (_, i) => thisWeek - (weeksWanted - 1 - i) * 7 * 86_400_000);
  const weekMap = new Map<number, WeekRow & { replyHours: number[] }>(
    weekKeys.map((start) => [start, { start: new Date(start).toISOString(), firstEmails: 0, followUps: 0, replies: 0, yourReplies: 0, unknownOutbound: 0, medianReplyHours: null, replyHours: [] }]),
  );

  const sequenceSent = new Map<string, Set<string>>();
  const sequenceReplied = new Map<string, Set<string>>();
  const replyHours: number[] = [];
  for (const [id, list] of byLead) {
    let firstReplyCounted = false;
    const lastOutbound = new Map<string, string>();
    const pendingInbound = new Map<string, number>();
    for (const msg of list) {
      const week = weekMap.get(weekStart(msg.at));
      const key = msg.conversationId ?? "none";
      if (msg.inbound) {
        if (week) week.replies += 1;
        const label = lastOutbound.get(key);
        if (!firstReplyCounted && label && label !== "Your reply") {
          const leads = sequenceReplied.get(label) ?? new Set<string>();
          leads.add(id);
          sequenceReplied.set(label, leads);
        }
        firstReplyCounted = true;
        if (!pendingInbound.has(key)) pendingInbound.set(key, msg.at);
      } else {
        if (msg.label !== "Your reply") {
          const leads = sequenceSent.get(msg.label) ?? new Set<string>();
          leads.add(id);
          sequenceSent.set(msg.label, leads);
        }
        if (week) {
          if (msg.label === "First email") week.firstEmails += 1;
          else if (msg.label.startsWith("Follow-up")) week.followUps += 1;
          else if (msg.label === "Your reply") week.yourReplies += 1;
          else week.unknownOutbound += 1;
        }
        const since = pendingInbound.get(key);
        if (since !== undefined) {
          const hours = (msg.at - since) / HOUR;
          replyHours.push(hours);
          // Weekly speed is the answered inbound cohort, grouped by the inbound's week.
          weekMap.get(weekStart(since))?.replyHours.push(hours);
          pendingInbound.delete(key);
        }
        lastOutbound.set(key, msg.label);
      }
    }
  }
  const bySequence = [...sequenceSent.keys()]
    .sort((a, b) => a === "First email" ? -1 : b === "First email" ? 1 : a.localeCompare(b, "en", { numeric: true }))
    .map((label) => {
      const sent = sequenceSent.get(label)!.size;
      const repliedAfter = sequenceReplied.get(label)?.size ?? 0;
      return { label, sent, repliedAfter, rate: sent ? repliedAfter / sent : null };
    });
  const weeks = [...weekMap.values()].map(({ replyHours: hours, ...row }) => ({ ...row, medianReplyHours: quantile(hours, 0.5) }));
  const waiting = cards.filter((card) => card.replyWaitingSince);

  const contacted = (card: PipelineCard) => card.contacted;
  // An unsolicited inbound is not an outreach reply. Rates require an inbound after an outbound
  // in the same conversation; sender/agent/category dimensions describe the current lead record.
  const replied = (card: PipelineCard) => {
    const outboundConversations = new Set<string | null>();
    for (const msg of byLead.get(card.prospectId) ?? []) {
      if (!msg.inbound) outboundConversations.add(msg.conversationId);
      else if (outboundConversations.has(msg.conversationId)) return true;
    }
    return false;
  };
  const demoPlus = (card: PipelineCard) => ["demo", "proposal", "won"].includes(card.status);
  const steps: [string, string, (card: PipelineCard) => boolean][] = [
    ["verified", "Eligible leads (snapshot)", () => true],
    ["contacted", "Contacted (recorded)", contacted],
    ["replied", "Replied after outreach (recorded)", replied],
    ["demo", "Demo or further (snapshot)", demoPlus],
    ["commercial", "Commercial or further (snapshot)", (card) => ["proposal", "won"].includes(card.status)],
    ["won", "Won (snapshot)", (card) => card.status === "won"],
  ];
  const funnel = steps.map(([key, label, test]) => ({ key, label, count: cards.filter(test).length, conversion: null as number | null }));
  // Coverage and response have observed denominators; later current sales statuses are not proof
  // that a lead traversed earlier sales stages, so those transitions stay unavailable.
  for (const index of [1, 2]) {
    const denominator = funnel[index - 1]!.count;
    funnel[index]!.conversion = denominator > 0 ? funnel[index]!.count / denominator : null;
  }

  const group = (keysOf: (card: PipelineCard) => string[]) => {
    const rows = new Map<string, RateRow>();
    for (const card of cards) {
      if (!contacted(card)) continue;
      for (const key of new Set(keysOf(card))) {
        const row = rows.get(key) ?? { key, contacted: 0, replied: 0, demoPlus: 0 };
        row.contacted += 1;
        if (replied(card)) row.replied += 1;
        if (demoPlus(card)) row.demoPlus += 1;
        rows.set(key, row);
      }
    }
    return [...rows.values()].sort((a, b) => b.contacted - a.contacted || a.key.localeCompare(b.key));
  };

  const stageDurations = new Map<string, number[]>();
  const auditsByLead = new Map<string, { from: string; to: string; at: number }[]>();
  for (const row of audits.rows) {
    const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata ?? {};
    const at = Date.parse(iso(row.created_at) ?? "");
    if (!Number.isFinite(at) || at > now) continue;
    const list = auditsByLead.get(row.entity_id) ?? [];
    list.push({ from: String(metadata.from ?? ""), to: String(metadata.to ?? ""), at });
    auditsByLead.set(row.entity_id, list);
  }
  for (const list of auditsByLead.values()) {
    for (let i = 1; i < list.length; i += 1) {
      const previous = list[i - 1]!;
      const current = list[i]!;
      if (previous.to !== current.from) continue; // a gap in the audit is not a known duration
      const days = (current.at - previous.at) / 86_400_000;
      stageDurations.set(previous.to, [...(stageDurations.get(previous.to) ?? []), days]);
    }
  }
  const recordedSince = audits.rows.length ? iso(audits.rows[0].created_at) : null;
  const bounceRows = bounceCounts.rows.map((row: any) => ({
    accountId: row.account_id,
    sends: Number(row.sends),
    permanentBounces: Number(row.bounces),
    rate: Number(row.sends) ? Number(row.bounces) / Number(row.sends) : null,
  }));

  const staleCutoff = now - STALE_DAYS * 86_400_000;
  const stale = cards
    .filter((card) => ["outreach", "follow_up", "engaged", "demo", "commercial"].includes(card.column))
    .filter((card) => !card.nextAction && !card.draftWaiting && !card.followUpDue && !card.replyWaitingSince)
    .filter((card) => (Date.parse(card.lastActivityAt ?? "") || 0) < staleCutoff)
    .sort((a, b) => (Date.parse(a.lastActivityAt ?? "") || 0) - (Date.parse(b.lastActivityAt ?? "") || 0));

  return {
    scope: {
      population: "Unarchived verified leads plus every conversation, message or sent-draft-backed lead, regardless of qualification; all dimension filters apply.",
      weekly: {
        from: new Date(weekKeys[0]!).toISOString(), through: new Date(now).toISOString(), timezone: "UTC",
        label: "Selected weeks only: message activity; reply speed grouped by answered inbound week (answers may arrive later).",
      },
      snapshot: { at: new Date(now).toISOString(), label: "Current snapshot: funnel counts, demo/proposal/won rates, waiting replies and stale leads; not historical stage conversion." },
      history: { label: "All recorded history (not limited to selected weeks): sequence response rates, answered reply speed, audited completed stage durations, contact/reply rates and mailbox bounces." },
      bounceAttribution: "Distinct accepted outbound sends only, excluding sandbox and imported messages without an outbound_sends record. Permanent reports are attributed to the latest preceding accepted send to the same address from the same mailbox; duplicate reports count once per send. Original outbound IDs are not stored on reports, so this attribution is inferred.",
    },
    weeks,
    funnel,
    bySequence,
    replySpeed: {
      answered: replyHours.length, medianHours: quantile(replyHours, 0.5), p90Hours: quantile(replyHours, 0.9),
      waitingNow: waiting.length,
      waitingOver24h: waiting.filter((card) => now - Date.parse(card.replyWaitingSince!) > 24 * HOUR).length,
    },
    stageTime: {
      recordedSince,
      rows: ["interested", "demo", "proposal"].map((stage) => {
        const values = stageDurations.get(stage) ?? [];
        return { stage, medianDays: quantile(values, 0.5), samples: values.length };
      }),
    },
    rates: {
      market: group((card) => card.categories.length ? card.categories : ["Not recorded"]),
      country: group((card) => [card.country || "Not recorded"]),
      sender: group((card) => [card.sendingProfileId ?? "none"]),
      agent: group((card) => [card.sourceAgent ?? "unknown"]),
    },
    bounces: bounceRows,
    stale: { count: stale.length, rows: stale.slice(0, 20) },
  };
}
