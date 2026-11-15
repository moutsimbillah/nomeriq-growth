-- Mailbox sync foundation: fenced account leases, short-lived runs, and an exact mutation journal.
-- Additive and idempotent. This migration is authored locally; production application is a separate gate.

CREATE TABLE IF NOT EXISTS mailbox_sync_leases (
  account_id uuid PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE,
  lease_owner uuid NOT NULL,
  fence bigint NOT NULL DEFAULT 0,
  lease_until timestamptz NOT NULL,
  active_run_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mailbox_sync_runs (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE RESTRICT,
  mode text NOT NULL CHECK (mode IN ('scheduled', 'manual')),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'expired', 'undone', 'undo_conflict')),
  fence bigint NOT NULL,
  lease_owner uuid,
  backup_receipt jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mailbox_sync_runs_account_idx ON mailbox_sync_runs(account_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS mailbox_sync_runs_active_idx ON mailbox_sync_runs(account_id) WHERE status = 'running';
ALTER TABLE mailbox_sync_runs ADD COLUMN IF NOT EXISTS lease_owner uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='mailbox_sync_leases'::regclass AND conname='mailbox_sync_leases_active_run_fk') THEN
    ALTER TABLE mailbox_sync_leases ADD CONSTRAINT mailbox_sync_leases_active_run_fk
      FOREIGN KEY (active_run_id) REFERENCES mailbox_sync_runs(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE SEQUENCE IF NOT EXISTS mailbox_sync_journal_capture_seq;

CREATE TABLE IF NOT EXISTS mailbox_sync_journal (
  id uuid PRIMARY KEY,
  capture_seq bigint NOT NULL DEFAULT nextval('mailbox_sync_journal_capture_seq'),
  run_id uuid NOT NULL REFERENCES mailbox_sync_runs(id) ON DELETE RESTRICT,
  table_name text NOT NULL,
  pk jsonb NOT NULL,
  operation text NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  before_data jsonb,
  after_data jsonb,
  first_captured_at timestamptz NOT NULL DEFAULT now(),
  last_captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, table_name, pk)
);
ALTER TABLE mailbox_sync_journal ADD COLUMN IF NOT EXISTS capture_seq bigint;
CREATE INDEX IF NOT EXISTS mailbox_sync_journal_run_idx ON mailbox_sync_journal(run_id, capture_seq);

CREATE OR REPLACE FUNCTION mailbox_sync_capture_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_run_id uuid;
  v_account_id uuid;
  fence_text text;
  lease_fence bigint;
  v_pk jsonb;
  before_data jsonb;
  after_data jsonb;
  prior_op text;
  op text := TG_OP;
