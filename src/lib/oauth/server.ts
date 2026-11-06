import crypto from "node:crypto";

import { ALLOWED_SCOPES, DEFAULT_SCOPES } from "@/lib/agent/scopes";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/utils";

/**
 * OAuth 2.1 for hosted MCP connectors.
 *
 * claude.ai and ChatGPT will not accept a static API key for a remote connector: they
 * register themselves (dynamic client registration), send the founder through an
 * authorization-code flow, and then call the MCP with the token they received. Everything
 * here exists so that a connector ends up with an opaque token bound to one user and a
 * scope list limited to the founder's consent — email permissions are opt-in,
 * never send, approve, queue, delete, settings or job controls.
 */

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 8;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
export const AUTH_CODE_TTL_SECONDS = 60 * 10;
export const SUPPORTED_SCOPES = [...ALLOWED_SCOPES] as string[];

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function hashToken(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export interface RegisteredClient {
  clientId: string;
  clientSecret: string;
  clientName: string;
  redirectUris: string[];
}

function cleanRedirectUris(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new AppError("redirect_uris must be an array.", 400, "invalid_client_metadata");
  }

  const uris = input
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim())
    .slice(0, 10);

  if (!uris.length) {
    throw new AppError("At least one redirect_uri is required.", 400, "invalid_client_metadata");
  }

  for (const uri of uris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new AppError(`redirect_uri is not a valid URL: ${uri}`, 400, "invalid_client_metadata");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new AppError("redirect_uri must be http or https.", 400, "invalid_client_metadata");
    }
    if (uri.length > 2000) {
      throw new AppError("redirect_uri is too long.", 400, "invalid_client_metadata");
    }
  }

  return uris;
}

export const OAUTH_PENDING_CLIENT_LIMIT = 50;

/**
 * A client is "pending" until a token is issued for it — that is, until the founder has
 * actually approved a connector. Registration is open, so this cap is what stops an
 * unbounded flood of unapproved clients from growing the table forever.
 */
export async function countPendingClients(): Promise<number> {
  const db = await getDb();
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM oauth_clients WHERE last_used_at IS NULL`,
  );
  return Number(result.rows[0]?.n ?? 0);
}

export async function assertClientCapacity(): Promise<void> {
  const pending = await countPendingClients();
  if (pending >= OAUTH_PENDING_CLIENT_LIMIT) {
    throw new AppError(
      `Too many connectors are waiting to be approved (${pending}). Approve or remove one before registering another.`,
      429,
      "client_capacity_reached",
    );
  }
}

export async function registerOAuthClient(input: {
  clientName?: unknown;
  redirectUris?: unknown;
}): Promise<RegisteredClient> {
  const db = await getDb();
  const clientName =
    typeof input.clientName === "string" && input.clientName.trim()
      ? input.clientName.trim().slice(0, 100)
      : "MCP connector";
  const redirectUris = cleanRedirectUris(input.redirectUris);

  const clientId = `nq_${randomToken(16)}`;
  const clientSecret = randomToken(32);

  await db.query(
    `INSERT INTO oauth_clients (id, client_id, client_secret, client_name, redirect_uris)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [crypto.randomUUID(), clientId, hashToken(clientSecret), clientName, JSON.stringify(redirectUris)],
  );

  return { clientId, clientSecret, clientName, redirectUris };
}

export async function getOAuthClient(clientId: string) {
  const db = await getDb();
  const result = await db.query<{
    client_id: string;
    client_name: string;
    redirect_uris: string[];
  }>(`SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = $1`, [
    clientId,
  ]);
  return result.rows[0] ?? null;
}

export async function clientAllowsRedirect(clientId: string, redirectUri: string): Promise<boolean> {
  const client = await getOAuthClient(clientId);
  if (!client) return false;
  const uris = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
  return uris.includes(redirectUri);
}

/** Parse an explicit grant without EVER replacing an empty grant with defaults. */
function explicitScopes(scope: string): string[] {
  const requested = [...new Set(scope.split(/\s+/).filter(Boolean))];
  if (requested.some((entry) => !SUPPORTED_SCOPES.includes(entry))) {
    throw new AppError("Unsupported scope requested.", 400, "invalid_scope");
  }
  return requested;
}

/** Defaults apply only at authorization-request ingress, not to stored grants. */
export function scopesFromRequest(scope: unknown): string[] {
  if (scope == null || scope === "") return [...DEFAULT_SCOPES];
  if (typeof scope !== "string") {
    throw new AppError("scope must be a string.", 400, "invalid_scope");
  }
  return explicitScopes(scope);
}

