-- Workspace-controlled email delivery mode. NULL keeps the existing environment
-- setting as a one-time compatibility fallback until the founder chooses a mode.
ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS email_delivery_mode text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_settings_email_delivery_mode_check'
      AND conrelid = 'workspace_settings'::regclass
  ) THEN
    ALTER TABLE workspace_settings
      ADD CONSTRAINT workspace_settings_email_delivery_mode_check
      CHECK (email_delivery_mode IS NULL OR email_delivery_mode IN ('sandbox', 'live'));
  END IF;
END $$;
