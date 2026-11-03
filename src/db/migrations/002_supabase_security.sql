-- Supabase defense in depth.
-- Growth never uses the Supabase Data API; the server connects with a direct
-- PostgreSQL connection. If the anon/authenticated roles exist, deny them all
-- access so a misconfigured Data API cannot expose this internal database.
DO $$
DECLARE
  table_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    FOREACH table_name IN ARRAY ARRAY[
      'users', 'sessions', 'workspace_settings', 'product_truth',
      'product_truth_revisions', 'research_jobs', 'prospects',
      'prospect_aliases', 'prospect_emails', 'prospect_sources',
      'research_events', 'drafts', 'draft_revisions', 'email_accounts',
      'mailbox_sync_state', 'conversations', 'messages', 'message_attachments',
      'outbound_sends', 'campaigns', 'campaign_items', 'suppressions',
      'unsubscribe_tokens', 'api_keys', 'audit_log'
    ]
    LOOP
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', table_name);
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', table_name);
      END IF;
    END LOOP;
  END IF;
END
$$;
