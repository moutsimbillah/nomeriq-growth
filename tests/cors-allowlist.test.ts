import { describe, it, expect, beforeAll, afterAll } from "vitest";

import {
  allowedOrigins,
  corsHeaders,
  isOriginAllowed,
  preflight,
} from "@/lib/api/cors";

const APP_URL = "https://growth.nomeriq.info";
const MCP_ORIGIN = "https://claude.example";
const UNKNOWN_ORIGIN = "https://evil.example";

let priorAppUrl: string | undefined;
let priorAllowedOrigins: string | undefined;

beforeAll(() => {
  priorAppUrl = process.env.APP_URL;
  priorAllowedOrigins = process.env.MCP_ALLOWED_ORIGINS;
  process.env.APP_URL = APP_URL;
  process.env.MCP_ALLOWED_ORIGINS = MCP_ORIGIN;
});

afterAll(() => {
  if (priorAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = priorAppUrl;

  if (priorAllowedOrigins === undefined) delete process.env.MCP_ALLOWED_ORIGINS;
  else process.env.MCP_ALLOWED_ORIGINS = priorAllowedOrigins;
});

function request(origin?: string): Request {
  return new Request(`${APP_URL}/api/mcp`, {
    method: "OPTIONS",
    headers: origin === undefined ? {} : { origin },
  });
}

describe("CORS allowlist — missing Origin", () => {
  it("allows a request without an Origin header and returns no CORS headers", () => {
    const req = request();
    expect(corsHeaders(req)).toEqual({});
    expect(isOriginAllowed(req)).toBe(true);
  });

  it("answers a preflight without an Origin header with 204 and no allow-origin", () => {
    const res = preflight(request());
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("CORS allowlist — allowlisted origins", () => {
  it.each([APP_URL, MCP_ORIGIN])(
    "echoes the allowlisted origin %s exactly and sets Vary: Origin",
    (origin) => {
      const headers = corsHeaders(request(origin));
      expect(headers["Access-Control-Allow-Origin"]).toBe(origin);
      expect(headers["Vary"]).toBe("Origin");
      expect(headers["Access-Control-Allow-Headers"]).toBeTruthy();
      expect(headers["Access-Control-Allow-Methods"]).toBeTruthy();
      expect(isOriginAllowed(request(origin))).toBe(true);
      expect(preflight(request(origin)).status).toBe(204);
    },
  );
});

describe("CORS allowlist — unknown origin", () => {
  it("returns no CORS headers and rejects the unknown origin", () => {
    const req = request(UNKNOWN_ORIGIN);
    expect(corsHeaders(req)).toEqual({});
    expect(isOriginAllowed(req)).toBe(false);
  });

  it("answers a preflight from an unknown origin with 403", () => {
    const res = preflight(request(UNKNOWN_ORIGIN));
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("CORS allowlist — configuration", () => {
  it("includes both configured origins", () => {
    const origins = allowedOrigins();
    expect(origins).toContain(APP_URL);
    expect(origins).toContain(MCP_ORIGIN);
  });

  it("never includes a wildcard origin", () => {
    expect(allowedOrigins()).not.toContain("*");
  });

  it("never returns a wildcard header value", () => {
    for (const req of [request(APP_URL), request(MCP_ORIGIN), request(UNKNOWN_ORIGIN)]) {
      for (const value of Object.values(corsHeaders(req))) {
        expect(value).not.toBe("*");
      }
    }
  });
});
