import { createHash, randomBytes } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { AppError, asStringArray, iso } from "@/lib/utils";
import { ALLOWED_SCOPES, DEFAULT_SCOPES, type ApiScope } from "./scopes";
import { verifyOAuthToken } from "@/lib/oauth/server";

/* eslint-disable @typescript-eslint/no-explicit-any */

export { ALLOWED_SCOPES, DEFAULT_SCOPES };
export type { ApiScope };


export interface ApiKeyIdentity {
  id: string;
  name: string;
  assistant: "chatgpt" | "claude" | "deepseek" | "hermes" | "custom";
  scopes: string[];
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Fixed-window, in-memory request limiter keyed by API key id.
 *
 * This limiter is per-process, exactly like the existing login limiter in
 * `src/lib/auth/request.ts`: counters live in a module-level Map, so every
 * server instance keeps its own and a restart clears them. That is enough to
 * blunt a runaway agent loop, but a platform-level limiter (edge/WAF or a
 * shared store such as Redis) is still recommended in production.
 */
const apiKeyWindows = new Map<string, { count: number; resetAt: number }>();

const API_KEY_WINDOW_MS = 60_000;
const DEFAULT_API_KEY_RATE_LIMIT = 120;

function apiKeyRateLimit(): number {
  const parsed = Number(process.env.API_KEY_RATE_LIMIT_PER_MIN);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_API_KEY_RATE_LIMIT;
}

function checkApiKeyRateLimit(keyId: string): void {
  const limit = apiKeyRateLimit();
  const now = Date.now();
  const record = apiKeyWindows.get(keyId);
  if (!record || record.resetAt <= now) {
    apiKeyWindows.set(keyId, { count: 1, resetAt: now + API_KEY_WINDOW_MS });
    return;
  }
  record.count += 1;
  if (record.count > limit) {
    throw new AppError(
      `Rate limit exceeded: ${limit} requests per minute per API key. Retry in a minute.`,
      429,
      "rate_limited",
    );
  }
}

/** Clears the per-key windows. Tests call this between cases. */
export function resetApiKeyRateLimits(): void {
  apiKeyWindows.clear();
}

export async function createApiKey(input: {
  name: string;
  assistant: "chatgpt" | "claude" | "deepseek" | "hermes" | "custom";
  scopes?: string[];
  expiresInDays?: number;
  userId: string;
}): Promise<{ id: string; key: string; prefix: string; expiresAt: string }> {
  if (!input.name.trim()) throw new AppError("Give the API key a name.");
  const expiresInDays = input.expiresInDays ?? 90;
  if (
    !Number.isInteger(expiresInDays) ||
    expiresInDays < 1 ||
    expiresInDays > 365
  ) {
    throw new AppError(
      "API key expiry must be a whole number of days between 1 and 365.",
    );
  }
  const scopes = (
    input.scopes?.length ? input.scopes : [...DEFAULT_SCOPES]
  ).filter(
    (scope): scope is ApiScope =>
      (ALLOWED_SCOPES as readonly string[]).includes(scope) &&
      scope !== ("send:write" as string),
  );
  if (!scopes.length) throw new AppError("Select at least one permission.");
  const key = `ng_live_${randomBytes(32).toString("base64url")}`;
  const prefix = key.slice(0, 15);
  const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000);
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO api_keys (id, name, assistant, key_prefix, key_hash, scopes, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      id,
      input.name.trim(),
      input.assistant,
      prefix,
      hashKey(key),
      JSON.stringify(scopes),
      input.userId,
      expiresAt,
    ],
  );
  return { id, key, prefix, expiresAt: expiresAt.toISOString() };
}

export async function listApiKeys() {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT k.*, u.name AS creator_name
     FROM api_keys k LEFT JOIN users u ON u.id = k.created_by
     ORDER BY k.created_at DESC`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    assistant: row.assistant,
    prefix: row.key_prefix,
    scopes: asStringArray(row.scopes),
    creatorName: row.creator_name,
    createdAt: iso(row.created_at),
    lastUsedAt: iso(row.last_used_at),
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
  }));
}

export async function revokeApiKey(id: string): Promise<void> {
  const db = await getDb();
  const result = await db.query(
    `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
  if (!result.rowCount) throw new AppError("API key not found or already revoked.", 404);
}

export async function authenticateApiKey(
  request: Request,
): Promise<ApiKeyIdentity> {
  const auth = request.headers.get("authorization");
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const headerKey = request.headers.get("x-api-key")?.trim();
  const key = bearer || headerKey;
  if (!key) {
    throw new AppError(
      "Provide a Growth API key as a Bearer token.",
      401,
      "unauthorized",
    );
  }
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT * FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL LIMIT 1`,
    [hashKey(key)],
  );
  const row = result.rows[0];
  if (!row) {
    // Hosted MCP connectors (claude.ai, ChatGPT) authenticate with an OAuth access token
    // rather than an API key, so the same header is checked against that store too.
    const oauth = await verifyOAuthToken(key);
    if (oauth) {
      return {
        id: `oauth:${oauth.clientId}`,
        name: oauth.clientName || "MCP connector",
        assistant: "custom",
        scopes: oauth.scopes,
      };
    }
    throw new AppError("Invalid or revoked API key.", 401, "unauthorized");
  }
  const expiresAt = iso(row.expires_at);
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
    throw new AppError(
      `This API key expired on ${expiresAt.slice(0, 10)}. Create a new key in Settings.`,
      401,
      "key_expired",
    );
  }
  checkApiKeyRateLimit(row.id);
  await db.query(
    `UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND
      (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [row.id],
  );
  return {
    id: row.id,
    name: row.name,
    assistant: row.assistant,
    scopes: asStringArray(row.scopes),
  };
}

export function requireScope(key: ApiKeyIdentity, scope: ApiScope): void {
  if (!key.scopes.includes(scope)) {
    throw new AppError(
      `This API key lacks the ${scope} permission.`,
      403,
      "insufficient_scope",
    );
  }
}

const CLIENT_NAME_MAX = 80;

/**
 * Client names are self-declared, so they are untrusted text: strip control characters (including
 * line breaks, which would forge an extra line in any log or report that renders the entry) and cap
 * the length so one client cannot bloat the audit table.
 */
export function auditClientName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CLIENT_NAME_MAX);
}

export async function logAgentAction(input: {
  key: ApiKeyIdentity;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO audit_log
      (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      crypto.randomUUID(),
      `api_key:${input.key.assistant}`,
      input.key.id,
      input.action,
      input.entityType ?? null,
      input.entityId ?? null,
      // The client's own name travels with every entry. OAuth-connected clients (claude.ai,
      // ChatGPT, Gemini) present no API key, so without it they are all `api_key:custom` and can
      // only be separated by joining actor_id back to oauth_clients. The name is self-declared by
      // the client: reporting only, never read for permissions, scopes or trust.
      JSON.stringify({ ...(input.metadata ?? {}), client: auditClientName(input.key.name) }),
    ],
  );
}