export async function createAuthorizationCode(input: {
  clientId: string;
  redirectUri: string;
  scope: string;
  userId: string;
  codeChallenge?: string | null;
  codeChallengeMethod?: string | null;
}): Promise<string> {
  const db = await getDb();
  const scope = explicitScopes(input.scope).join(" ");
  const code = randomToken(32);

  await db.query(
    `INSERT INTO oauth_codes
       (code, client_id, redirect_uri, scope, code_challenge, code_challenge_method, user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' seconds')::interval)`,
    [
      code,
      input.clientId,
      input.redirectUri,
      scope,
      input.codeChallenge ?? null,
      input.codeChallengeMethod ?? null,
      input.userId,
      String(AUTH_CODE_TTL_SECONDS),
    ],
  );

  return code;
}

function verifyPkce(verifier: string, challenge: string, method: string | null): boolean {
  const expected =
    (method ?? "S256").toUpperCase() === "S256"
      ? crypto.createHash("sha256").update(verifier).digest("base64url")
      : verifier;
  const a = Buffer.from(expected);
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  clientId: string;
  clientSecret?: string | null;
  codeVerifier?: string | null;
  redirectUri?: string | null;
}): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
  tokenType: "Bearer";
}> {
  const db = await getDb();

  const clientRows = await db.query<{ client_secret: string; redirect_uris: string[] }>(
    `SELECT client_secret, redirect_uris FROM oauth_clients WHERE client_id = $1`,
    [input.clientId],
  );
  const client = clientRows.rows[0];
  if (!client) throw new AppError("Unknown client.", 401, "invalid_client");

  if (input.clientSecret) {
    const given = hashToken(input.clientSecret);
    const expected = client.client_secret;
    if (
      given.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))
    ) {
      throw new AppError("Invalid client credentials.", 401, "invalid_client");
    }
  }

  const codeRows = await db.query<{
    client_id: string;
    redirect_uri: string;
    scope: string;
    code_challenge: string | null;
    code_challenge_method: string | null;
    user_id: string;
    expired: boolean;
    used: boolean;
  }>(
    `SELECT client_id, redirect_uri, scope, code_challenge, code_challenge_method, user_id,
            (expires_at <= now()) AS expired, (used_at IS NOT NULL) AS used
       FROM oauth_codes WHERE code = $1`,
    [input.code],
  );
  const code = codeRows.rows[0];
  if (!code) throw new AppError("Unknown authorization code.", 400, "invalid_grant");
  if (code.used) throw new AppError("This authorization code was already used.", 400, "invalid_grant");
  if (code.expired) throw new AppError("This authorization code expired.", 400, "invalid_grant");
  if (code.client_id !== input.clientId) {
    throw new AppError("The code was issued to a different client.", 400, "invalid_grant");
  }
  if (input.redirectUri && input.redirectUri !== code.redirect_uri) {
    throw new AppError("redirect_uri does not match the code.", 400, "invalid_grant");
  }
  if (code.code_challenge) {
    if (!input.codeVerifier) {
      throw new AppError("A code_verifier is required.", 400, "invalid_grant");
    }
    if (!verifyPkce(input.codeVerifier, code.code_challenge, code.code_challenge_method)) {
      throw new AppError("The code_verifier does not match the challenge.", 400, "invalid_grant");
    }
  }

  // A code carries the consent grant, not a fresh authorization request. Empty
  // grants remain empty, and concurrent exchanges can claim the code only once.
  const scopes = explicitScopes(code.scope);
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  await db.transaction(async (tx) => {
    const claimed = await tx.query(
      `UPDATE oauth_codes SET used_at = now()
       WHERE code = $1 AND used_at IS NULL AND expires_at > now() RETURNING code`,
      [input.code],
    );
    if (!claimed.rowCount) {
      throw new AppError("This authorization code was already used or expired.", 400, "invalid_grant");
    }
    await tx.query(
      `INSERT INTO oauth_tokens (token_hash, client_id, user_id, scopes, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, now() + ($5 || ' seconds')::interval)`,
      [hashToken(accessToken), input.clientId, code.user_id, JSON.stringify(scopes), String(ACCESS_TOKEN_TTL_SECONDS)],
    );
    await tx.query(`UPDATE oauth_clients SET last_used_at = now() WHERE client_id = $1`, [input.clientId]);
    await tx.query(
      `INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scopes, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, now() + ($5 || ' seconds')::interval)`,
      [hashToken(refreshToken), input.clientId, code.user_id, JSON.stringify(scopes), String(REFRESH_TOKEN_TTL_SECONDS)],
    );
  });

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    scope: scopes.join(" "),
    tokenType: "Bearer",
  };
}

