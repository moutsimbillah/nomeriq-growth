-- 011: refresh tokens for hosted MCP connectors.
-- A connector that expects to stay connected across token expiry asks for a refresh token in
-- the authorization-code exchange. Without one, a strict client treats the grant as unusable
-- and never calls the MCP at all, which looks like a refusal after a successful sign-in.
--
-- Additive and safe to re-run.

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash text PRIMARY KEY,
  client_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_client_idx
  ON oauth_refresh_tokens (client_id, expires_at);