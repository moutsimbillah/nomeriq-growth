import fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import {
  authenticateApiKey,
  createApiKey,
  resetApiKeyRateLimits,
  revokeApiKey,
} from "@/lib/agent/apiKeys";
import { DEFAULT_SCOPES } from "@/lib/agent/scopes";
import { AppError } from "@/lib/utils";

const state: { userId: string } = { userId: "" };

function bearerRequest(key: string): Request {
  return new Request("https://growth.nomeriq.info/api/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
  });
}

function sorted(values: Iterable<string>): string[] {
  return [...values].map((value) => String(value)).sort();
}

describe("API key security", () => {
  beforeAll(async () => {
    const db = await getDb();
    await ensureWorkspaceDefaults();
    state.userId = crypto.randomUUID();
    await db.query(
      `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, 'founder')`,
      [state.userId, "apikey@test.nomeriq.com", "apikey@test.nomeriq.com", "API Key Founder", hashPassword("TestPassw0rd!123")],
    );
  });

  afterEach(() => {
    resetApiKeyRateLimits();
    delete process.env.API_KEY_RATE_LIMIT_PER_MIN;
  });

  afterAll(async () => {
    await closeDb();
    const dir = process.env.PGLITE_DIR || "";
    if (dir.startsWith(".data/test-vitest-")) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("authenticates a created key and returns its identity id", async () => {
    const created = await createApiKey({
      name: "primary key",
      assistant: "claude",
      userId: state.userId,
    });

    const identity = await authenticateApiKey(bearerRequest(created.key));

    expect(identity.id).toBe(created.id);
    expect(identity.name).toBe("primary key");
    expect(identity.assistant).toBe("claude");
  });

  it("stores exactly the default scopes when none are given, and honours explicit scopes", async () => {
    const defaulted = await createApiKey({
      name: "default scopes",
      assistant: "chatgpt",
      userId: state.userId,
    });

    const defaultedIdentity = await authenticateApiKey(bearerRequest(defaulted.key));
    expect(sorted(defaultedIdentity.scopes)).toEqual(sorted(DEFAULT_SCOPES));
    expect(defaultedIdentity.scopes).not.toContain("conversations:read");

    const explicit = await createApiKey({
      name: "explicit scopes",
      assistant: "deepseek",
      scopes: ["research:read"],
      userId: state.userId,
    });

    const explicitIdentity = await authenticateApiKey(bearerRequest(explicit.key));
    expect(sorted(explicitIdentity.scopes)).toEqual(["research:read"]);
  });

  it("rejects expired keys with key_expired and still accepts a future expiry", async () => {
    const expired = await createApiKey({
      name: "expired key",
      assistant: "deepseek",
      userId: state.userId,
    });

    const db = await getDb();
    await db.query("UPDATE api_keys SET expires_at = now() - interval '1 day' WHERE id = $1", [expired.id]);

    await expect(authenticateApiKey(bearerRequest(expired.key))).rejects.toMatchObject({
      status: 401,
      code: "key_expired",
      message: expect.stringMatching(/expired/i),
    });

    const future = await createApiKey({
      name: "future key",
      assistant: "hermes",
      expiresInDays: 1,
      userId: state.userId,
    });

    const futureIdentity = await authenticateApiKey(bearerRequest(future.key));
    expect(futureIdentity.id).toBe(future.id);
  });

  it("rejects expiresInDays outside the 1..365 range", async () => {
    await expect(
      createApiKey({ name: "zero days", assistant: "claude", expiresInDays: 0, userId: state.userId }),
    ).rejects.toBeInstanceOf(AppError);

    await expect(
      createApiKey({ name: "too many days", assistant: "claude", expiresInDays: 400, userId: state.userId }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("rejects a revoked key with unauthorized", async () => {
    const created = await createApiKey({
      name: "revoked key",
      assistant: "custom",
      userId: state.userId,
    });

    const beforeRevoke = await authenticateApiKey(bearerRequest(created.key));
    expect(beforeRevoke.id).toBe(created.id);

    await revokeApiKey(created.id);

    await expect(authenticateApiKey(bearerRequest(created.key))).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });

  it("rate limits a single key per window without limiting a different key", async () => {
    process.env.API_KEY_RATE_LIMIT_PER_MIN = "3";
    resetApiKeyRateLimits();

    const limited = await createApiKey({
      name: "limited key",
      assistant: "claude",
      userId: state.userId,
    });
    const other = await createApiKey({
      name: "other key",
      assistant: "claude",
      userId: state.userId,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const identity = await authenticateApiKey(bearerRequest(limited.key));
      expect(identity.id).toBe(limited.id);
    }

    await expect(authenticateApiKey(bearerRequest(limited.key))).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });

    const otherIdentity = await authenticateApiKey(bearerRequest(other.key));
    expect(otherIdentity.id).toBe(other.id);
  });
});
