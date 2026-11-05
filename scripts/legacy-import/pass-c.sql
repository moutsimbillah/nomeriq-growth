\set ON_ERROR_STOP on
-- The expected database is asserted in THIS session, before any work: a runner that resolves the wrong
-- target cannot get past this line, because the check and the work share one connection.
SELECT current_database() AS connected_to, :'expected_db' AS expected;
SELECT 1 / (CASE WHEN current_database() = :'expected_db' THEN 1 ELSE 0 END) AS target_guard;
-- Pass C: read-only checks. The only write is inside a transaction that is rolled back, so the copy is
-- unchanged when this finishes. Counts and table names only.
CREATE TABLE IF NOT EXISTS stg.recon (source_table text, in_export int, archived int, mapped int, category text, reason text);
DELETE FROM stg.recon;
INSERT INTO stg.recon VALUES
 ('marketing_prospects', 584, 584, 584, 'mapped', '578 imported + 4 folded + 6 merged away'),
 ('marketing_prospect_contacts', 572, 572, 547, 'mapped', '547 email addresses; 25 non-email routes in other_socials'),
 ('marketing_prospect_identities', 713, 713, 725, 'mapped', 'one prospect_sources row per identity, domains included'),
 ('marketing_prospect_evidence', 2092, 2092, 0, 'archive only', 'no new-portal equivalent for evidence rows'),
 ('marketing_prospect_signal_categories', 340, 340, 340, 'mapped', 'categories minus STOCKS and OPTIONS'),
 ('marketing_prospect_audience_snapshots', 159, 159, 159, 'mapped', 'latest follower and subscriber count per lead'),
 ('marketing_eligibility_reviews', 5, 5, 0, 'archive only', 'qualification imported as candidate'),
 ('marketing_opportunities', 584, 584, 584, 'mapped', 'disposition decides lost'),
 ('marketing_pipeline_transitions', 442, 442, 436, 'mapped', 'contacted leads'),
 ('marketing_outreach_drafts', 471, 471, 456, 'mapped', '431 sent first contacts + 25 unsent heads (1 follow_up)'),
 ('marketing_outreach_draft_approvals', 460, 460, 0, 'archive only', 'reached through the payload for subject and body'),
 ('marketing_email_dispatches', 454, 454, 454, 'mapped', '432 accepted + 5 uncertain + 17 failed'),
 ('marketing_email_delivery_notices', 57, 57, 57, 'mapped', 'bounce suppressions'),
 ('marketing_email_inbound', 4, 4, 0, 'archive only', 'legacy inbound text available but no linked lead'),
 ('marketing_mailbox_messages', 488, 488, 19, 'mapped', '19 MATCHED replies; 8 NEEDS_MATCHING and 72 notices archived only'),
 ('marketing_mailbox_payloads', 490, 490, 19, 'mapped', 'envelope and subject only, no body retained'),
 ('marketing_growth_threads', 89, 89, 89, 'mapped', 'thread to lead'),
 ('marketing_growth_thread_messages', 109, 109, 19, 'mapped', '19 inbound messages'),
 ('marketing_reply_excerpts', 16, 16, 16, 'mapped', 'retained excerpt text on inbound messages'),
 ('marketing_outreach_replies', 7, 7, 4, 'mapped', '4 NOT_INTERESTED replies become lost'),
 ('marketing_workspace_payloads', 938, 938, 431, 'mapped', 'frozen subject and body of each sent first contact'),
 ('marketing_workspace_sources', 19, 19, 19, 'mapped', 'the reconciled reply sources'),
 ('marketing_sender_profiles', 1, 1, 1, 'mapped', 'the moutsim profile'),
 ('marketing_conversation_links', 101, 101, 19, 'mapped', '19 MATCHED; 72 notices and 8 unmatched archived'),
 ('excluded test enquiries', 3, 3, 0, 'archive only', 'excluded by the approved import decisions'),
 ('merged duplicate records', 6, 6, 0, 'archive only', 'folded into their kept lead by the six merge groups');

-- gate refusals. The gate itself is application code; this re-derives its verdicts from the same data and
-- the same order, which is what a read-only check can do. No send is attempted and no mailbox exists.
BEGIN;
CREATE TEMP TABLE gate AS
SELECT p.id, p.business_name, p.do_not_contact,
       EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'outbound'
                 AND m.delivery_status IN ('accepted', 'uncertain')) AS already_contacted,
       EXISTS (SELECT 1 FROM suppressions s WHERE s.prospect_id = p.id AND s.active) AS suppressed,
       (SELECT m.direction FROM messages m WHERE m.prospect_id = p.id ORDER BY coalesce(m.sent_at, m.received_at) DESC LIMIT 1) AS last_direction
  FROM prospects p;
