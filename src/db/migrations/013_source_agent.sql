-- Where a lead or draft came from, normalised: which agent produced it and through which channel.
--
-- Reporting only. Nothing reads either column for permissions, scopes or trust: the agent of an
-- OAuth connector is derived from a self-declared name by exact match, and anything unrecognised is
-- stored as 'other' with the sanitised name still available in source_client.
--
-- Additive and safe to re-run: both columns are nullable, the checks replace themselves, and the
-- backfill only touches rows whose source_client is already set — the four prospects and four drafts
-- saved by the Claude and ChatGPT connectors — skipping any row that already carries a value.

ALTER TABLE prospects ADD COLUMN IF NOT EXISTS source_agent text;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS source_channel text;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS source_agent text;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS source_channel text;

ALTER TABLE prospects DROP CONSTRAINT IF EXISTS prospects_source_agent_check;
ALTER TABLE prospects ADD CONSTRAINT prospects_source_agent_check
  CHECK (source_agent IS NULL OR source_agent IN
    ('claude', 'chatgpt', 'gemini', 'hermes', 'deepseek', 'founder', 'other', 'unknown'));

ALTER TABLE prospects DROP CONSTRAINT IF EXISTS prospects_source_channel_check;
ALTER TABLE prospects ADD CONSTRAINT prospects_source_channel_check
  CHECK (source_channel IS NULL OR source_channel IN ('mcp_oauth', 'api_key', 'engine', 'founder'));

ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_source_agent_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_source_agent_check
  CHECK (source_agent IS NULL OR source_agent IN
    ('claude', 'chatgpt', 'gemini', 'hermes', 'deepseek', 'founder', 'other', 'unknown'));

ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_source_channel_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_source_channel_check
  CHECK (source_channel IS NULL OR source_channel IN ('mcp_oauth', 'api_key', 'engine', 'founder'));

-- Backfill: every row that carries a connector name came through an OAuth connector, and its agent
-- is the same exact-name match the write path uses. Rows without a source_client are left alone.
UPDATE prospects
   SET source_agent = CASE lower(btrim(source_client))
                        WHEN 'claude' THEN 'claude'
                        WHEN 'claude.ai' THEN 'claude'
                        WHEN 'chatgpt' THEN 'chatgpt'
                        WHEN 'openai' THEN 'chatgpt'
                        WHEN 'gemini' THEN 'gemini'
                        WHEN 'google gemini' THEN 'gemini'
                        ELSE 'other'
                      END,
       source_channel = 'mcp_oauth'
 WHERE source_client IS NOT NULL AND source_agent IS NULL;

UPDATE drafts
   SET source_agent = CASE lower(btrim(source_client))
                        WHEN 'claude' THEN 'claude'
                        WHEN 'claude.ai' THEN 'claude'
                        WHEN 'chatgpt' THEN 'chatgpt'
                        WHEN 'openai' THEN 'chatgpt'
                        WHEN 'gemini' THEN 'gemini'
                        WHEN 'google gemini' THEN 'gemini'
                        ELSE 'other'
                      END,
       source_channel = 'mcp_oauth'
 WHERE source_client IS NOT NULL AND source_agent IS NULL;

CREATE INDEX IF NOT EXISTS prospects_source_agent_idx ON prospects (source_agent);
CREATE INDEX IF NOT EXISTS prospects_source_channel_idx ON prospects (source_channel);
CREATE INDEX IF NOT EXISTS drafts_source_agent_idx ON drafts (source_agent);