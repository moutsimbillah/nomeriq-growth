-- 027_gemini_assistant_keys.sql
-- Gemini joins ChatGPT, Claude, Hermes and DeepSeek as an assistant an API key can be created for.
--
-- Only the label list on `api_keys.assistant` widens. Every existing label stays allowed, so no
-- existing key is affected, and the label is reporting only: it never grants a permission. Gemini
-- is already a recognised agent tag for prospects and drafts (migration 013), so nothing else changes.
--
-- Safe to re-run: the constraint is dropped if present and recreated with the same definition.

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_assistant_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_assistant_check
  CHECK (assistant IN ('chatgpt', 'claude', 'deepseek', 'hermes', 'gemini', 'custom'));
