-- Pass B: outbound history from the senders index, inbound envelopes, conversations, drafts.
-- Counts, codes and the reconciler's own path name only in the log; no record value is printed.
BEGIN;

DROP TABLE IF EXISTS stg.old_to_new; DROP TABLE IF EXISTS stg.conv;

-- B0. one map from every old prospect id to the lead it now belongs to: folded into one of the existing
-- four, merged in one of the six groups, or imported as itself. Every join below goes through it.
CREATE TABLE stg.old_to_new AS
SELECT m.old_prospect_id, p.id AS prospect_id
  FROM stg.old_to_lead m JOIN prospects p ON coalesce(p.metadata->'legacy'->>'prospect_id', '') = m.lead_old_id;

-- ------------------------------------------------ B1. conversations: one per lead with history
CREATE TABLE stg.conv AS
SELECT p.id AS prospect_id, gen_random_uuid() AS id
  FROM prospects p
 WHERE EXISTS (SELECT 1 FROM stg.senders s JOIN stg.old_to_new om2 ON om2.old_prospect_id = s.data->>'prospect_id' WHERE om2.prospect_id = p.id)
    OR EXISTS (SELECT 1 FROM stg.rows tm JOIN stg.rows lk ON lk.source_table = 'marketing_conversation_links'
                 AND lk.data->>'state' = 'MATCHED' AND lk.data->>'source_id' = tm.data->>'source_id'
                WHERE tm.source_table = 'marketing_growth_thread_messages' AND tm.data->>'direction' = 'INBOUND'
                  AND EXISTS (SELECT 1 FROM stg.old_to_new o3 WHERE o3.old_prospect_id = tm.data->>'prospect_id' AND o3.prospect_id = p.id))
    OR EXISTS (SELECT 1 FROM stg.rows dp
                 JOIN stg.rows it ON it.source_table = 'marketing_outreach_intents' AND it.data->>'id' = dp.data->>'intent_id'
                 JOIN stg.old_to_new o4 ON o4.old_prospect_id = it.data->>'prospect_id'
                WHERE dp.source_table = 'marketing_email_dispatches' AND dp.data->>'state' <> 'SENT' AND o4.prospect_id = p.id);

INSERT INTO conversations (id, prospect_id, subject, last_message_at, last_inbound_at, last_outbound_at,
                           unread_count, sending_profile_id, created_at, updated_at)
SELECT c.id, c.prospect_id, '(no subject)', NULL, NULL, NULL, 0,
       (SELECT id FROM email_accounts WHERE normalized_email = 'moutsim@nomeriq.com'), now(), now()
  FROM stg.conv c;

-- ------------------------------------------------ B2. the 433 accepted sends, from the senders index
INSERT INTO messages (id, conversation_id, prospect_id, account_id, direction, source, folder, message_id,
                      from_email, from_name, to_emails, cc_emails, subject, body_text, snippet, sent_at,
                      is_read, is_sandbox, delivery_status, matched_by, created_at)