/**
 * Refresh grant. The presented refresh token is rotated: it is revoked and a new pair issued,
 * so a leaked refresh token cannot be replayed after the client has used it.
 */
export async function refreshAccessToken(input: {
  refreshToken: string;
  clientId: string;
  clientSecret?: string | null;
  scope?: string | null;
}): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
  tokenType: "Bearer";
}> {
  const db = await getDb();

  const clientRows = await db.query<{ client_secret: string }>(
    `SELECT client_secret FROM oauth_clients WHERE client_id = $1`,
    [input.clientId],
  );
  const client = clientRows.rows[0];
  if (!client) throw new AppError("Unknown client.", 401, "invalid_client");

  if (input.clientSecret) {
    const given = hashToken(input.clientSecret);
    if (
      given.length !== client.client_secret.length ||
      !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(client.client_secret))
    ) {
      throw new AppError("Invalid client credentials.", 401, "invalid_client");
    }
  }

  const rows = await db.query<{
    client_id: string;
    user_id: string;
    scopes: string[];
    expired: boolean;
    revoked: boolean;
  }>(
    `SELECT client_id, user_id, scopes,
            (expires_at <= now()) AS expired, (revoked_at IS NOT NULL) AS revoked
       FROM oauth_refresh_tokens WHERE token_hash = $1`,
    [hashToken(input.refreshToken)],
  );
  const row = rows.rows[0];
  if (!row) throw new AppError("Unknown refresh token.", 400, "invalid_grant");
  if (row.revoked) throw new AppError("This refresh token was already used.", 400, "invalid_grant");
  if (row.expired) throw new AppError("This refresh token expired.", 400, "invalid_grant");
  if (row.client_id !== input.clientId) {
    throw new AppError("The refresh token was issued to a different client.", 400, "invalid_grant");
  }

  const granted = explicitScopes(row.scopes.join(" "));
  const scopes = input.scope == null ? granted : explicitScopes(input.scope);
  if (scopes.some((scope) => !granted.includes(scope))) {
    throw new AppError("Refresh scope must be a subset of the original grant.", 400, "invalid_scope");
  }
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);

  await db.transaction(async (tx) => {
    const claimed = await tx.query(`UPDATE oauth_refresh_tokens SET revoked_at = now(), last_used_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() RETURNING token_hash`, [
      hashToken(input.refreshToken),
    ]);
    if (!claimed.rowCount) throw new AppError("This refresh token was already used or expired.", 400, "invalid_grant");
    await tx.query(
      `INSERT INTO oauth_tokens (token_hash, client_id, user_id, scopes, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, now() + ($5 || ' seconds')::interval)`,
      [hashToken(accessToken), input.clientId, row.user_id, JSON.stringify(scopes), String(ACCESS_TOKEN_TTL_SECONDS)],
    );
    await tx.query(
      `INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scopes, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, now() + ($5 || ' seconds')::interval)`,
      [hashToken(refreshToken), input.clientId, row.user_id, JSON.stringify(scopes), String(REFRESH_TOKEN_TTL_SECONDS)],
    );
  });

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    scope: scopes.join(" "),
    tokenType: "Bearer",
  };
}

export async function verifyOAuthToken(token: string): Promise<{
  clientId: string;
  clientName: string;
  userId: string;
  scopes: string[];
} | null> {
  const db = await getDb();
  const result = await db.query<{
    client_id: string;
    user_id: string;
    scopes: string[];
    client_name: string;
    expired: boolean;
  }>(
    `SELECT t.client_id, t.user_id, t.scopes, c.client_name, (t.expires_at <= now()) AS expired
       FROM oauth_tokens t
       JOIN oauth_clients c ON c.client_id = t.client_id
      WHERE t.token_hash = $1`,
    [hashToken(token)],
  );

  const row = result.rows[0];
  if (!row || row.expired) return null;

  await db.query(`UPDATE oauth_tokens SET last_used_at = now() WHERE token_hash = $1`, [
    hashToken(token),
  ]);

  return {
    clientId: row.client_id,
    clientName: row.client_name,
    userId: row.user_id,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
  };
}