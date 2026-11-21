-- 037_campaign_batch_pacing.sql
-- Founder-authorised batch campaign builder: a campaign can be scheduled, paced per minute, created
-- from a filter set as one approved batch, and run through every selected item automatically with a
-- per-item-vs-system failure distinction. Additive and safe to re-run: new nullable columns, a new
-- journal table and three indexes on tables that already exist; no existing column, constraint or row
-- is altered or dropped.
--
-- per_minute_cap: how many sends a campaign may make in any rolling 60-second window.
--   NULL means no per-minute limit — sends go back to back, one after another as soon as the
--   previous one succeeded. An explicit 0 or 7+ is refused by the CHECK, never clamped; the
--   sanctioned "none" is NULL, and only the app default (3) supplies a number when the founder
--   does not choose one. The campaign's own daily snapshot, the mailbox's minimum interval, the
--   scheduled start, the campaign status and the full per-send gate all still apply either way.
--
-- batch_size: how many drafts the batch selected; 0 marks a campaign created before this migration,
--   whose real selection is not recoverable, so it is never read as "an empty batch".
--
-- filter_spec: the filters that produced the batch, recorded for the audit trail; '{}' for a
--   campaign created one draft at a time.
--
-- consecutive_failures: the circuit breaker's counter; 3 in a row pauses the campaign as systemic.
-- last_error: the reason recorded when a system failure or the circuit breaker pauses the campaign.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS per_minute_cap integer
    CHECK (per_minute_cap IS NULL OR per_minute_cap BETWEEN 1 AND 6);

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS batch_size integer NOT NULL DEFAULT 0;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS filter_spec jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS last_error text;

-- The pacing query counts this campaign's recent sends; this is the index it needs.
CREATE INDEX IF NOT EXISTS outbound_sends_campaign_completed_idx
  ON outbound_sends (campaign_id, completed_at DESC);

-- The scheduler reads campaigns that are due to start.
CREATE INDEX IF NOT EXISTS campaigns_due_idx
  ON campaigns (status, scheduled_at);

-- Every skipped or stopped item is named here as well as on its own row, so the founder sees e.g.
-- "12 sent, 2 skipped (bounced), 1 discarded draft" instead of a number that quietly shrank.
CREATE TABLE IF NOT EXISTS campaign_run_journal (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  level text NOT NULL CHECK (level IN ('item_skipped', 'system_failure', 'paused', 'resumed', 'completed')),
  item_id uuid,
  draft_id uuid,
  reason text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaign_run_journal_campaign_idx
  ON campaign_run_journal (campaign_id, created_at DESC);
