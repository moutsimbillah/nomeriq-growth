import { createHash, randomBytes } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { AppError, asStringArray, iso } from "@/lib/utils";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const ALLOWED_SCOPES = [
  "research:read",
  "research:write",
  "drafts:write",
  "product_truth:read",
  "conversations:read",
  "progress:read",
] as const;

export type ApiScope = (typeof ALLOWED_SCOPES)[number];

export interface ApiKeyIdentity {
  id: string;
  name: string;
  assistant: "chatgpt" | "claude" | "custom";
  scopes: string[];
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export async function createApiKey(input: {
  name: string;
  assistant: "chatgpt" | "claude" | "custom";
  scopes?: string[];
  userId: string;
}): Promise<{ id: string; key: string; prefix: string }> {
  if (!input.name.trim()) throw new AppError("Give the API key a name.");
  const scopes = (input.scopes?.length ? input.scopes : [...ALLOWED_SCOPES]).filter(
    (scope): scope is ApiScope =>
      (ALLOWED_SCOPES as readonly string[]).includes(scope) &&
      scope !== ("send:write" as string),
  );
  if (!scopes.length) throw new AppError("Select at least one permission.");
  const key = `ng_live_${randomBytes(32).toString("base64url")}`;
  const prefix = key.slice(0, 15);
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO api_keys (id, name, assistant, key_prefix, key_hash, scopes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      id,
      input.name.trim(),
      input.assistant,
      prefix,
      hashKey(key),
      JSON.stringify(scopes),
      input.userId,
    ],
  );
  return { id, key, prefix };
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
    throw new AppError("Invalid or revoked API key.", 401, "unauthorized");
  }
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
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}
