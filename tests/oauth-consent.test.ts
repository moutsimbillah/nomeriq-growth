import crypto from "node:crypto";
import fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ user: null as { id: string; email: string; name: string; role: "founder" } | null }));
vi.mock("@/lib/auth/session", async (original) => ({
  ...(await original<typeof import("@/lib/auth/session")>()),
  getSessionUser: async () => session.user,
}));

import { GET, POST } from "@/app/api/oauth/authorize/route";
import { DEFAULT_SCOPES } from "@/lib/agent/scopes";
import { hashPassword } from "@/lib/auth/password";
import { closeDb, getDb } from "@/lib/db/client";
import { exchangeAuthorizationCode, registerOAuthClient, verifyOAuthToken } from "@/lib/oauth/server";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

const ORIGIN = "http://localhost:3100";
const CALLBACK = "https://example.invalid/callback";
const user = { id: crypto.randomUUID(), email: "consent@example.invalid", name: "Consent", role: "founder" as const };
const state = { clientId: "" };
const verifier = crypto.randomUUID() + crypto.randomUUID();
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

beforeAll(async () => {
  const db = await getDb();
  await ensureWorkspaceDefaults();
  await db.query(`INSERT INTO users (id, email, normalized_email, name, password_hash, role)
    VALUES ($1, $2, $2, $3, $4, 'founder')`, [user.id, user.email, user.name, hashPassword(crypto.randomUUID())]);
  session.user = user;
  const client = await registerOAuthClient({ clientName: "Email connector", redirectUris: [CALLBACK] });
  state.clientId = client.clientId;
});

afterEach(() => {
  session.user = user;
  vi.restoreAllMocks();
});

