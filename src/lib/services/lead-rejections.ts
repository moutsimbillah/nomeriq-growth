import { getDb, type DbClient } from "@/lib/db/client";
import { classifyReply, stripQuotedReply } from "@/lib/email/classify";
import { iso } from "@/lib/utils";

export const OFFER_REJECTION_REASON = "Prospect explicitly declined the offer, partnerships, integrations or a new platform. Recommend Closed/Lost for founder confirmation; automatic follow-ups are stopped. This is not a formal unsubscribe.";
export async function recordOfferRejection(db: DbClient, prospectId: string, messageId: string): Promise<boolean> {
  const row = (await db.query<{ body_text: string }>(`SELECT m.body_text FROM messages m
    WHERE m.id=$1 AND m.prospect_id=$2 AND m.direction='inbound'
      AND COALESCE(m.raw_headers->>'deliveryReport','false')<>'true'
      AND COALESCE(m.raw_headers->>'autoReply','false')<>'true'
      AND NOT EXISTS (SELECT 1 FROM email_bounces b WHERE b.message_id=m.id)
      AND lower(m.from_email) !~ '^(mailer-daemon|postmaster|no-?reply)@'
      AND NOT EXISTS (SELECT 1 FROM email_accounts a WHERE lower(a.email_address)=lower(m.from_email))
      AND COALESCE(m.subject,'') !~* '(out of (the )?office|automatic reply|auto.?reply|vacation|delivery status notification|undeliverable|delivery failure)'
      AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(COALESCE(m.raw_headers,'{}'::jsonb)) h
        WHERE (lower(h.key)='auto-submitted' AND h.value ~* '(auto-replied|auto-generated)')
          OR (lower(h.key)='content-type' AND h.value ~* 'report-type[[:space:]]*=[[:space:]]*"?(delivery-status|feedback-report)'))`, [messageId,prospectId])).rows[0];
  if (!row || classifyReply(row.body_text).classification !== "not_interested") return false;
  await db.query(`INSERT INTO prospect_rejection_recommendations
    (id,prospect_id,message_id,reason,objection,provenance_key)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (provenance_key) DO NOTHING`,
    [crypto.randomUUID(),prospectId,messageId,OFFER_REJECTION_REASON,stripQuotedReply(row.body_text),`offer-rejection:${messageId}`]);
  // This is a recommendation, not a status/DNC/suppression/founder-exclusion decision.
  // The persisted recommendation is independently consulted by both draft and final send gates.
  await db.query("UPDATE drafts SET status='cancelled',updated_at=now() WHERE prospect_id=$1 AND kind='follow_up' AND status IN ('draft','approved')",[prospectId]);
  return true;
}
export async function hasOfferRejection(prospectId: string, db?: DbClient): Promise<boolean> {
  const client=db ?? await getDb();
  return (await client.query("SELECT id FROM prospect_rejection_recommendations WHERE prospect_id=$1 LIMIT 1",[prospectId])).rows.length>0;
}
export async function latestOfferRejection(prospectId: string) {
  const db=await getDb();
  const row=(await db.query<{reason:string;objection:string;recorded_at:string;message_id:string}>("SELECT reason,objection,recorded_at,message_id FROM prospect_rejection_recommendations WHERE prospect_id=$1 ORDER BY recorded_at DESC,id DESC LIMIT 1",[prospectId])).rows[0];
  return row?{reason:row.reason,objection:row.objection,recordedAt:iso(row.recorded_at),messageId:row.message_id}:null;
}
