-- 025_ai_providers.sql
-- Item 3, first half: OpenAI, Anthropic, Google Gemini, an OpenAI-compatible custom endpoint and
-- Brave Search join DeepSeek as selectable providers, and every AI task gets a chosen model, a
-- chosen search source, and a fallback order.
--
-- Three additive changes, each safe to re-run.
--
-- 1. `research_providers` is the one provider registry, for the research engine and for the AI
--    actions alike. It already has the right shape — base URL, model, encrypted key, search and
--    fetch paths, priority, enabled flag, last test result — so this migration widens its `provider`
--    CHECK rather than adding a second, competing table. Until now the CHECK allowed `'deepseek'`
--    only, which is why no other provider could be stored even though the table was built for it.
--
-- 2. `research_providers.kinds` says what a row can actually do: `chat` (models), `search` (a
--    search API usable with any model) or `both`. Brave is `search`: it has a key and a search
--    endpoint but no model, which is the whole point of separating the model from the search source.
--    A search-only row stores an empty `model` string, left as NOT NULL deliberately so no reader
--    has to handle a null it never had to before.
--
-- 3. `ai_task_settings` holds the per-task choice, and `ai_task_fallbacks` the ordered list tried
--    when the chosen provider fails. A child table rather than a uuid[] so the foreign key is real
--    and the order is data rather than array position.
--
-- Provenance: `drafts` and `prospects` gain `ai_provider` and `ai_model`, which is what makes an
-- "Engine · Claude" pill possible without widening `source_agent`. `source_agent` keeps its
-- existing meaning (the agent of record: claude, chatgpt, gemini, deepseek, founder, other);
-- `ai_provider` records the API that actually produced the text. Decisions the founder may want to
-- reverse are called out in this comment rather than buried.

-- 1. The provider set.
ALTER TABLE research_providers DROP CONSTRAINT IF EXISTS research_providers_provider_check;
ALTER TABLE research_providers ADD CONSTRAINT research_providers_provider_check
  CHECK (provider IN
    ('deepseek', 'openai', 'anthropic', 'gemini', 'openrouter', 'brave', 'custom'));

-- 2. What each row can do. Existing rows are model providers, so `both` is the safe default.
ALTER TABLE research_providers ADD COLUMN IF NOT EXISTS kinds text NOT NULL DEFAULT 'both';
ALTER TABLE research_providers DROP CONSTRAINT IF EXISTS research_providers_kinds_check;
ALTER TABLE research_providers ADD CONSTRAINT research_providers_kinds_check
  CHECK (kinds IN ('chat', 'search', 'both'));

-- 3. Per-task model, search source and fallback order.
CREATE TABLE IF NOT EXISTS ai_task_settings (
  task text PRIMARY KEY
    CHECK (task IN ('lead_research', 'first_email', 'follow_up', 'suggest_reply',
                    'simulate_reply', 'translation', 'classification')),
  provider_id uuid REFERENCES research_providers(id) ON DELETE SET NULL,
  model text,
  -- For research: where pages are found and read. A model provider may search itself, or a
  -- search-only provider (Brave) may do it for any model. NULL means "the chosen model's own".
  search_provider_id uuid REFERENCES research_providers(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_task_fallbacks (
  task text NOT NULL
    CHECK (task IN ('lead_research', 'first_email', 'follow_up', 'suggest_reply',
                    'simulate_reply', 'translation', 'classification')),
  provider_id uuid NOT NULL REFERENCES research_providers(id) ON DELETE CASCADE,
  priority integer NOT NULL DEFAULT 100,
  PRIMARY KEY (task, provider_id)
);

CREATE INDEX IF NOT EXISTS ai_task_fallbacks_order_idx
  ON ai_task_fallbacks (task, priority, provider_id);

-- 4. Provenance: which API and which model produced a lead or a draft.
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS ai_provider text;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS ai_model text;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS ai_provider text;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS ai_model text;

CREATE INDEX IF NOT EXISTS prospects_ai_provider_idx ON prospects (ai_provider);
CREATE INDEX IF NOT EXISTS drafts_ai_provider_idx ON drafts (ai_provider);

-- 5. Same lock-down as every other table: RLS on, nothing for PUBLIC.
ALTER TABLE ai_task_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_task_fallbacks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_task_settings FROM PUBLIC;
REVOKE ALL ON ai_task_fallbacks FROM PUBLIC;

-- Existing installs: DeepSeek is a model provider that can also search and fetch.
UPDATE research_providers SET kinds = 'both' WHERE kinds IS NULL;
