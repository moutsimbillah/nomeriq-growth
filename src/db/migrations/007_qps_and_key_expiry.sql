-- DeepSeek QPS ceiling correction and API key expiry.
-- Additive and re-runnable: existing settings, keys and all sales data remain valid.
--
-- DeepSeek documents a ceiling of 5 requests per second per account for Search
-- and 5 per second for Fetch. The previous constraint allowed 100 for Search
-- and 25 for Fetch, which was wrong: Growth could be configured to exceed the
-- documented limit and receive provider-side rate-limit failures. Values above
-- the real ceiling are clamped here before the tighter constraint is applied.
--
-- expires_at supports API key expiry. Existing keys are backfilled to 90 days
-- after creation so every key has a definite end date.

UPDATE workspace_settings SET deepseek_search_qps = 5 WHERE deepseek_search_qps > 5;
UPDATE workspace_settings SET deepseek_fetch_qps = 5 WHERE deepseek_fetch_qps > 5;

ALTER TABLE workspace_settings DROP CONSTRAINT IF EXISTS workspace_settings_deepseek_qps_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'workspace_settings'::regclass
      AND conname = 'workspace_settings_deepseek_qps_check'
  ) THEN
    ALTER TABLE workspace_settings
      ADD CONSTRAINT workspace_settings_deepseek_qps_check
      CHECK (deepseek_search_qps BETWEEN 1 AND 5 AND deepseek_fetch_qps BETWEEN 1 AND 5);
  END IF;
END
$$;

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at timestamptz;

UPDATE api_keys SET expires_at = created_at + interval '90 days' WHERE expires_at IS NULL;