SELECT gen_random_uuid(), c.id, p.id, acc.id, 'outbound', 'legacy_import', 'Sent', s.data->>'message_id',
       s.data->>'sender_address', s.data->>'sender_display_name', to_jsonb(ARRAY[s.data->>'recipient']),
       '[]'::jsonb,
       coalesce(w.data->'content'->'draft'->>'subject', mp.data->'content'->>'subject', '(no subject)'),
       coalesce(w.data->'content'->'draft'->>'body', mp.data->'content'->>'body', ''),
       left(coalesce(w.data->'content'->'draft'->>'body', mp.data->'content'->>'body', ''), 160),
       (s.data->>'smtp_accepted_at')::timestamptz, true, false, 'accepted', 'legacy_senders_index',
       (s.data->>'smtp_accepted_at')::timestamptz
  FROM stg.senders s
  JOIN stg.old_to_new om ON om.old_prospect_id = coalesce(
         s.data->>'prospect_id',
         (SELECT md.data->>'prospect_id' FROM stg.rows md WHERE md.source_table = 'marketing_mailbox_drafts'
            AND md.data->>'id' = s.data->>'source_id'),
         (SELECT th.data->>'prospect_id' FROM stg.rows lk
            JOIN stg.rows th ON th.source_table = 'marketing_growth_threads' AND th.data->>'id' = lk.data->>'thread_id'
           WHERE lk.source_table = 'marketing_conversation_links'
             AND lk.data->>'mailbox_id' = (SELECT md.data->>'reply_id' FROM stg.rows md
                                            WHERE md.source_table = 'marketing_mailbox_drafts' AND md.data->>'id' = s.data->>'source_id')
           LIMIT 1),
         (SELECT e.prospect_id::text FROM prospect_emails e
           WHERE e.normalized_email = lower(s.data->>'recipient') LIMIT 1))
  JOIN prospects p ON p.id = om.prospect_id
  JOIN stg.conv c ON c.prospect_id = p.id
  CROSS JOIN LATERAL (SELECT id FROM email_accounts WHERE normalized_email = 'moutsim@nomeriq.com') acc
  LEFT JOIN stg.rows apr ON apr.source_table = 'marketing_outreach_draft_approvals' AND apr.data->>'id' = s.data->>'approval_id'
  LEFT JOIN stg.rows w ON w.source_table = 'marketing_workspace_payloads' AND w.data->>'id' = apr.data->>'payload_id'
  LEFT JOIN stg.rows mbd ON mbd.source_table = 'marketing_mailbox_drafts' AND mbd.data->>'id' = s.data->>'source_id'
  LEFT JOIN stg.rows mp ON mp.source_table = 'marketing_mailbox_payloads' AND mp.data->>'id' = mbd.data->>'payload_id';

-- ------------------------------------------------ B3. the dispatches that were not accepted
INSERT INTO messages (id, conversation_id, prospect_id, account_id, direction, source, folder, message_id,
                      from_email, from_name, to_emails, cc_emails, subject, body_text, snippet, sent_at,
                      is_read, is_sandbox, delivery_status, error, matched_by, created_at)
SELECT gen_random_uuid(), c.id, p.id, acc.id, 'outbound', 'legacy_import', 'Sent', d.data->>'message_id',
       w.data->'content'->'sender'->>'address', w.data->'content'->'sender'->>'display_name',
       coalesce(to_jsonb(jsonb_build_array(i.data->'contact_snapshot'->>'locator')), '[]'::jsonb), '[]'::jsonb,
       coalesce(w.data->'content'->'draft'->>'subject', '(no subject)'),
       coalesce(w.data->'content'->'draft'->>'body', ''),
       left(coalesce(w.data->'content'->'draft'->>'body', ''), 160),
       coalesce((d.data->>'completed_at')::timestamptz, (d.data->>'created_at')::timestamptz, now()), true, false,
       CASE d.data->>'state' WHEN 'FAILED' THEN 'failed' ELSE 'uncertain' END,
       NULL, 'legacy_dispatch_state', coalesce((d.data->>'created_at')::timestamptz, now())
  FROM stg.rows d
  JOIN stg.rows i ON i.source_table = 'marketing_outreach_intents' AND i.data->>'id' = d.data->>'intent_id'
  JOIN stg.old_to_new om ON om.old_prospect_id = i.data->>'prospect_id'
  JOIN prospects p ON p.id = om.prospect_id
  JOIN stg.conv c ON c.prospect_id = p.id
  CROSS JOIN LATERAL (SELECT id FROM email_accounts WHERE normalized_email = 'moutsim@nomeriq.com') acc
  LEFT JOIN stg.rows apr ON apr.source_table = 'marketing_outreach_draft_approvals' AND apr.data->>'id' = d.data->>'approval_id'
  LEFT JOIN stg.rows w ON w.source_table = 'marketing_workspace_payloads' AND w.data->>'id' = apr.data->>'payload_id'
 WHERE d.source_table = 'marketing_email_dispatches' AND d.data->>'state' <> 'SENT'
   AND NOT EXISTS (SELECT 1 FROM stg.senders s WHERE s.data->>'source_id' = d.data->>'id');

-- ------------------------------------------------ B4. the 19 inbound envelopes, excerpt only
INSERT INTO messages (id, conversation_id, prospect_id, account_id, direction, source, folder, uidvalidity, uid,
                      message_id, in_reply_to, references_json, from_email, from_name, to_emails, subject,
                      body_text, snippet, sent_at, received_at, is_read, delivery_status, error, matched_by, created_at)
