-- Sending profiles: a mailbox becomes a profile with its own signature and warm-up, and each lead is
-- tied to the profile that first emailed it, so a prospect never hears from two addresses.
--
-- Additive and safe to re-run: four nullable columns (one with a default), two indexes. No existing row
-- is touched — a lead with no profile simply resolves to the default account at send time.

ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS signature text NOT NULL DEFAULT '';
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS warmup_started_at timestamptz;

ALTER TABLE prospects ADD COLUMN IF NOT EXISTS sending_profile_id uuid
  REFERENCES email_accounts(id) ON DELETE SET NULL;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS sending_profile_pinned_at timestamptz;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS sending_profile_id uuid
  REFERENCES email_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS prospects_sending_profile_idx ON prospects (sending_profile_id);
CREATE INDEX IF NOT EXISTS conversations_sending_profile_idx ON conversations (sending_profile_id);
