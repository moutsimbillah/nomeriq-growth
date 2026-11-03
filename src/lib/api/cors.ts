/**
 * CORS for the MCP and agent REST endpoints.
 *
 * The allowlist is explicit: the origins in `MCP_ALLOWED_ORIGINS` plus the
 * origin of `APP_URL`. A wildcard is never returned. Server-to-server callers
 * (Claude, ChatGPT, cron) send no `Origin` header at all and must keep working,
 * so a missing Origin is always allowed and simply gets no CORS headers.
 */

const ALLOW_HEADERS =
  "Authorization, Content-Type, MCP-Protocol-Version, X-API-Key";
const ALLOW_METHODS = "POST, GET, DELETE, OPTIONS";

function originOf(value: string | undefined | null): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

export function allowedOrigins(): string[] {
  const origins = new Set<string>();
  for (const entry of (process.env.MCP_ALLOWED_ORIGINS ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const origin = originOf(trimmed);
    if (origin) origins.add(origin);
  }
  const appOrigin = originOf(process.env.APP_URL);
  if (appOrigin) origins.add(appOrigin);
  return [...origins];
}

export function isOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return allowedOrigins().includes(origin);
}

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins().includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
    "Access-Control-Allow-Methods": ALLOW_METHODS,
  };
}

export function preflight(request: Request): Response {
  if (!isOriginAllowed(request)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
