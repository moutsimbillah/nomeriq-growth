import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { NextRequest } from "next/server";

// The authorize route reads the session through Next's request scope, which does not exist in a
// plain unit test. Partial mock: everything else in that module stays real.
vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getSessionUser: async () => null,
}));

import {
  absoluteUrl,
  appOrigin,
  isSafeNextPath,
  loginRedirectUrl,
  loginTarget,
  publicOrigin,
  safeNextPath,
} from "@/lib/app-url";
import { middleware } from "@/middleware";
import { GET as authorizeGet } from "@/app/api/oauth/authorize/route";
import { GET as protectedResource } from "@/app/api/oauth/wellknown/protected-resource/route";
import { GET as authorizationServer } from "@/app/api/oauth/wellknown/authorization-server/route";
import { registerOAuthClient } from "@/lib/oauth/server";
import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * The public origin is deliberately different from any request origin in these tests, so a
 * redirect built from the request cannot pass by accident. This is the check that was
 * missing: status codes alone let a redirect to http://localhost:3100 look healthy.
 */
const PUBLIC_ORIGIN = "https://growth.nomeriq.info";
const LOOPBACK = "http://127.0.0.1:3100";
let originalAppUrl: string | undefined;
const state = { clientId: "", redirectUri: "https://example.invalid/cb" };

beforeAll(async () => {
  originalAppUrl = process.env.APP_URL;
  process.env.APP_URL = PUBLIC_ORIGIN;
  await ensureWorkspaceDefaults();
  const client = await registerOAuthClient({
    clientName: "redirect-origin test",
    redirectUris: [state.redirectUri],
  });
  state.clientId = client.clientId;
});

afterAll(async () => {
  process.env.APP_URL = originalAppUrl;
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("the shared URL helper", () => {
  it("uses APP_URL, not the request, for the public origin", () => {
    const viaLoopback = new Request(`${LOOPBACK}/dashboard`);
    expect(appOrigin()).toBe(PUBLIC_ORIGIN);
    expect(publicOrigin(viaLoopback)).toBe(PUBLIC_ORIGIN);
    expect(absoluteUrl("/login", viaLoopback)).toBe(`${PUBLIC_ORIGIN}/login`);
  });

  it("falls back to forwarded headers, then the request, when APP_URL is unset", () => {
    const previous = process.env.APP_URL;
    process.env.APP_URL = "";
    try {
      const forwarded = new Request(`${LOOPBACK}/x`, {
        headers: { "x-forwarded-host": "growth.example.com", "x-forwarded-proto": "https" },
      });
      expect(publicOrigin(forwarded)).toBe("https://growth.example.com");
      expect(publicOrigin(new Request(`${LOOPBACK}/x`))).toBe(LOOPBACK);
    } finally {
      process.env.APP_URL = previous;
    }
  });
});

describe("the next parameter never leaves this site", () => {
  it("refuses protocol-relative, absolute and backslash forms", () => {
    for (const hostile of [
      "//evil.com",
      "https://evil.com",
      "http://evil.com/path",
      "/\\evil.com",
      "\\\\evil.com",
      "evil.com",
      "",
      " //evil.com",
    ]) {
      expect(isSafeNextPath(hostile)).toBe(false);
      expect(safeNextPath(hostile)).toBe("/");
      expect(loginTarget(hostile)).toBe("/dashboard");
    }
  });

  it("keeps a plain in-site path", () => {
    for (const good of ["/dashboard", "/leads", "/research?job=1", "/settings#users"]) {
      expect(isSafeNextPath(good)).toBe(true);
      expect(safeNextPath(good)).toBe(good);
    }
  });

  it("keeps the login URL on the public origin whatever next is", () => {
    const request = new Request(`${LOOPBACK}/login`);
    for (const hostile of ["//evil.com", "https://evil.com", "/\\evil.com"]) {
      const url = loginRedirectUrl(hostile, request);
      expect(url.startsWith(`${PUBLIC_ORIGIN}/login`)).toBe(true);
      expect(url).not.toContain("evil.com");
    }
  });
});

describe("every redirect we own points at the public origin", () => {
  it("middleware page redirect: 307 and a public Location", () => {
    // Exactly what the app receives behind Caddy: a loopback request URL.
    const response = middleware(new NextRequest(`${LOOPBACK}/dashboard`));
    expect(response.status).toBe(307);

    const location = response.headers.get("location") ?? "";
    expect(location.startsWith(`${PUBLIC_ORIGIN}/login`)).toBe(true);
    expect(location).toContain("next=%2Fdashboard");
    expect(location).not.toContain("127.0.0.1");
    expect(location).not.toContain("localhost");
  });

  it("middleware keeps the query string in next", () => {
    const response = middleware(new NextRequest(`${LOOPBACK}/leads?page=2`));
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith(`${PUBLIC_ORIGIN}/login`)).toBe(true);
    expect(decodeURIComponent(location.split("next=")[1])).toBe("/leads?page=2");
  });

  it("OAuth authorize redirect to sign-in: 307 and a public Location", async () => {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: state.clientId,
      redirect_uri: state.redirectUri,
      state: "xyz",
      code_challenge: "abcdefghijklmnopqrstuvwxyz0123456789abcdefghij",
      code_challenge_method: "S256",
      scope: "research:read",
    });
    const response = await authorizeGet(new Request(`${LOOPBACK}/api/oauth/authorize?${query}`));

    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith(`${PUBLIC_ORIGIN}/login`)).toBe(true);
    expect(location).not.toContain("127.0.0.1");
    expect(location).not.toContain("localhost");
  });
});

describe("the discovery documents advertise the public origin", () => {
  it("protected-resource document", async () => {
    const response = await protectedResource(new Request(`${LOOPBACK}/.well-known/oauth-protected-resource`));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(PUBLIC_ORIGIN);
    expect(body).not.toContain("localhost");
    expect(body).not.toContain("127.0.0.1");

    const document = JSON.parse(body) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
    };
    expect(document.resource).toBe(`${PUBLIC_ORIGIN}/api/mcp`);
    expect(document.authorization_servers).toEqual([PUBLIC_ORIGIN]);
    expect(Array.isArray(document.scopes_supported)).toBe(true);
  });

  it("authorization-server document: issuer and endpoints, never loopback", async () => {
    const response = await authorizationServer(
      new Request(`${LOOPBACK}/.well-known/oauth-authorization-server`),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("localhost");
    expect(body).not.toContain("127.0.0.1");

    const document = JSON.parse(body) as Record<string, unknown>;
    expect(document.issuer).toBe(PUBLIC_ORIGIN);
    expect(document.authorization_endpoint).toBe(`${PUBLIC_ORIGIN}/api/oauth/authorize`);
    expect(document.token_endpoint).toBe(`${PUBLIC_ORIGIN}/api/oauth/token`);
    expect(document.registration_endpoint).toBe(`${PUBLIC_ORIGIN}/api/oauth/register`);
  });
});