SELECT gen_random_uuid(), c.id, p.id, acc.id, 'inbound', 'legacy_import', coalesce(mm.data->>'folder', 'INBOX'),
       (mm.data->>'uidvalidity')::int, (mm.data->>'uid')::int, mm.data->>'message_id',
       mm.data->>'parent_message_id', coalesce(mm.data->'reference_ids', '[]'::jsonb),
       mp.data->'content'->'from'->0->>'address', mp.data->'content'->'from'->0->>'name',
       coalesce(to_jsonb(mp.data->'content'->'to'->0->>'address'), '[]'::jsonb),
       coalesce(mp.data->'content'->>'subject', '(no subject)'),
       coalesce(ex.data->>'excerpt', ''), left(coalesce(ex.data->>'excerpt', ''), 160),
       coalesce((mm.data->>'received_at')::timestamptz, (mm.data->>'occurred_at')::timestamptz, (tm.data->>'occurred_at')::timestamptz, now()),
       coalesce((mm.data->>'received_at')::timestamptz, (mm.data->>'occurred_at')::timestamptz, (tm.data->>'occurred_at')::timestamptz, now()), true,
       'accepted', 'excerpt only, full body pending mailbox sync', 'legacy_reconciler_v1',
       coalesce((mm.data->>'recorded_at')::timestamptz, now())
  FROM stg.rows tm
  JOIN stg.rows lk ON lk.source_table = 'marketing_conversation_links' AND lk.data->>'state' = 'MATCHED'
                  AND lk.data->>'source_id' = tm.data->>'source_id'
  JOIN stg.rows mm ON mm.source_table = 'marketing_mailbox_messages' AND mm.data->>'id' = lk.data->>'mailbox_id'
  JOIN stg.rows mp ON mp.source_table = 'marketing_mailbox_payloads' AND mp.data->>'id' = mm.data->>'payload_id'
  LEFT JOIN stg.rows ex ON ex.source_table = 'marketing_reply_excerpts' AND ex.data->>'mailbox_payload_id' = mp.data->>'id'
  JOIN stg.old_to_new om ON om.old_prospect_id = tm.data->>'prospect_id'
  JOIN prospects p ON p.id = om.prospect_id
  JOIN stg.conv c ON c.prospect_id = p.id
  CROSS JOIN LATERAL (SELECT id FROM email_accounts WHERE normalized_email = 'moutsim@nomeriq.com') acc
 WHERE tm.source_table = 'marketing_growth_thread_messages' AND tm.data->>'direction' = 'INBOUND';

