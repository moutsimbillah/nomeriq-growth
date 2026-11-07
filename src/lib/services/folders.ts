import type { PipelineStatus } from "@/lib/types";

/**
 * The folder model from the plan: every provider sits in exactly one folder, and the rules
 * are evaluated in order so the first match wins. Computing the folder rather than storing
 * it means a provider can never be in two folders or in none.
 *
 * Outcome folders are driven by outcome today only where the data already supports it:
 * suppression for opt-out and bounce, prospect status for won and lost. The explicit
 * `outcome` field that will replace the status guesswork arrives with the learning phase,
 * and `Rejected` stays empty until then — it is listed so the ordering is already correct.
 */

export type FolderKey =
  | "opted_out"
  | "failed"
  | "on_hold"
  | "rejected"
  | "won"
  | "closed_lost"
  | "meeting"
  | "needs_reply"
  | "to_approve"
  | "in_conversation"
  | "waiting"
  | "new_leads";

export type FolderGroup = "Outcome" | "Problem" | "Active";

export interface FolderDefinition {
  key: FolderKey;
  label: string;
  group: FolderGroup;
  /** What puts a provider here, in the plan's words. */
  rule: string;
}

/** Ordered exactly as the plan lists them: first match wins. */
export const FOLDERS: readonly FolderDefinition[] = [
  {
    key: "opted_out",
    label: "Opted out",
    group: "Outcome",
    rule: "Unsubscribed or opted out — never contacted again.",
  },
  {
    key: "failed",
    label: "Failed",
    group: "Problem",
    rule: "A delivery bounced.",
  },
  {
    key: "on_hold",
    label: "On hold",
    group: "Problem",
    rule: "You marked the lead do-not-contact (your own hold) — not an opt-out.",
  },
  {
    key: "rejected",
    label: "Rejected",
    group: "Outcome",
    rule: "Outcome is rejected.",
  },
  {
    key: "won",
    label: "Won",
    group: "Outcome",
    rule: "Outcome is won.",
  },
  {
    key: "closed_lost",
    label: "Closed (lost)",
    group: "Outcome",
    rule: "Outcome is lost.",
  },
  {
    key: "meeting",
    label: "Meeting or proposal",
    group: "Active",
    rule: "Stage is demo or proposal.",
  },
  {
    key: "needs_reply",
    label: "Needs reply",
    group: "Active",
    rule: "Their message is the latest one.",
  },
  {
    key: "to_approve",
    label: "To approve",
    group: "Active",
    rule: "A draft is waiting for your Send, including follow-ups.",
  },
  {
    key: "in_conversation",
    label: "In conversation",
    group: "Active",
    rule: "Stage is interested, or they replied and your message was last.",
  },
  {
    key: "waiting",
    label: "Waiting",
    group: "Active",
    rule: "Sent, no reply yet, no draft waiting.",
  },
  {
    key: "new_leads",
    label: "Not contacted",
    group: "Active",
    rule: "Verified, no draft yet.",
  },
];

export interface FolderInput {
  status: PipelineStatus | string;
  /** Archived providers never appear in the email folders. */
  archivedAt?: string | Date | null;
  /** suppressions.reason: unsubscribe, opt_out, bounce, complaint, manual. */
  suppressionReason?: string | null;
  /** prospects.do_not_contact: the founder's own hold unless an opt-out or bounce explains it. */
  doNotContact?: boolean;
  hasDraftWaiting?: boolean;
  lastInboundAt?: string | Date | null;
  lastOutboundAt?: string | Date | null;
  hasReplied?: boolean;
  /** A recorded send, even if an import left the sales status as new. */
  hasOutbound?: boolean;
}

/** Shared read-only projections for inbox and pipeline; never mutate suppression or recipient state. */
export const realMailSQL = (alias: string): string => `
  ${alias}.delivery_status NOT IN ('failed', 'bounced', 'uncertain')
  AND coalesce(${alias}.raw_headers->>'deliveryReport', 'false') <> 'true'
  AND coalesce(${alias}.raw_headers->>'autoReply', 'false') <> 'true'
  AND NOT EXISTS (SELECT 1 FROM email_bounces eb WHERE eb.message_id = ${alias}.id)`;

