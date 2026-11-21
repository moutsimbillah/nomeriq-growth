-- 038_campaign_autostart.sql
-- A campaign the founder scheduled must start ITSELF when its time arrives, driven by the existing
-- server-side runner (the cron path that already calls runDueCampaigns) — no second click. Creating a
-- campaign WITH a future schedule is the founder's authorising act, and that act is what the audit row
-- records (`campaign.auto_started`). The run journal records both the start and the one case the
-- runner refuses to auto-start: a schedule the process missed by more than a day, which is left
-- approved for the founder rather than mass-started late.
--
-- Additive and safe to re-run: the only change is widening the journal `level` CHECK to admit the two
-- new lifecycle levels. No column, row or value is altered or dropped, and every value the old CHECK
-- accepted the new one still accepts — so re-running, or running 037 and 038 together on a fresh
-- database, is a no-op. The swap is guarded on the live constraint's own text, not on a remembered name.
DO $$
DECLARE
  stale text;
BEGIN
  SELECT conname INTO stale FROM pg_constraint
   WHERE conrelid = 'campaign_run_journal'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%item_skipped%'
     AND pg_get_constraintdef(oid) NOT LIKE '%auto_started%';
  IF stale IS NOT NULL THEN
    EXECUTE format('ALTER TABLE campaign_run_journal DROP CONSTRAINT %I', stale);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'campaign_run_journal'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%auto_started%'
  ) THEN
    ALTER TABLE campaign_run_journal ADD CONSTRAINT campaign_run_journal_level_check
      CHECK (level IN ('item_skipped', 'system_failure', 'paused', 'resumed', 'completed',
                       'auto_started', 'auto_start_held'));
  END IF;
END $$;
