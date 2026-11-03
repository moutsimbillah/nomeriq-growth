-- Autonomous research engine: traceability, tick accounting and RLS parity.
-- Additive only. Existing research jobs, leads, drafts and mailbox data are untouched.

-- The worker records how many dispatch ticks it has run for a job, so progress
-- survives restarts and an exhausted job is never silently restarted.
ALTER TABLE research_jobs
  ADD COLUMN IF NOT EXISTS ticks integer NOT NULL DEFAULT 0;

-- A candidate must be traceable to the lead and draft it produced. This makes
-- "which lead came from which discovery" answerable from the database alone.
ALTER TABLE research_candidates
  ADD COLUMN IF NOT EXISTS prospect_id uuid REFERENCES prospects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS draft_id uuid REFERENCES drafts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS research_candidates_prospect_idx
  ON research_candidates(prospect_id);

-- Claims are short lived. An expired claim must be reclaimable so a crashed
-- worker cannot permanently block an identity.
CREATE INDEX IF NOT EXISTS candidate_claims_job_idx
  ON candidate_claims(job_id, claim_expires_at);

-- Search history is read per job to avoid repeating a query.
CREATE INDEX IF NOT EXISTS research_usage_job_operation_idx
  ON research_usage(job_id, operation);

-- Supabase defense in depth for the tables added in 003 and here. Growth still
-- never uses the Supabase Data API; this only denies a misconfigured one.
DO $$
DECLARE
  table_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    FOREACH table_name IN ARRAY ARRAY[
      'provider_credentials', 'research_queries', 'research_candidates',
      'candidate_claims', 'research_usage', 'research_runs'
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
