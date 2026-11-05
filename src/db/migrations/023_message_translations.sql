-- 023_message_translations.sql
-- Translations are stored beside the original message and never overwrite it.
-- The cache is keyed by source_hash, so a row goes stale (and is invalidated)
-- when the imported excerpt it was built from is later filled in.
-- Only successful translations, or a detected-English result, are cached;
-- failures remain retryable and message content is never logged.

CREATE TABLE IF NOT EXISTS message_translations (
  message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  source_hash text NOT NULL,
  source_language text NOT NULL,
  translated_text text NOT NULL DEFAULT '',
  provider text NOT NULL,
  model text,
  status text NOT NULL CHECK (status IN ('translated', 'english')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE message_translations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON message_translations FROM PUBLIC;

-- Same convention as the other tables: the app owner bypasses RLS (the owning
-- role is not FORCE'd), and the client roles are revoked only if they exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON message_translations FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON message_translations FROM authenticated';
  END IF;
END $$;
