-- 010: OAuth 2.1 for hosted MCP clients.
-- claude.ai and ChatGPT register a remote connector through dynamic client registration and
-- an authorization-code flow; they will not accept a static API key. These tables let a
-- connector be registered, approved once by the signed-in founder, and exchanged for an
-- opaque access token that the MCP accepts alongside API keys.
--
-- Additive and safe to re-run. No existing table is touched.

CREATE TABLE IF NOT EXISTS oauth_clients (
  id uuid PRIMARY KEY,
  client_id text NOT NULL UNIQUE,
  client_secret text NOT NULL,
  client_name text NOT NULL DEFAULT '',
  redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_endpoint_auth_method text NOT NULL DEFAULT 'client_secret_post',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code text PRIMARY KEY,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  scope text NOT NULL DEFAULT '',
  code_challenge text,
  code_challenge_method text,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_codes_expiry_idx ON oauth_codes (expires_at);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash text PRIMARY KEY,
  client_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_tokens_expiry_idx ON oauth_tokens (expires_at);