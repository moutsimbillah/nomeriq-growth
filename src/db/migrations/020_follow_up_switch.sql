-- Automatic follow-ups are off until the founder switches them on.
--
-- The 04:00 job would otherwise draft a follow-up for every contacted lead in one run, which on the import is
-- 360 leads whose last send is months old. Two settings replace that: a switch, and the most drafts the job
-- may create in one day. Additive and safe to re-run.

ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS follow_up_auto_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS follow_up_daily_limit integer NOT NULL DEFAULT 10;

DO $do$
BEGIN
  ALTER TABLE workspace_settings ADD CONSTRAINT workspace_settings_follow_up_daily_limit_check
    CHECK (follow_up_daily_limit >= 0 AND follow_up_daily_limit <= 50);
EXCEPTION WHEN duplicate_object THEN NULL;
END $do$;
