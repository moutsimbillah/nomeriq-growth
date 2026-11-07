import type { DbClient } from "@/lib/db/client";
import { classifyReply, stripQuotedReply } from "./classify";

/** Uses only the supplied client; safe inside an existing FOR UPDATE transaction. No root DB opens. */
export async function recomputeConversationChronology(db: DbClient, prospectId: string): Promise<void> {
  const locked = await db.query<{ id: string }>(
    `SELECT id FROM conversations WHERE prospect_id = $1 FOR UPDATE`, [prospectId],
  );
  const conversationId = locked.rows[0]?.id;
  if (!conversationId) return;
  const messages = await db.query<{
    direction: string; at: string; body_text: string; is_read: boolean;
  }>(`SELECT direction, coalesce(sent_at, received_at, created_at) AS at, body_text, is_read
       FROM messages WHERE conversation_id = $1
       AND coalesce(raw_headers->>'deliveryReport', 'false') <> 'true'
       AND coalesce(raw_headers->>'autoReply', 'false') <> 'true'
       AND delivery_status NOT IN ('failed', 'bounced', 'uncertain')
       ORDER BY coalesce(sent_at, received_at, created_at), id`, [conversationId]);
  const inbound = messages.rows.filter(row => row.direction === "inbound");
  const outbound = messages.rows.filter(row => row.direction === "outbound");
  const latest = messages.rows.at(-1);
  const lastInbound = inbound.at(-1);
  const lastOutbound = outbound.at(-1);
  const classification = lastInbound ? classifyReply(stripQuotedReply(lastInbound.body_text)) : null;
  await db.query(`UPDATE conversations SET last_message_at = $2, last_inbound_at = $3,
    last_outbound_at = $4, unread_count = $5,
    status = CASE WHEN status = 'closed' THEN status WHEN $6 = 'inbound' THEN 'replied'
      WHEN $6 = 'outbound' THEN 'waiting' ELSE 'open' END,
    classification = CASE WHEN classification_source IN ('founder','ai') OR $6 <> 'inbound' THEN classification
      ELSE coalesce($7, classification) END,
    classification_confidence = CASE WHEN classification_source IN ('founder','ai') OR $6 <> 'inbound' THEN classification_confidence
      ELSE coalesce($8, classification_confidence) END,
    updated_at = now() WHERE id = $1`,
    [conversationId, latest?.at ?? null, lastInbound?.at ?? null, lastOutbound?.at ?? null,
      inbound.filter(row => !row.is_read).length, latest?.direction ?? null,
      classification?.classification ?? null, classification?.confidence ?? null]);
  await db.query(`UPDATE prospects SET last_reply_at = $2, last_contacted_at = $3,
    status = CASE WHEN status IN ('new','verified','draft_prepared','contacted','replied')
      THEN CASE WHEN $4 = 'inbound' THEN 'replied' WHEN $4 = 'outbound' THEN 'contacted' ELSE status END
      ELSE status END,
    next_action = CASE WHEN status IN ('new','verified','draft_prepared','contacted','replied')
      THEN CASE WHEN $4 = 'inbound' THEN 'Read and respond to the reply'
        WHEN $4 = 'outbound' THEN 'Wait for a reply' ELSE next_action END ELSE next_action END,
    updated_at = now() WHERE id = $1`,
    [prospectId, lastInbound?.at ?? null, lastOutbound?.at ?? null, latest?.direction ?? null]);
  // Never cancel a newly prepared follow-up on the strength of an older historical event.
  if (latest) await db.query(`UPDATE drafts SET status = 'cancelled', updated_at = now()
    WHERE prospect_id = $1 AND kind = 'follow_up' AND status IN ('draft','approved')
      AND created_at <= $2::timestamptz`, [prospectId, latest.at]);
}
