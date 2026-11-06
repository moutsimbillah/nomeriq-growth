-- 026_ai_provider_tombstones.sql
-- Deleting a provider must not erase what it produced.
--
-- A provider row is the only place its name, type and key live, and older leads and drafts record
-- "produced by <name>". Hard-deleting the row would leave those labels dangling, so a delete is a
-- tombstone: the key is wiped and the row is retired from every list, while the name, type and who
-- deleted it stay readable.
--
-- Additive and safe to re-run:
--   * `deleted_at`  — NULL for a live provider, the moment it was retired otherwise.
--   * `deleted_by`  — the founder who deleted it, for the audit trail.
--   * a partial index over the live rows, which is what every provider list and the failover pool
--     actually query.
--
-- The key itself is wiped to the empty string rather than NULL, because `encrypted_api_key` is
-- NOT NULL and no reader has to handle a null it never had to handle before.

ALTER TABLE research_providers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE research_providers ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS research_providers_live_idx
  ON research_providers (priority, created_at) WHERE deleted_at IS NULL;