afterAll(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM oauth_tokens WHERE client_id = $1`, [state.clientId]);
  await db.query(`DELETE FROM oauth_refresh_tokens WHERE client_id = $1`, [state.clientId]);
  await db.query(`DELETE FROM oauth_codes WHERE client_id = $1`, [state.clientId]);
  await db.query(`DELETE FROM oauth_clients WHERE client_id = $1`, [state.clientId]);
  await db.query(`DELETE FROM users WHERE id = $1`, [user.id]);
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir?.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

function authorizationUrl(scope?: string) {
  const query = new URLSearchParams({
    response_type: "code", client_id: state.clientId, redirect_uri: CALLBACK,
    state: "state&callback=preserved", code_challenge: challenge, code_challenge_method: "S256",
  });
  if (scope !== undefined) query.set("scope", scope);
  return `${ORIGIN}/api/oauth/authorize?${query}`;
}

async function consent(scope?: string) {
  const response = await GET(new Request(authorizationUrl(scope)));
  expect(response.status).toBe(200);
  const html = await response.text();
  const form = new URLSearchParams();
  const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    form.set(match[1], decode(match[2]));
  }
  form.set("decision", "approve");
  return { html, form };
}

function submit(form: URLSearchParams, origin: string | null = ORIGIN) {
  return POST(new Request(`${ORIGIN}/api/oauth/authorize`, {
    method: "POST", body: form, headers: origin ? { origin } : {},
  }));
}

async function grant(form: URLSearchParams) {
  const response = await submit(form);
  expect(response.status).toBe(303);
  const target = new URL(response.headers.get("location")!);
  expect(target.origin + target.pathname).toBe(CALLBACK);
  expect(target.searchParams.get("state")).toBe("state&callback=preserved");
  expect(target.searchParams.get("iss")).toBe(ORIGIN);
  const code = target.searchParams.get("code")!;
  const token = await exchangeAuthorizationCode({ code, clientId: state.clientId, codeVerifier: verifier, redirectUri: CALLBACK });
  return (await verifyOAuthToken(token.accessToken))!.scopes;
}

describe("OAuth email consent", () => {
  it("login preserves the full request and grants no permissions", async () => {
    session.user = null;
    const response = await GET(new Request(authorizationUrl("conversations:read followups:write")));
    expect(response.status).toBe(307);
    const target = new URL(response.headers.get("location")!);
    expect(target.origin).toBe(ORIGIN);
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("next")).toBe(new URL(authorizationUrl("conversations:read followups:write")).pathname + new URL(authorizationUrl("conversations:read followups:write")).search);
    expect(target.searchParams.has("code")).toBe(false);
  });

  it("absent scope shows only the unchanged research defaults and approves only those", async () => {
    const { html, form } = await consent();
    expect(html).not.toContain('name="approved_scope"');
    expect(form.get("scope")).toBe(DEFAULT_SCOPES.join(" "));
    expect(await grant(form)).toEqual([...DEFAULT_SCOPES]);
  });

  it("GET displays requested email powers accurately and unchecked, without issuing a code", async () => {
    const db = await getDb();
    const count = () => db.query<{ n: number }>(`SELECT count(*)::int AS n FROM oauth_codes WHERE client_id = $1`, [state.clientId]);
    const before = (await count()).rows[0].n;
    const { html } = await consent("folders:read conversations:read followups:read followups:write");
    expect((await count()).rows[0].n).toBe(before);
    expect(html.match(/type="checkbox"/g)).toHaveLength(4);
    expect(html).not.toMatch(/<input[^>]*checked/);
    expect(html).toContain("folder names and counts only (not message content)");
    expect(html).toContain("including message content");
    expect(html).toContain("never approve, queue or send");
    expect(html).not.toContain("Read research, leads");
  });

  it("grants only selected requested email scopes plus requested research scopes", async () => {
    const { form } = await consent("research:read folders:read conversations:read followups:read followups:write");
    form.append("approved_scope", "folders:read");
    form.append("approved_scope", "conversations:read");
    expect(await grant(form)).toEqual(["research:read", "folders:read", "conversations:read"]);
  });

  it("grants all explicitly checked requested email permissions without adding research defaults", async () => {
    const scopes = ["folders:read", "conversations:read", "followups:read", "followups:write"];
    const { form } = await consent(scopes.join(" "));
    for (const scope of scopes) form.append("approved_scope", scope);
    expect(await grant(form)).toEqual(scopes);
  });

  it("rejects unsupported/wildcard authorization requests instead of defaulting them", async () => {
    for (const scope of ["*", "send:write", "research:read settings:write"]) {
      const response = await GET(new Request(authorizationUrl(scope)));
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain('name="consent_ticket"');
    }
  });

  it("does not grant requested email permissions merely because Approve was pressed", async () => {
    const { form } = await consent("conversations:read followups:write");
    expect(await grant(form)).toEqual([]);
  });

  it.each(["research:read", "research:read followups:write", null])("rejects changed/omitted displayed scope: %s", async (scope) => {
    const { form } = await consent("research:read conversations:read");
    if (scope === null) form.delete("scope"); else form.set("scope", scope);
    expect((await submit(form)).status).toBe(403);
  });

  it("rejects an unrequested email checkbox or wildcard", async () => {
    for (const scope of ["followups:write", "*"]) {
      const { form } = await consent("research:read");
      form.append("approved_scope", scope);
      expect((await submit(form)).status).toBe(403);
    }
  });

  it.each(["state", "code_challenge", "code_challenge_method"])("rejects changed authorization binding: %s", async (field) => {
    const { form } = await consent("research:read");
    form.set(field, crypto.randomUUID());
    expect((await submit(form)).status).toBe(403);
  });

  it.each([null, "https://evil.example"])("rejects missing or cross-site origin: %s", async (origin) => {
    const { form } = await consent("research:read");
    expect((await submit(form, origin)).status).toBe(403);
  });

  it("rejects a forged ticket, another user, expiration and consent replay", async () => {
    const forged = await consent("research:read");
    forged.form.set("consent_ticket", crypto.randomUUID());
    expect((await submit(forged.form)).status).toBe(403);
    const changedUser = await consent("research:read");
    session.user = { ...user, id: crypto.randomUUID() };
    expect((await submit(changedUser.form)).status).toBe(403);
    session.user = user;
    const expired = await consent("research:read");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 600_001);
    expect((await submit(expired.form)).status).toBe(403);
    vi.restoreAllMocks();
    const replay = await consent("research:read");
    await grant(replay.form);
    expect((await submit(replay.form)).status).toBe(403);
  });

  it("Deny preserves the 303 GET callback and state, with no code", async () => {
    const { form } = await consent("conversations:read");
    form.set("decision", "deny");
    const response = await submit(form);
    expect(response.status).toBe(303);
    const target = new URL(response.headers.get("location")!);
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("state")).toBe("state&callback=preserved");
    expect(target.searchParams.has("code")).toBe(false);
  });
});