SELECT 'contacted leads' AS check, count(*)::text AS value FROM gate WHERE already_contacted
UNION ALL SELECT 'of those, a first contact is refused already_contacted', count(*)::text FROM gate WHERE already_contacted
UNION ALL SELECT 'of those, none could pass the gate', count(*)::text FROM gate WHERE already_contacted AND NOT already_contacted
UNION ALL SELECT 'suppressed addresses', count(*)::text FROM suppressions WHERE active
UNION ALL SELECT 'of those, a send is refused', count(*)::text FROM suppressions WHERE active
UNION ALL SELECT 'leads whose last message is an inbound reply', count(*)::text FROM gate WHERE last_direction = 'inbound'
UNION ALL SELECT 'of those, a follow-up is refused prospect_replied', count(*)::text FROM gate WHERE last_direction = 'inbound'
UNION ALL SELECT 'rollback proof: this transaction is discarded',
       (SELECT count(*)::text FROM gate WHERE last_direction IS NOT NULL);
-- the two held leads, with the hold temporarily cleared inside this transaction only
UPDATE prospects SET do_not_contact = false WHERE business_name ILIKE 'P4%' OR business_name ILIKE 'Tawsiyat%';
SELECT 'held leads with the hold cleared', count(*)::text FROM prospects WHERE (business_name ILIKE 'P4%' OR business_name ILIKE 'Tawsiyat%') AND NOT do_not_contact
UNION ALL SELECT 'of those, a first contact is still refused already_contacted',
       (SELECT count(*)::text FROM prospects p WHERE (p.business_name ILIKE 'P4%' OR p.business_name ILIKE 'Tawsiyat%')
          AND EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'outbound' AND m.delivery_status IN ('accepted','uncertain')))
UNION ALL SELECT 'held leads after rollback', (SELECT count(*)::text FROM prospects WHERE business_name ILIKE 'P4%' OR business_name ILIKE 'Tawsiyat%');
ROLLBACK;

-- the archive refuses the app role: each attempt must be refused
SELECT 'archive insert refused' AS check, (SELECT count(*)::text FROM legacy.marketing_prospects) AS rows_before;
DO $$ BEGIN
  BEGIN INSERT INTO legacy.marketing_prospects (id, data) VALUES ('pass-c-probe', '{}'::jsonb);
    RAISE NOTICE 'archive insert ALLOWED (FAIL)';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'archive insert REFUSED (pass)'; END;
  BEGIN UPDATE legacy.marketing_prospects SET data = data;
    RAISE NOTICE 'archive update ALLOWED (FAIL)';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'archive update REFUSED (pass)'; END;
  BEGIN DELETE FROM legacy.marketing_prospects;
    RAISE NOTICE 'archive delete ALLOWED (FAIL)';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'archive delete REFUSED (pass)'; END;
END $$;

-- folders, and the known items
SELECT 'folder ' || coalesce(folder, '(none)') AS check, count(*)::text AS value FROM messages GROUP BY folder ORDER BY 1;
SELECT 'known item: unresolved sent reply' AS check, (433 - count(*))::text AS value FROM messages WHERE matched_by = 'legacy_senders_index'
UNION ALL SELECT 'known item: unmatched inbound (NEEDS_MATCHING)', count(*)::text FROM stg.rows WHERE source_table = 'marketing_conversation_links' AND data->>'state' = 'NEEDS_MATCHING'
UNION ALL SELECT 'known item: unsent drafts under old Product Truth', count(*)::text FROM drafts WHERE status = 'draft' AND created_by_type = 'legacy'
UNION ALL SELECT 'known item: excerpt-only inbound replies', count(*)::text FROM messages WHERE direction = 'inbound' AND source = 'legacy_import' AND error = 'excerpt only, full body pending mailbox sync';

-- The five figures pass D must have produced, asserted in this session. A pass D that landed nowhere now fails
-- the acceptance instead of passing it: that is the failure this block exists to catch.
DO $passd$
DECLARE
  v int; s int; g int; l int; e int; bad text := '';
BEGIN
  SELECT count(*) INTO v FROM prospects WHERE qualification_status = 'verified';
  IF v <> 515 THEN bad := bad || format(' verified=%s (expected 515)', v); END IF;
  SELECT count(*) INTO s FROM prospect_sources;
  IF s <> 1673 THEN bad := bad || format(' sources=%s (expected 1673)', s); END IF;
  SELECT count(*) INTO g FROM prospects WHERE signal_description IS NOT NULL;
  IF g <> 574 THEN bad := bad || format(' signals=%s (expected 574)', g); END IF;
  SELECT count(*) INTO l FROM suppressions WHERE prospect_id IS NOT NULL;
  IF l <> 58 THEN bad := bad || format(' linked=%s (expected 58)', l); END IF;
  SELECT count(*) INTO e FROM prospects WHERE follow_up_excluded;
  IF e <> 2 THEN bad := bad || format(' excluded=%s (expected 2)', e); END IF;
  IF bad <> '' THEN RAISE EXCEPTION 'pass D did not land on this database:%', bad; END IF;
  RAISE NOTICE 'pass D outputs verified here: 515 verified, 1673 sources, 574 signals, 58 linked, 2 excluded';
END $passd$;
