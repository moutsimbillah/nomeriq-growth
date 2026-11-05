-- 024_email_bounces.sql
-- Bounce handling: a permanent bounce becomes a suppression, a soft bounce is retried and then
-- suppressed, and a sending profile whose bounce rate runs above 3% over its last 50 sends pauses
-- itself. Three additive changes, each safe to re-run.
--
-- 1. `email_bounces` records every delivery report we could read, so a soft bounce can be counted
--    rather than guessed at on the next attempt. It stores no message content: the address, the DSN
--    status, the diagnostic line and the message it came from.
-- 2. `email_accounts.status` gains `paused_bounce`, so an automatic pause is distinguishable from a
--    mailbox the founder disabled and from one that is merely failing.
-- 3. `messages.sent_copy_saved_at` marks a sent message whose copy has been confirmed in the mailbox's
--    Sent folder, so it is never checked or appended twice.

CREATE TABLE IF NOT EXISTS email_bounces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES email_accounts(id) ON DELETE SET NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  normalized_email text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('permanent', 'transient', 'complaint')),
  dsn_status text,
  diagnostic text,
  action text NOT NULL CHECK (action IN ('suppressed', 'retried')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_bounces_email_idx ON email_bounces(normalized_email, created_at DESC);
CREATE INDEX IF NOT EXISTS email_bounces_account_idx ON email_bounces(account_id, created_at DESC);

ALTER TABLE email_accounts DROP CONSTRAINT IF EXISTS email_accounts_status_check;
ALTER TABLE email_accounts ADD CONSTRAINT email_accounts_status_check
  CHECK (status IN ('unverified', 'connected', 'error', 'disabled', 'paused_bounce'));

ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS bounce_paused_at timestamptz;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS bounce_paused_note text;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_copy_saved_at timestamptz;

-- The bounce rate looks only at recent sends, so the query that feeds it needs this index.
CREATE INDEX IF NOT EXISTS outbound_sends_account_completed_idx
  ON outbound_sends(account_id, completed_at DESC);

-- Lock the new table down the same way as every other table. Row-level security on, and no
-- privileges for PUBLIC. No role-specific grants, because this server has no `anon` or
-- `authenticated` role to revoke from.
ALTER TABLE email_bounces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON email_bounces FROM PUBLIC;