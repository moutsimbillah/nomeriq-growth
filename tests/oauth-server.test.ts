import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";

import { hashPassword } from "@/lib/auth/password";
import { closeDb, getDb } from "@/lib/db/client";
import {
  clientAllowsRedirect,
  createAuthorizationCode,
  exchangeAuthorizationCode,
  registerOAuthClient,
  scopesFromRequest,
  verifyOAuthToken,
} from "@/lib/oauth/server";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

const state = { userId: "" };
const VERIFIER = "a-very-long-pkce-code-verifier-for-tests-0123456789";

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
      hashPassword("OAuthTestPassw0rd"),
    ],
  );
});

afterAll(async () => {
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

  it("never grants more than the default scopes", () => {
    const scopes = scopesFromRequest("research:read conversations:read send:everything");
    expect(scopes).toContain("research:read");
    expect(scopes).not.toContain("conversations:read");
    expect(scopes.some((scope) => /send|delete/i.test(scope))).toBe(false);
  });
});

describe("authorization code exchange", () => {
  async function issue() {
    const client = await registerOAuthClient({
      redirectUris: ["https://example.com/callback"],
    });
    const code = await createAuthorizationCode({
      clientId: client.clientId,
      redirectUri: "https://example.com/callback",
      scope: "research:read research:write",
      userId: state.userId,
      codeChallenge: challengeFor(VERIFIER),
      codeChallengeMethod: "S256",
    });
    return { client, code };
  }

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

  it("refuses a wrong PKCE verifier", async () => {
    const { client, code } = await issue();

    await expect(
      exchangeAuthorizationCode({
        code,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        codeVerifier: "the-wrong-verifier-0123456789-0123456789",
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
        clientSecret: "not-the-secret",
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
    expect(await verifyOAuthToken("definitely-not-a-token")).toBeNull();
  });
});