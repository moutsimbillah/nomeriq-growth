-- The app owns identity/footer composition; AI draft bodies never own these settings.
-- Defaults preserve the existing enabled behavior without changing saved identity text.
ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS sender_signature_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS postal_address_enabled boolean NOT NULL DEFAULT true;
