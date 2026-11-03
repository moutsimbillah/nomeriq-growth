-- Autonomous DeepSeek research engine.
-- Additive: existing manual/MCP research jobs and all sales data remain valid.

ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS research_default_budget_usd numeric(12,4) NOT NULL DEFAULT 5.00,
  ADD COLUMN IF NOT EXISTS research_default_concurrency integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS deepseek_search_qps integer NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS deepseek_fetch_qps integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'workspace_settings'::regclass
      AND conname = 'workspace_settings_research_concurrency_check'
  ) THEN
    ALTER TABLE workspace_settings
      ADD CONSTRAINT workspace_settings_research_concurrency_check
      CHECK (research_default_concurrency BETWEEN 1 AND 8);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'workspace_settings'::regclass
      AND conname = 'workspace_settings_deepseek_qps_check'
  ) THEN
    ALTER TABLE workspace_settings
      ADD CONSTRAINT workspace_settings_deepseek_qps_check
      CHECK (deepseek_search_qps BETWEEN 1 AND 100 AND deepseek_fetch_qps BETWEEN 1 AND 25);
  END IF;
END
$$;

ALTER TABLE research_jobs
  ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS stopped_at timestamptz,
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS worker_claim_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_worker_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_run_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS budget_usd numeric(12,4) NOT NULL DEFAULT 5.00,
  ADD COLUMN IF NOT EXISTS spent_usd numeric(12,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS concurrency integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS search_queries_used integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS candidates_discovered integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_verifications integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stop_reason text,
  ADD COLUMN IF NOT EXISTS last_error text;

ALTER TABLE research_jobs DROP CONSTRAINT IF EXISTS research_jobs_status_check;
ALTER TABLE research_jobs ADD CONSTRAINT research_jobs_status_check
  CHECK (status IN ('active', 'paused', 'completed', 'archived', 'cancelled', 'failed', 'budget_paused'));
ALTER TABLE research_jobs DROP CONSTRAINT IF EXISTS research_jobs_engine_check;
ALTER TABLE research_jobs ADD CONSTRAINT research_jobs_engine_check
  CHECK (engine IN ('manual', 'deepseek'));
ALTER TABLE research_jobs DROP CONSTRAINT IF EXISTS research_jobs_concurrency_check;
ALTER TABLE research_jobs ADD CONSTRAINT research_jobs_concurrency_check
  CHECK (concurrency BETWEEN 1 AND 8);

ALTER TABLE prospects DROP CONSTRAINT IF EXISTS prospects_created_by_type_check;
ALTER TABLE prospects ADD CONSTRAINT prospects_created_by_type_check
  CHECK (created_by_type IN ('founder', 'chatgpt', 'claude', 'deepseek', 'api', 'seed'));

ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_created_by_type_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_created_by_type_check
  CHECK (created_by_type IN ('founder', 'chatgpt', 'claude', 'deepseek', 'api', 'seed'));

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_assistant_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_assistant_check
  CHECK (assistant IN ('chatgpt', 'claude', 'deepseek', 'hermes', 'custom'));

ALTER TABLE research_events DROP CONSTRAINT IF EXISTS research_events_event_type_check;
ALTER TABLE research_events ADD CONSTRAINT research_events_event_type_check
  CHECK (event_type IN (
    'candidate_saved', 'candidate_found', 'candidate_rejected', 'candidate_failed',
    'verified_saved', 'draft_saved', 'duplicate_rejected', 'lead_rejected', 'note',
    'job_started', 'job_paused', 'job_resumed', 'job_cancelled', 'job_completed',
    'job_budget_paused', 'job_failed', 'search_completed', 'fetch_completed'
  ));

-- One email can be shared by unrelated businesses (info@, support@, etc.).
-- Personal/business emails remain unique, while generic inboxes do not merge records.
ALTER TABLE prospect_emails
  DROP CONSTRAINT IF EXISTS prospect_emails_normalized_email_key;

CREATE UNIQUE INDEX IF NOT EXISTS prospect_emails_prospect_email_unique
  ON prospect_emails (prospect_id, normalized_email);

CREATE UNIQUE INDEX IF NOT EXISTS prospect_emails_business_email_unique
  ON prospect_emails (normalized_email)
  WHERE split_part(normalized_email, '@', 1) NOT IN (
    'info', 'support', 'contact', 'sales', 'hello', 'admin', 'team', 'office',
    'help', 'service', 'services', 'enquiries', 'enquiry', 'marketing', 'billing',
    'press', 'careers', 'jobs', 'general', 'mail', 'inquiries'
  );

CREATE TABLE IF NOT EXISTS provider_credentials (
  provider text PRIMARY KEY CHECK (provider IN ('deepseek')),
  encrypted_api_key text NOT NULL,
  base_url text NOT NULL DEFAULT 'https://api.deepseek.com',
  model text NOT NULL DEFAULT 'deepseek-flash',
  last_test_ok boolean,
  last_test_message text,
  last_tested_at timestamptz,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS research_queries (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
  query text NOT NULL,
  market text,
  language text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'used', 'failed')),
  result_count integer NOT NULL DEFAULT 0,
  error text,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, query)
);

CREATE INDEX IF NOT EXISTS research_queries_job_idx
  ON research_queries(job_id, status, created_at);

CREATE TABLE IF NOT EXISTS research_candidates (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
  identity_key text NOT NULL,
  business_name text,
  website_url text,
  domain_key text,
  source_url text,
  search_query text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'researching', 'qualified', 'duplicate', 'rejected', 'failed')),
  claim_id uuid,
  attempts integer NOT NULL DEFAULT 0,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, identity_key)
);

CREATE INDEX IF NOT EXISTS research_candidates_job_status_idx
  ON research_candidates(job_id, status, created_at);
CREATE INDEX IF NOT EXISTS research_candidates_domain_idx
  ON research_candidates(domain_key);

CREATE TABLE IF NOT EXISTS candidate_claims (
  identity_key text PRIMARY KEY,
  claim_id uuid NOT NULL UNIQUE,
  job_id uuid NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
  business_name text,
  website_url text,
  claimed_by text NOT NULL,
  claim_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS candidate_claims_expiry_idx
  ON candidate_claims(claim_expires_at);

CREATE TABLE IF NOT EXISTS research_usage (
  id uuid PRIMARY KEY,
  job_id uuid REFERENCES research_jobs(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'deepseek',
  operation text NOT NULL CHECK (operation IN ('search', 'fetch', 'chat', 'draft')),
  model text,
  request_count integer NOT NULL DEFAULT 1,
  input_tokens integer NOT NULL DEFAULT 0,
  cached_input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'error')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS research_usage_job_idx
  ON research_usage(job_id, created_at DESC);

CREATE TABLE IF NOT EXISTS research_runs (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
  worker_id text NOT NULL,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'interrupted', 'budget_paused', 'cancelled')),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  processed integer NOT NULL DEFAULT 0,
  saved integer NOT NULL DEFAULT 0,
  errors integer NOT NULL DEFAULT 0,
  stop_reason text
);

CREATE INDEX IF NOT EXISTS research_runs_job_idx
  ON research_runs(job_id, started_at DESC);
CREATE INDEX IF NOT EXISTS research_runs_heartbeat_idx
  ON research_runs(status, last_heartbeat_at);
