-- A value for rows that came from the old portal rather than from anything this portal did.
--
-- The import must be able to say honestly where a lead came from. Without this, an imported lead would
-- have to claim to be `founder` or `claude` — and the whole point of the tags is that they can be
-- trusted as a report of origin, never as a claim about work done here.
--
-- The agent axis is untouched: an imported lead keeps whatever the old portal's research client was
-- (claude, chatgpt or unknown), because that is the truth about who found it. Only the channel says
-- "legacy_import", and `created_by_type` says "legacy".
--
-- RULE FOR THE IMPORTER (the founder's instruction, 5 Nov): every imported lead and draft must set
-- source_agent EXPLICITLY from the old portal's research_client — claude, chatgpt or unknown. Never
-- let it fall through to the `legacy` fallback above, which claims no agent: relying on it would make
-- every imported row "unknown" and quietly destroy the one thing this migration exists to preserve.
--
-- Additive and safe to re-run: every check is dropped and recreated with a wider set, and no row is
-- touched. Nothing is written with these values until the import runs, and the app reads them as
-- reporting only — never for permissions, scopes or trust.

ALTER TABLE prospects DROP CONSTRAINT IF EXISTS prospects_source_channel_check;
ALTER TABLE prospects ADD CONSTRAINT prospects_source_channel_check
  CHECK (source_channel IS NULL OR source_channel IN
    ('mcp_oauth', 'api_key', 'engine', 'founder', 'legacy_import'));

ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_source_channel_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_source_channel_check
  CHECK (source_channel IS NULL OR source_channel IN
    ('mcp_oauth', 'api_key', 'engine', 'founder', 'legacy_import'));

ALTER TABLE prospects DROP CONSTRAINT IF EXISTS prospects_created_by_type_check;
ALTER TABLE prospects ADD CONSTRAINT prospects_created_by_type_check
  CHECK (created_by_type IN ('founder', 'chatgpt', 'claude', 'deepseek', 'api', 'seed', 'legacy'));

ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_created_by_type_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_created_by_type_check
  CHECK (created_by_type IN ('founder', 'chatgpt', 'claude', 'deepseek', 'api', 'seed', 'legacy'));

-- The import's own work list is "everything it wrote", and it will ask for exactly that.
CREATE INDEX IF NOT EXISTS prospects_legacy_import_idx
  ON prospects (sending_profile_id) WHERE source_channel = 'legacy_import';
