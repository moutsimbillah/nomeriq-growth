-- 039: let connected assistants record search history without creating a research target.
-- Existing engine queries remain job-scoped; standalone searches are globally deduplicated by query_key.
ALTER TABLE research_queries
  ALTER COLUMN job_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS research_queries_standalone_query_unique
  ON research_queries (query_key)
  WHERE job_id IS NULL;