export const suppressionProjectionSQL = `(SELECT s.reason FROM suppressions s
  WHERE s.active = true AND (s.prospect_id = p.id OR EXISTS (
    SELECT 1 FROM prospect_emails pe WHERE pe.prospect_id = p.id AND pe.normalized_email = s.normalized_email))
  AND (s.reason <> 'bounce' OR NOT EXISTS (
    SELECT 1 FROM prospect_emails usable WHERE usable.prospect_id = p.id
    AND coalesce((SELECT a.action FROM audit_log a WHERE a.actor_type = 'founder'
      AND a.entity_type = 'prospect' AND a.entity_id = p.id::text
      AND a.action IN ('lead.email_linked', 'lead.email_unlinked')
      AND a.metadata->>'emailRowId' = usable.id::text
      ORDER BY a.created_at DESC, a.id DESC LIMIT 1), '') <> 'lead.email_unlinked'
    AND NOT EXISTS (SELECT 1 FROM suppressions blocked
      WHERE blocked.active = true AND blocked.normalized_email = usable.normalized_email)))
  ORDER BY CASE s.reason WHEN 'unsubscribe' THEN 0 WHEN 'opt_out' THEN 1 WHEN 'complaint' THEN 2
    WHEN 'manual' THEN 3 ELSE 4 END LIMIT 1)`;

/** Cached conversation clocks are legacy fallback only when that thread has no stored messages.
 * A stored DSN/OOO or failed send must not re-enter activity through a stale cache. */
export const mailHistorySQL = `SELECT max(inbound_at) AS last_inbound_at, max(outbound_at) AS last_outbound_at FROM (
  SELECT c2.last_inbound_at AS inbound_at, c2.last_outbound_at AS outbound_at
    FROM conversations c2 WHERE c2.prospect_id = p.id
      AND NOT EXISTS (SELECT 1 FROM messages cm WHERE cm.conversation_id = c2.id)
  UNION ALL
  SELECT CASE WHEN m.direction = 'inbound' THEN coalesce(m.received_at, m.created_at) END,
         CASE WHEN m.direction = 'outbound' THEN coalesce(m.sent_at, m.created_at) END
    FROM messages m LEFT JOIN conversations mc ON mc.id = m.conversation_id
    WHERE coalesce(m.prospect_id, mc.prospect_id) = p.id AND ${realMailSQL('m')}
  UNION ALL
  SELECT NULL::timestamptz, sd.sent_at FROM drafts sd WHERE sd.prospect_id = p.id AND sd.status = 'sent'
    AND NOT EXISTS (SELECT 1 FROM messages dm WHERE dm.draft_id = sd.id AND dm.delivery_status IN ('failed','bounced','uncertain'))
) activity`;

function time(value: string | Date | null | undefined): number {
  if (!value) return 0;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** true when their message came after ours (or we have never written). */
function inboundIsLatest(input: FolderInput): boolean {
  const inbound = time(input.lastInboundAt);
  if (!inbound) return false;
  const outbound = time(input.lastOutboundAt);
  return inbound >= outbound;
}

export function folderFor(input: FolderInput): FolderKey | "archived" {
  if (input.archivedAt) return "archived";

  const reason = (input.suppressionReason ?? "").toLowerCase();
  // A complaint is treated like an opt-out: they do not want contact.
  if (reason === "unsubscribe" || reason === "opt_out" || reason === "complaint") {
    return "opted_out";
  }
  if (reason === "bounce") return "failed";
  const status = String(input.status);
  // An explicit completed outcome is not merely the founder's own hold. Actual opt-outs/bounces
  // above still take precedence; a bare do-not-contact flag must not hide imported lost leads.
  if (status === "won") return "won";
  if (status === "lost") return "closed_lost";
  if (input.doNotContact || reason === "manual") return "on_hold";
  if (status === "demo" || status === "proposal") return "meeting";
  if (inboundIsLatest(input)) return "needs_reply";
  if (input.hasDraftWaiting) return "to_approve";
  if (status === "interested") return "in_conversation";
  if (input.hasReplied && time(input.lastOutboundAt) > time(input.lastInboundAt)) {
    return "in_conversation";
  }
  if (status === "contacted" || input.hasOutbound || time(input.lastOutboundAt) > 0) return "waiting";
  return "new_leads";
}

export function folderDefinition(key: FolderKey): FolderDefinition {
  const found = FOLDERS.find((folder) => folder.key === key);
  if (!found) throw new Error(`Unknown folder: ${key}`);
  return found;
}

/** Folders grouped for the left pane: Active, Outcomes, Problems. */
export function foldersByGroup(): { group: FolderGroup; folders: FolderDefinition[] }[] {
  const order: FolderGroup[] = ["Active", "Outcome", "Problem"];
  return order.map((group) => ({
    group,
    folders: FOLDERS.filter((folder) => folder.group === group),
  }));
}