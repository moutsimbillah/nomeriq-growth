/**
 * Route policy for the edge middleware.
 *
 * This module is deliberately pure and framework-free: no Next imports, no
 * database, no Node built-ins. The middleware runs on the Edge runtime, so
 * anything imported there must be Edge-safe, and keeping the rules here makes
 * them unit-testable without a request or a server.
 */

export const SESSION_COOKIE = "nomeriq_growth_session";

export const PUBLIC_PATHS = ["/login", "/setup"];

export const PUBLIC_PREFIXES = [
  "/unsubscribe/",
  "/api/auth/",
  "/api/health",
  "/api/unsubscribe/",
  "/api/mcp",
  "/api/agent/",
  "/api/cron/",
];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  return PUBLIC_PREFIXES.some(
    (prefix) =>
      pathname === prefix ||
      (pathname.startsWith(prefix) &&
        (prefix.endsWith("/") || pathname[prefix.length] === "/")),
  );
}

export function needsApiAuth(pathname: string): boolean {
  return pathname.startsWith("/api/") && !isPublicPath(pathname);
}

export function isPagePath(pathname: string): boolean {
  return !pathname.startsWith("/api/");
}
