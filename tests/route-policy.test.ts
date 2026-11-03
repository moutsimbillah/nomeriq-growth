import { describe, it, expect } from "vitest";

import {
  SESSION_COOKIE,
  PUBLIC_PATHS,
  PUBLIC_PREFIXES,
  isPublicPath,
  needsApiAuth,
  isPagePath,
} from "@/lib/auth/route-policy";

describe("route policy — public paths", () => {
  it("treats the exact public paths as public", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/setup")).toBe(true);
  });

  it("treats prefixed public routes as public", () => {
    expect(isPublicPath("/unsubscribe/abc")).toBe(true);
    expect(isPublicPath("/api/auth/login")).toBe(true);
    expect(isPublicPath("/api/health")).toBe(true);
    expect(isPublicPath("/api/health/deep")).toBe(true);
    expect(isPublicPath("/api/unsubscribe/token")).toBe(true);
    expect(isPublicPath("/api/mcp")).toBe(true);
    expect(isPublicPath("/api/agent/v1/search_prospects")).toBe(true);
    expect(isPublicPath("/api/cron/research")).toBe(true);
  });

  it("does not treat /api/healthz as public: prefix matching respects path boundaries", () => {
    expect(isPublicPath("/api/healthz")).toBe(false);
  });

  it("does not treat /api/mcpx as public: prefix matching respects path boundaries", () => {
    expect(isPublicPath("/api/mcpx")).toBe(false);
  });

  it("treats protected pages and API routes as not public", () => {
    expect(isPublicPath("/dashboard")).toBe(false);
    expect(isPublicPath("/api/leads")).toBe(false);
    expect(isPublicPath("/settings")).toBe(false);
  });
});

describe("route policy — API auth", () => {
  it("requires auth for non-public API routes", () => {
    expect(needsApiAuth("/api/leads")).toBe(true);
    expect(needsApiAuth("/api/research/status")).toBe(true);
  });

  it("does not require auth for public API routes", () => {
    expect(needsApiAuth("/api/cron/research")).toBe(false);
  });

  it("does not require API auth for page routes", () => {
    expect(needsApiAuth("/dashboard")).toBe(false);
  });
});

describe("route policy — page paths", () => {
  it("treats non-API routes as page paths", () => {
    expect(isPagePath("/dashboard")).toBe(true);
  });

  it("does not treat API routes as page paths", () => {
    expect(isPagePath("/api/leads")).toBe(false);
  });
});

describe("route policy — constants", () => {
  it("exports the session cookie name and public route lists", () => {
    expect(SESSION_COOKIE).toBe("nomeriq_growth_session");
    expect(PUBLIC_PATHS).toEqual(["/login", "/setup"]);
    expect(PUBLIC_PREFIXES).toContain("/api/health");
  });
});