-- ------------------------------------------------ B5. conversation clocks and subjects
UPDATE conversations c SET
       subject = coalesce((SELECT m.subject FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'outbound'
                   ORDER BY m.sent_at LIMIT 1), '(no subject)'),
       last_outbound_at = (SELECT max(m.sent_at) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'outbound'),
       last_inbound_at = (SELECT max(m.received_at) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound'),
       last_message_at = greatest(coalesce((SELECT max(m.sent_at) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'outbound'), 'epoch'::timestamptz),
                                  coalesce((SELECT max(m.received_at) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound'), 'epoch'::timestamptz)),
       updated_at = now();

-- ------------------------------------------------ B6. status, pins, and the 4 NOT_INTERESTED
UPDATE prospects p SET status = CASE WHEN p.status = 'new' THEN 'contacted' ELSE p.status END,
       sending_profile_id = coalesce(p.sending_profile_id, (SELECT id FROM email_accounts WHERE normalized_email = 'moutsim@nomeriq.com')),
       sending_profile_pinned_at = coalesce(p.sending_profile_pinned_at, (SELECT min(m.sent_at) FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'outbound')),
       last_contacted_at = coalesce(p.last_contacted_at, (SELECT min(m.sent_at) FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'outbound')),
       updated_at = now()
 WHERE EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'outbound'
                 AND m.delivery_status IN ('accepted', 'uncertain'));

UPDATE prospects p SET status = 'lost', do_not_contact = true, updated_at = now()
 WHERE p.id IN (SELECT om.prospect_id FROM stg.rows r
                   JOIN stg.old_to_new om ON om.old_prospect_id = r.data->>'prospect_id'
                  WHERE r.source_table = 'marketing_outreach_replies' AND r.data->>'classification' = 'NOT_INTERESTED');

-- ------------------------------------------------ B7. drafts: one first contact per lead, one follow_up
-- P4 Provider's and Tawsiyat's new drafts are replaced by their old sent emails: drop what is not imported
DELETE FROM drafts d USING prospects p
 WHERE d.prospect_id = p.id AND d.created_by_type <> 'legacy' AND d.created_by_type IS NOT NULL
   AND p.metadata->'legacy'->>'prospect_id' IS NOT NULL;

INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email, ai_generated,
                    approved_at, sent_at, created_by_type, created_at, updated_at, source_channel, source_agent)
SELECT DISTINCT ON (p.id) gen_random_uuid(), p.id, 'first_contact', 1, 'sent',
       coalesce(w.data->'content'->'draft'->>'subject', mp.data->'content'->>'subject', '(no subject)'),
       coalesce(w.data->'content'->'draft'->>'body', mp.data->'content'->>'body', ''),
       s.data->>'recipient', false, (s.data->>'smtp_accepted_at')::timestamptz, (s.data->>'smtp_accepted_at')::timestamptz,
       'legacy', (s.data->>'smtp_accepted_at')::timestamptz, now(), 'legacy_import',
       CASE upper(coalesce(p.source_agent, '')) WHEN 'CLAUDE' THEN 'claude' WHEN 'CHATGPT' THEN 'chatgpt' ELSE 'unknown' END
  FROM stg.senders s
  JOIN stg.old_to_new om ON om.old_prospect_id = s.data->>'prospect_id'
  JOIN prospects p ON p.id = om.prospect_id
  LEFT JOIN stg.rows apr ON apr.source_table = 'marketing_outreach_draft_approvals' AND apr.data->>'id' = s.data->>'approval_id'
  LEFT JOIN stg.rows w ON w.source_table = 'marketing_workspace_payloads' AND w.data->>'id' = apr.data->>'payload_id'
  LEFT JOIN stg.rows mbd ON mbd.source_table = 'marketing_mailbox_drafts' AND mbd.data->>'id' = s.data->>'source_id'
  LEFT JOIN stg.rows mp ON mp.source_table = 'marketing_mailbox_payloads' AND mp.data->>'id' = mbd.data->>'payload_id'
 ORDER BY p.id, (s.data->>'smtp_accepted_at');

INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email, ai_generated,
                    created_by_type, created_at, updated_at, source_channel, source_agent)
SELECT gen_random_uuid(), p.id,
       CASE WHEN d.data->>'step' = '2' THEN 'follow_up' ELSE 'first_contact' END, 1, 'draft',
       coalesce(w.data->'content'->>'subject', '(no subject)'), coalesce(w.data->'content'->>'body', ''),
       coalesce((SELECT r.data->>'locator' FROM stg.rows r WHERE r.source_table = 'marketing_prospect_contacts'
                   AND r.data->>'id' = sq.data->>'contact_id'), ''), false, 'legacy', now(), now(), 'legacy_import',
       CASE upper(coalesce(p.source_agent, '')) WHEN 'CLAUDE' THEN 'claude' WHEN 'CHATGPT' THEN 'chatgpt' ELSE 'unknown' END
  FROM stg.rows d
  JOIN stg.rows sq ON sq.source_table = 'marketing_outreach_sequences' AND sq.data->>'id' = d.data->>'sequence_id'
  JOIN stg.rows w ON w.source_table = 'marketing_workspace_payloads' AND w.data->>'id' = d.data->>'payload_id'
  JOIN stg.old_to_new om ON om.old_prospect_id = sq.data->>'prospect_id'
  JOIN prospects p ON p.id = om.prospect_id
 WHERE d.source_table = 'marketing_outreach_drafts'
   AND (d.data->>'step' = '2'
        OR NOT EXISTS (SELECT 1 FROM drafts x WHERE x.prospect_id = p.id AND x.kind = 'first_contact' AND x.status = 'sent'))
   AND NOT EXISTS (SELECT 1 FROM stg.senders s WHERE s.data->>'source_id' = d.data->>'id');
COMMIT;
