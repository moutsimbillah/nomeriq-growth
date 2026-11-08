/**
 * Shared SQL policy for the contact stops that cross lead boundaries through active duplicate
 * links, and for the reply facts that stop a follow-up sequence.
 *
 * A lead actively linked as a duplicate of a canonical lead (`prospect_duplicate_links` with
 * `restored_at IS NULL`) is the same business. Every follow-up stop that applies to the canonical
 * lead's own history applies to the linked duplicate's too — and the mark's own effects on the
 * duplicate (`archived_at`, `do_not_contact = true`) are NOT restrictions: the pre-mark state
 * stored in `previous_state` and the duplicate's current restrictive facts are what count, exactly
 * as the send-time linked_hold guard reads them.
 *
 * Every caller — the follow-up send gate, the follow-up candidate selection (the listing AND the
 * final guarded INSERT snapshot share one SQL string) and the held-duplicate query — builds its
 * condition from these fragments, so the predicates cannot drift apart between paths.
 *
 * All fragment builders take the alias of a `prospects` row and reference `${alias}.id` / column
 * names on it; subquery aliases inside the fragments are prefixed `l` so they cannot collide with
 * a caller's own aliases.
 */

/** Statuses that end a follow-up sequence, on a lead or on its active linked duplicates. */
export const FOLLOW_UP_STOPPED_STATUSES_SQL = `'replied','interested','demo','proposal','won','lost'`;

/** Conversation classifications that stop follow-ups, on a lead or on its active linked duplicates. */
export const FOLLOW_UP_STOPPED_CLASSIFICATIONS_SQL = `'unsubscribe','not_interested'`;

/** SQL counterpart of stored real-reply facts; never let a DSN/OOO restart or stop a sequence. */
export function realFollowUpInboundSql(alias = "m"): string {
  return `${alias}.direction='inbound'
    AND COALESCE(${alias}.raw_headers->>'deliveryReport','false') <> 'true'
    AND COALESCE(${alias}.raw_headers->>'autoReply','false') <> 'true'
    AND NOT EXISTS (SELECT 1 FROM email_bounces b WHERE b.message_id=${alias}.id)
    AND lower(${alias}.from_email) !~ '^(mailer-daemon|postmaster|no-?reply)@'
    AND NOT EXISTS (SELECT 1 FROM email_accounts a WHERE lower(a.email_address)=lower(${alias}.from_email))
    AND COALESCE(${alias}.subject,'') !~* '(out of (the )?office|automatic reply|auto.?reply|vacation|delivery status notification|undeliverable|delivery failure)'
    AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(COALESCE(${alias}.raw_headers,'{}'::jsonb)) h
      WHERE (lower(h.key)='auto-submitted' AND h.value ~* '(auto-replied|auto-generated)')
        OR (lower(h.key)='content-type' AND h.value ~* 'report-type[[:space:]]*=[[:space:]]*"?(delivery-status|feedback-report)'))`;
}

/**
 * A real reply — or an undated inbound, failed closed because its import time must never read as
 * "no reply yet" — on the referenced lead. The same stop the lead's own history applies.
 */
export function followUpStoppingInboundSql(prospect: string): string {
  return `EXISTS (SELECT 1 FROM messages lmi WHERE lmi.direction='inbound'
    AND (${realFollowUpInboundSql("lmi")} OR COALESCE(lmi.received_at,lmi.sent_at) IS NULL)
    AND (lmi.prospect_id=${prospect}.id OR lmi.conversation_id IN
      (SELECT id FROM conversations WHERE prospect_id=${prospect}.id)))`;
}

/** A recorded offer-rejection recommendation stops follow-ups (a recommendation, not a founder hold). */
export function followUpRejectionRecommendationSql(prospect: string): string {
  return `EXISTS (SELECT 1 FROM prospect_rejection_recommendations lrr WHERE lrr.prospect_id=${prospect}.id)`;
}

/** A conversation classified unsubscribe or not_interested stops follow-ups. */
export function followUpStoppedClassificationSql(prospect: string): string {
  return `EXISTS (SELECT 1 FROM conversations lfc WHERE lfc.prospect_id=${prospect}.id
    AND lfc.classification IN (${FOLLOW_UP_STOPPED_CLASSIFICATIONS_SQL}))`;
}

/**
 * Recorded contact restrictions on an actively linked duplicate: the do-not-contact flag the lead
 * carried BEFORE it was marked (the mark's own new flag is never inherited as a hold), an
 * unsubscribe classification, an active non-bounce suppression, and a rejection hold recorded
 * after the mark. This is the send-time linked_hold policy, shared verbatim with the duplicate
 * contact guard's held-duplicate query.
 */
export function linkedContactHoldSql(link: string, prospect: string): string {
  return `(
    ${link}.previous_state #>> '{before,prospect,do_not_contact}' = 'true'
    OR EXISTS (SELECT 1 FROM conversations lhc WHERE lhc.prospect_id=${prospect}.id AND lhc.classification='unsubscribe')
    OR EXISTS (SELECT 1 FROM suppressions lhs WHERE lhs.active=true AND lhs.reason<>'bounce' AND
      (lhs.prospect_id=${prospect}.id OR lhs.normalized_email IN (SELECT lhe.normalized_email FROM prospect_emails lhe WHERE lhe.prospect_id=${prospect}.id)))
    OR EXISTS (SELECT 1 FROM audit_log lha WHERE lha.entity_id=${prospect}.id::text AND lha.entity_type='prospect'
      AND lha.action='lead.rejection_hold_set' AND lha.created_at>=${link}.created_at AND ${prospect}.do_not_contact)
  )`;
}

/**
 * The full follow-up stop policy for the active linked duplicates of a canonical lead: every
 * restriction the send-time linked_hold guard honours, plus the follow-up stops — a recorded
 * rejection recommendation, an unsubscribe/not_interested classification, a terminal pipeline
 * status, and a real or undated inbound reply. The send gate and the candidate selection both
 * call this one builder, so a reply on a duplicate stops a manual send and the scheduled queue
 * at the same moment, with the same facts.
 */
export function linkedDuplicateFollowUpStopSql(link: string, prospect: string): string {
  return `(${linkedContactHoldSql(link, prospect)}
    OR ${followUpRejectionRecommendationSql(prospect)}
    OR ${followUpStoppedClassificationSql(prospect)}
    OR ${prospect}.status IN (${FOLLOW_UP_STOPPED_STATUSES_SQL})
    OR ${followUpStoppingInboundSql(prospect)})`;
}
