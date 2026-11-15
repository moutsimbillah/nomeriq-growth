import { getDb } from "@/lib/db/client";

export async function priorContactExists(prospectId: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.query(
    `SELECT 1 FROM messages m LEFT JOIN conversations c ON c.id=m.conversation_id
     WHERE m.direction = 'outbound' AND m.delivery_status IS DISTINCT FROM 'failed'
       AND (m.prospect_id=$1 OR c.prospect_id=$1 OR EXISTS (
         SELECT 1 FROM prospect_emails e, jsonb_array_elements_text(CASE WHEN jsonb_typeof(m.to_emails)='array' THEN m.to_emails ELSE '[]'::jsonb END) recipient
         WHERE e.prospect_id=$1 AND e.normalized_email=lower(trim(recipient))))
     UNION ALL SELECT 1 FROM outbound_sends s JOIN drafts d ON d.id=s.draft_id
       WHERE s.status IN ('accepted','sandbox','uncertain') AND (s.prospect_id=$1 OR EXISTS (
         SELECT 1 FROM prospect_emails e WHERE e.prospect_id=$1 AND e.normalized_email=lower(trim(d.recipient_email))))
     UNION ALL SELECT 1 FROM messages m LEFT JOIN conversations c ON c.id=m.conversation_id
       JOIN prospect_duplicate_links l ON (l.prospect_id=m.prospect_id OR l.prospect_id=c.prospect_id)
       WHERE l.canonical_prospect_id=$1 AND l.restored_at IS NULL AND m.delivery_status IS DISTINCT FROM 'failed'
     UNION ALL SELECT 1 FROM outbound_sends s LEFT JOIN drafts d ON d.id=s.draft_id
       JOIN prospect_duplicate_links l ON (l.prospect_id=s.prospect_id OR l.prospect_id=d.prospect_id)
       WHERE l.canonical_prospect_id=$1 AND l.restored_at IS NULL AND s.status IN ('accepted','sandbox','uncertain','sending','queued')
     LIMIT 1`,
    [prospectId],
  );
  return result.rows.length > 0;
}