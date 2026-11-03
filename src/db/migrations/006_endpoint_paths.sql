-- Configurable Search and Fetch paths for custom DeepSeek-compatible endpoints.
--
-- DeepSeek's own API exposes Search and Fetch at the proprietary paths
-- /v1/tools/search and /v1/tools/fetch. Other DeepSeek-compatible gateways
-- implement equivalent capabilities at different paths — a common convention is
-- /v1/search plus /v1/scrape (the Firecrawl-style shape).
--
-- Probing a real gateway showed exactly that: /v1/tools/search returned 404 while
-- /v1/search returned 401 (route exists, needs auth), and /v1/tools/fetch
-- returned 404 while /v1/scrape returned 401. Treating those hosts as "chat only"
-- was wrong.
--
-- These columns let a custom endpoint declare where its Search and Fetch live.
-- NULL means "use the DeepSeek default", so existing rows and the official API
-- are unaffected.
--
-- Additive and safe to re-run.
ALTER TABLE provider_credentials
  ADD COLUMN IF NOT EXISTS search_path text,
  ADD COLUMN IF NOT EXISTS fetch_path text;
