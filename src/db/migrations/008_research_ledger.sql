-- 008: wire the research ledger.
-- research_queries has existed since 003 but nothing has ever written to it.
-- Additive and safe to re-run.

ALTER TABLE research_queries ADD COLUMN IF NOT EXISTS query_key text;

UPDATE research_queries
   SET query_key = lower(btrim(regexp_replace(query, '[[:space:]]+', ' ', 'g')))
 WHERE query_key IS NULL;

ALTER TABLE research_queries ADD COLUMN IF NOT EXISTS new_lead_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS research_queries_query_key_recent_idx
  ON research_queries (query_key, used_at DESC);
