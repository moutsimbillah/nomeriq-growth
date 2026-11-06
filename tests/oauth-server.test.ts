import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";

import { hashPassword } from "@/lib/auth/password";
import { closeDb, getDb } from "@/lib/db/client";
import {
  clientAllowsRedirect,
  createAuthorizationCode,
  exchangeAuthorizationCode,
  refreshAccessToken,
  registerOAuthClient,
  scopesFromRequest,
  verifyOAuthToken,
} from "@/lib/oauth/server";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { ALLOWED_SCOPES, DEFAULT_SCOPES } from "@/lib/agent/scopes";
import { SUPPORTED_SCOPES } from "@/lib/oauth/server";
import { POST as tokenPost } from "@/app/api/oauth/token/route";

const state = { userId: "" };
const VERIFIER = crypto.randomUUID() + crypto.randomUUID();

function challengeFor(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

beforeAll(async () => {
  const db = await getDb();
  await ensureWorkspaceDefaults();
  await db.query(`DELETE FROM oauth_tokens`).catch(() => undefined);
  await db.query(`DELETE FROM oauth_codes`).catch(() => undefined);
  await db.query(`DELETE FROM oauth_clients`).catch(() => undefined);

  state.userId = crypto.randomUUID();
  await db.query(
    `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
     VALUES ($1, $2, $3, $4, $5, 'founder')`,
    [
      state.userId,
      "oauth@test.nomeriq.com",
      "oauth@test.nomeriq.com",
      "OAuth Test",
      hashPassword(crypto.randomUUID()),
    ],
  );
});

afterAll(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM users WHERE id = $1`, [state.userId]);
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("oauth client registration", () => {
  it("registers a client and stores only a hash of its secret", async () => {
    const client = await registerOAuthClient({
      clientName: "Claude connector",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    });

    expect(client.clientId).toMatch(/^nq_/);
    expect(client.clientSecret.length).toBeGreaterThan(20);

    const db = await getDb();
    const row = await db.query<{ client_secret: string; client_name: string }>(
      `SELECT client_secret, client_name FROM oauth_clients WHERE client_id = $1`,
      [client.clientId],
    );
    expect(row.rows[0]!.client_name).toBe("Claude connector");
    expect(row.rows[0]!.client_secret).not.toBe(client.clientSecret);
    expect(row.rows[0]!.client_secret).toHaveLength(64);
  });

  it("refuses registration without a usable redirect_uri", async () => {
    await expect(registerOAuthClient({ redirectUris: [] })).rejects.toMatchObject({
      code: "invalid_client_metadata",
    });
    await expect(
      registerOAuthClient({ redirectUris: ["ftp://example.com/cb"] }),
    ).rejects.toMatchObject({ code: "invalid_client_metadata" });
    await expect(registerOAuthClient({ redirectUris: ["not a url"] })).rejects.toMatchObject({
      code: "invalid_client_metadata",
    });
  });

  it("accepts only the redirect URIs that were registered", async () => {
    const client = await registerOAuthClient({
      redirectUris: ["https://example.com/callback"],
    });

    expect(await clientAllowsRedirect(client.clientId, "https://example.com/callback")).toBe(true);
    expect(await clientAllowsRedirect(client.clientId, "https://evil.example/callback")).toBe(false);
  });

  it("supports opt-in email permissions but leaves the exact default grants unchanged", () => {
    expect(DEFAULT_SCOPES).toEqual([
      "research:read", "research:write", "drafts:write", "progress:read", "product_truth:read",
    ]);
    expect(SUPPORTED_SCOPES).toEqual([...ALLOWED_SCOPES]);
    for (const missing of [undefined, null, ""]) expect(scopesFromRequest(missing)).toEqual([...DEFAULT_SCOPES]);
    expect(scopesFromRequest("research:read conversations:read folders:read followups:read followups:write")).toEqual([
      "research:read", "conversations:read", "folders:read", "followups:read", "followups:write",
    ]);
    for (const forbidden of ["*", "send:write", "drafts:approve", "drafts:queue", "records:delete", "settings:write", "jobs:write"]) {
      expect(() => scopesFromRequest(forbidden)).toThrow(/unsupported scope/i);
      expect(ALLOWED_SCOPES as readonly string[]).not.toContain(forbidden);
    }
  });
});

describe("authorization code exchange", () => {
  async function issue(scope = "research:read research:write") {
    const client = await registerOAuthClient({
      redirectUris: ["https://example.com/callback"],
    });
    const code = await createAuthorizationCode({
      clientId: client.clientId,
      redirectUri: "https://example.com/callback",
      scope,
      userId: state.userId,
      codeChallenge: challengeFor(VERIFIER),
      codeChallengeMethod: "S256",
    });
    return { client, code };
  }

  it.each(["", "research:read", DEFAULT_SCOPES.join(" "), "folders:read conversations:read followups:read followups:write"])(
    "preserves the exact stored grant through exchange and omitted-scope refresh: %s", async (scope) => {
      const { client, code } = await issue(scope);
      const token = await exchangeAuthorizationCode({
        code, clientId: client.clientId, clientSecret: client.clientSecret, codeVerifier: VERIFIER,
      });
      expect(token.scope).toBe(scope);
      expect((await verifyOAuthToken(token.accessToken))!.scopes).toEqual(scope.split(/\s+/).filter(Boolean));
      const next = await refreshAccessToken({ refreshToken: token.refreshToken, clientId: client.clientId });
      expect(next.scope).toBe(scope);
      expect((await verifyOAuthToken(next.accessToken))!.scopes).toEqual(scope.split(/\s+/).filter(Boolean));
    },
  );

  it.each(["followups:write", "research:read conversations:read", "*", "send:write", "research:read unknown:scope"])(
    "rejects refresh expansion or unknown permissions without consuming the grant: %s", async (scope) => {
      const { client, code } = await issue("research:read");
      const token = await exchangeAuthorizationCode({ code, clientId: client.clientId, codeVerifier: VERIFIER });
      await expect(refreshAccessToken({ refreshToken: token.refreshToken, clientId: client.clientId, scope }))
        .rejects.toMatchObject({ code: "invalid_scope" });
      const preserved = await refreshAccessToken({ refreshToken: token.refreshToken, clientId: client.clientId });
      expect(preserved.scope).toBe("research:read");
    },
  );

  it.each(["research:read", ""])("keeps an explicitly narrowed refresh grant narrowed on later omission: %s", async (scope) => {
    const { client, code } = await issue("research:read conversations:read followups:write");
    const token = await exchangeAuthorizationCode({ code, clientId: client.clientId, codeVerifier: VERIFIER });
    const narrowed = await refreshAccessToken({ refreshToken: token.refreshToken, clientId: client.clientId, scope });
    expect(narrowed.scope).toBe(scope);
    expect((await verifyOAuthToken(narrowed.accessToken))!.scopes).toEqual(scope.split(/\s+/).filter(Boolean));
    await expect(refreshAccessToken({
      refreshToken: narrowed.refreshToken, clientId: client.clientId, scope: "conversations:read",
    })).rejects.toMatchObject({ code: "invalid_scope" });
    const later = await refreshAccessToken({ refreshToken: narrowed.refreshToken, clientId: client.clientId });
    expect(later.scope).toBe(scope);
  });

  it.each([undefined, "", "research:read", "research:read conversations:read followups:write"])(
    "ignores forged token-endpoint scope and uses only the authorization code grant: %s", async (scope) => {
      const { client, code } = await issue("research:read research:write");
      const body = new URLSearchParams({
        grant_type: "authorization_code", code, client_id: client.clientId, code_verifier: VERIFIER,
      });
      if (scope !== undefined) body.set("scope", scope);
      const response = await tokenPost(new Request("http://localhost:3100/api/oauth/token", { method: "POST", body }));
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.scope).toBe("research:read research:write");
      expect((await verifyOAuthToken(result.access_token))!.scopes).toEqual(["research:read", "research:write"]);
    },
  );

  it("exchanges a code with PKCE for a token that the MCP accepts", async () => {
    const { client, code } = await issue();

    const token = await exchangeAuthorizationCode({
      code,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      codeVerifier: VERIFIER,
      redirectUri: "https://example.com/callback",
    });

    expect(token.tokenType).toBe("Bearer");
    expect(token.expiresIn).toBeGreaterThan(0);

    const identity = await verifyOAuthToken(token.accessToken);
    expect(identity).not.toBeNull();
    expect(identity!.userId).toBe(state.userId);
    expect(identity!.clientId).toBe(client.clientId);
    expect(identity!.scopes).toEqual(["research:read", "research:write"]);
  });

  it("refuses to reuse a code", async () => {
    const { client, code } = await issue();

    await exchangeAuthorizationCode({
      code,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      codeVerifier: VERIFIER,
      redirectUri: "https://example.com/callback",
    });

    await expect(
      exchangeAuthorizationCode({
        code,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        codeVerifier: VERIFIER,
        redirectUri: "https://example.com/callback",
      }),
    ).rejects.toThrow(/already used/i);
  });

  it("allows only one concurrent claim of a code and of its refresh token", async () => {
    const { client, code } = await issue("research:read");
    const exchange = () => exchangeAuthorizationCode({ code, clientId: client.clientId, codeVerifier: VERIFIER });
    const results = await Promise.allSettled([exchange(), exchange()]);
    expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    const token = results.find((entry) => entry.status === "fulfilled")!;
    if (token.status !== "fulfilled") throw new Error("Expected one exchange");
    const refresh = () => refreshAccessToken({ refreshToken: token.value.refreshToken, clientId: client.clientId });
    const refreshed = await Promise.allSettled([refresh(), refresh()]);
    expect(refreshed.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(refreshed.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    const success = refreshed.find((entry) => entry.status === "fulfilled")!;
    if (success.status !== "fulfilled") throw new Error("Expected one refresh");
    expect(success.value.scope).toBe("research:read");
  });

  it("refuses a wrong PKCE verifier", async () => {
    const { client, code } = await issue();

    await expect(
      exchangeAuthorizationCode({
        code,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        codeVerifier: crypto.randomUUID(),
        redirectUri: "https://example.com/callback",
      }),
    ).rejects.toThrow(/code_verifier/i);
  });

  it("refuses a wrong client secret", async () => {
    const { client, code } = await issue();

    await expect(
      exchangeAuthorizationCode({
        code,
        clientId: client.clientId,
        clientSecret: crypto.randomUUID(),
        codeVerifier: VERIFIER,
        redirectUri: "https://example.com/callback",
      }),
    ).rejects.toMatchObject({ code: "invalid_client" });
  });

  it("refuses a redirect_uri that differs from the one in the code", async () => {
    const { client, code } = await issue();

    await expect(
      exchangeAuthorizationCode({
        code,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        codeVerifier: VERIFIER,
        redirectUri: "https://example.com/other",
      }),
    ).rejects.toThrow(/redirect_uri/i);
  });

  it("refuses an expired token", async () => {
    const { client, code } = await issue();
    const token = await exchangeAuthorizationCode({
      code,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      codeVerifier: VERIFIER,
      redirectUri: "https://example.com/callback",
    });

    expect(await verifyOAuthToken(token.accessToken)).not.toBeNull();

    const db = await getDb();
    await db.query(`UPDATE oauth_tokens SET expires_at = now() - interval '1 hour'`);

    expect(await verifyOAuthToken(token.accessToken)).toBeNull();
  });

  it("does not treat a random string as a token", async () => {
    expect(await verifyOAuthToken(crypto.randomUUID())).toBeNull();
  });

  it("issues a refresh token and rotates it on use", async () => {
    const { client, code } = await issue();
    const first = await exchangeAuthorizationCode({
      code,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      codeVerifier: VERIFIER,
      redirectUri: "https://example.com/callback",
    });

    expect(first.refreshToken).toBeTruthy();

    const refreshed = await refreshAccessToken({
      refreshToken: first.refreshToken,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
    });

    expect(refreshed.accessToken).not.toBe(first.accessToken);
    expect(refreshed.refreshToken).not.toBe(first.refreshToken);
    expect(await verifyOAuthToken(refreshed.accessToken)).not.toBeNull();

    // The rotated token cannot be replayed.
    await expect(
      refreshAccessToken({
        refreshToken: first.refreshToken,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
      }),
    ).rejects.toThrow(/already used/i);
  });

  it("refuses a refresh token from a different client", async () => {
    const { client, code } = await issue();
    const first = await exchangeAuthorizationCode({
      code,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      codeVerifier: VERIFIER,
      redirectUri: "https://example.com/callback",
    });

    const other = await registerOAuthClient({ redirectUris: ["https://other.example/cb"] });

    await expect(
      refreshAccessToken({
        refreshToken: first.refreshToken,
        clientId: other.clientId,
      }),
    ).rejects.toThrow(/different client/i);
  });
});