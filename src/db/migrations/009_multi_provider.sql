-- 009: several DeepSeek-compatible research providers, tried in priority order.
-- The single provider_credentials row stays as-is (migrations are append-only); this
-- table is the ordered list the engine actually uses, and the existing credential is
-- carried into it once so nothing is lost. Additive and safe to re-run.

CREATE TABLE IF NOT EXISTS research_providers (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  provider text NOT NULL DEFAULT 'deepseek' CHECK (provider IN ('deepseek')),
  base_url text NOT NULL DEFAULT 'https://api.deepseek.com',
  model text NOT NULL DEFAULT 'deepseek-flash',
  encrypted_api_key text NOT NULL,
  search_path text,
  fetch_path text,
  priority integer NOT NULL DEFAULT 100,
  is_enabled boolean NOT NULL DEFAULT true,
  last_test_ok boolean,
  last_test_message text,
  last_tested_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name)
);

CREATE INDEX IF NOT EXISTS research_providers_order_idx
  ON research_providers (is_enabled, priority, created_at);

INSERT INTO research_providers
  (id, name, provider, base_url, model, encrypted_api_key, search_path, fetch_path,
   priority, is_enabled, last_test_ok, last_test_message, last_tested_at)
SELECT gen_random_uuid(), 'DeepSeek', provider, base_url, model, encrypted_api_key,
       search_path, fetch_path, 100, true, last_test_ok, last_test_message, last_tested_at
  FROM provider_credentials
 WHERE provider = 'deepseek'
   AND NOT EXISTS (SELECT 1 FROM research_providers);