BEGIN
  IF TG_TABLE_NAME = 'audit_log' THEN RETURN COALESCE(NEW, OLD); END IF;
  v_run_id := nullif(current_setting('nomeriq.mailbox_run_id', true), '')::uuid;
  v_account_id := nullif(current_setting('nomeriq.mailbox_account_id', true), '')::uuid;
  fence_text := nullif(current_setting('nomeriq.mailbox_fence', true), '');
  IF v_run_id IS NULL OR v_account_id IS NULL OR fence_text IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT l.fence INTO lease_fence
    FROM mailbox_sync_leases l
    JOIN mailbox_sync_runs r ON r.id = l.active_run_id
   WHERE l.account_id = v_account_id AND l.active_run_id = v_run_id
     AND r.status = 'running' AND l.lease_until > clock_timestamp();
  IF lease_fence IS NULL OR lease_fence <> fence_text::bigint THEN
    RAISE EXCEPTION 'mailbox sync fence rejected' USING ERRCODE = '40001';
  END IF;

  IF TG_OP = 'DELETE' OR (TG_OP = 'INSERT' AND TG_TABLE_NAME NOT IN (
    'messages','message_attachments','conversations','suppressions','email_bounces',
    'mailbox_sync_state','prospect_rejection_recommendations'
  )) THEN
    RAISE EXCEPTION 'mailbox sync mutation is not recoverable for protected table %', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;

  v_pk := jsonb_build_object('id', COALESCE(to_jsonb(NEW)->'id', to_jsonb(OLD)->'id'));
  IF TG_OP = 'INSERT' THEN
    before_data := NULL;
    after_data := CASE WHEN TG_TABLE_NAME = 'email_accounts' THEN
      jsonb_build_object('status', to_jsonb(NEW)->'status', 'last_error', to_jsonb(NEW)->'last_error',
        'last_sync_at', to_jsonb(NEW)->'last_sync_at', 'last_checked_at', to_jsonb(NEW)->'last_checked_at', 'updated_at', to_jsonb(NEW)->'updated_at')
      ELSE to_jsonb(NEW) END;
  ELSIF TG_OP = 'DELETE' THEN
    before_data := CASE WHEN TG_TABLE_NAME = 'email_accounts' THEN
      jsonb_build_object('status', to_jsonb(OLD)->'status', 'last_error', to_jsonb(OLD)->'last_error',
        'last_sync_at', to_jsonb(OLD)->'last_sync_at', 'last_checked_at', to_jsonb(OLD)->'last_checked_at', 'updated_at', to_jsonb(OLD)->'updated_at')
      ELSE to_jsonb(OLD) END;
    after_data := NULL;
  ELSE
    before_data := CASE WHEN TG_TABLE_NAME = 'email_accounts' THEN
      jsonb_build_object('status', to_jsonb(OLD)->'status', 'last_error', to_jsonb(OLD)->'last_error',
        'last_sync_at', to_jsonb(OLD)->'last_sync_at', 'last_checked_at', to_jsonb(OLD)->'last_checked_at', 'updated_at', to_jsonb(OLD)->'updated_at')
      ELSE to_jsonb(OLD) END;
    after_data := CASE WHEN TG_TABLE_NAME = 'email_accounts' THEN
      jsonb_build_object('status', to_jsonb(NEW)->'status', 'last_error', to_jsonb(NEW)->'last_error',
        'last_sync_at', to_jsonb(NEW)->'last_sync_at', 'last_checked_at', to_jsonb(NEW)->'last_checked_at', 'updated_at', to_jsonb(NEW)->'updated_at')
      ELSE to_jsonb(NEW) END;
  END IF;

  IF TG_TABLE_NAME = 'email_accounts' THEN
    before_data := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE jsonb_build_object(
      'status', to_jsonb(OLD)->'status', 'last_error', to_jsonb(OLD)->'last_error',
      'last_sync_at', to_jsonb(OLD)->'last_sync_at', 'last_checked_at', to_jsonb(OLD)->'last_checked_at',
      'updated_at', to_jsonb(OLD)->'updated_at') END;
    after_data := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE jsonb_build_object(
      'status', to_jsonb(NEW)->'status', 'last_error', to_jsonb(NEW)->'last_error',
      'last_sync_at', to_jsonb(NEW)->'last_sync_at', 'last_checked_at', to_jsonb(NEW)->'last_checked_at',
      'updated_at', to_jsonb(NEW)->'updated_at') END;
  END IF;
  SELECT operation INTO prior_op FROM mailbox_sync_journal
   WHERE run_id=v_run_id AND table_name=TG_TABLE_NAME AND pk=v_pk FOR UPDATE;
  IF TG_OP='DELETE' AND prior_op='INSERT' THEN
    RAISE EXCEPTION 'mailbox sync mutation cannot be recovered after insert and delete' USING ERRCODE='55000';
  END IF;
  INSERT INTO mailbox_sync_journal (id, run_id, table_name, pk, operation, before_data, after_data)
  VALUES (gen_random_uuid(), v_run_id, TG_TABLE_NAME, v_pk, op, before_data, after_data)
  ON CONFLICT (run_id, table_name, pk) DO UPDATE SET
    operation = CASE WHEN mailbox_sync_journal.operation = 'INSERT' THEN 'INSERT' ELSE EXCLUDED.operation END,
    before_data = CASE WHEN mailbox_sync_journal.operation = 'INSERT' THEN mailbox_sync_journal.before_data ELSE COALESCE(mailbox_sync_journal.before_data, EXCLUDED.before_data) END,
    after_data = EXCLUDED.after_data,
    last_captured_at = clock_timestamp();
  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'messages','message_attachments','conversations','drafts','suppressions','email_bounces',
    'mailbox_sync_state','prospects','email_accounts','audit_log',
    'prospect_rejection_recommendations','workspace_settings'
  ] LOOP
    IF to_regclass(t) IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname='mailbox_sync_capture' AND tgrelid=t::regclass
    ) THEN
      EXECUTE format('CREATE TRIGGER mailbox_sync_capture AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION mailbox_sync_capture_mutation()', t);
    END IF;
  END LOOP;
END $$;

ALTER TABLE mailbox_sync_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailbox_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailbox_sync_journal ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mailbox_sync_leases, mailbox_sync_runs, mailbox_sync_journal FROM PUBLIC;
