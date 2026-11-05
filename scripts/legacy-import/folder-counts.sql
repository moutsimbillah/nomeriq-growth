-- Folder counts by lead, mirroring src/lib/services/folders.ts: first match wins, exactly as the app
-- evaluates it. Read-only.
WITH lead AS (
  SELECT p.id, p.status, p.archived_at,
         (SELECT s.reason FROM suppressions s
           WHERE s.active AND (s.prospect_id = p.id
                  OR s.normalized_email IN (SELECT e.normalized_email FROM prospect_emails e WHERE e.prospect_id = p.id))
           ORDER BY CASE s.reason WHEN 'unsubscribe' THEN 1 WHEN 'opt_out' THEN 2 WHEN 'complaint' THEN 3 WHEN 'bounce' THEN 4 ELSE 5 END
           LIMIT 1) AS suppression_reason,
         EXISTS (SELECT 1 FROM drafts d WHERE d.prospect_id = p.id AND d.status IN ('draft', 'approved')) AS has_draft_waiting,
         (SELECT max(m.received_at) FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'inbound') AS last_inbound_at,
         (SELECT max(m.sent_at) FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'outbound') AS last_outbound_at,
         EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'inbound') AS has_replied
    FROM prospects p
), folder AS (
  SELECT id,
    CASE
      WHEN archived_at IS NOT NULL THEN 'archived'
      WHEN lower(coalesce(suppression_reason, '')) IN ('unsubscribe', 'opt_out', 'complaint') THEN 'Opted out'
      WHEN lower(coalesce(suppression_reason, '')) = 'bounce' THEN 'Failed'
      WHEN status = 'won' THEN 'Won'
      WHEN status = 'lost' THEN 'Closed (lost)'
      WHEN status IN ('demo', 'proposal') THEN 'Meeting or proposal'
      WHEN last_inbound_at IS NOT NULL AND last_inbound_at >= coalesce(last_outbound_at, 'epoch'::timestamptz) THEN 'Needs reply'
      WHEN has_draft_waiting THEN 'To approve'
      WHEN status = 'interested' THEN 'In conversation'
      WHEN has_replied AND coalesce(last_outbound_at, 'epoch'::timestamptz) > coalesce(last_inbound_at, 'epoch'::timestamptz) THEN 'In conversation'
      WHEN status = 'contacted' THEN 'Waiting'
      ELSE 'New leads'
    END AS folder
  FROM lead
)
SELECT folder, count(*) AS leads FROM folder GROUP BY 1
UNION ALL SELECT '-- archived (excluded from the eleven)', count(*) FROM folder WHERE folder = 'archived'
UNION ALL SELECT '-- total leads', count(*) FROM folder;
SELECT 'suppressions carrying a prospect_id' AS note, count(*)::text AS n FROM suppressions WHERE prospect_id IS NOT NULL
UNION ALL SELECT 'suppressions matching a lead by address', count(*)::text FROM suppressions s
   WHERE s.active AND EXISTS (SELECT 1 FROM prospect_emails e WHERE e.normalized_email = s.normalized_email)
UNION ALL SELECT 'leads with an unsent draft (to approve)', count(*)::text FROM (SELECT DISTINCT prospect_id FROM drafts WHERE status IN ('draft','approved')) x;
