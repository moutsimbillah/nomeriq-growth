/**
 * Where every absolute URL the app hands out comes from.
 *
 * Behind the TLS reverse proxy the request origin is the loopback address — the proxy
 * terminates TLS and forwards plain HTTP to 127.0.0.1:3100 — so anything built from
 * `request.url` is wrong: a redirect lands the browser on http://localhost:3100, and a
 * discovery document advertises localhost as the issuer. The configured `APP_URL` is the
 * public origin, so it is the source of truth here. Forwarded headers are only a fallback
 * for a deployment that has not set it.
 */

/** APP_URL as an origin, without a trailing slash. Undefined when it is not configured. */
export function appOrigin(): string | undefined {
  const configured = process.env.APP_URL?.trim();
  if (!configured) return undefined;
  return configured.replace(/\/+$/, "");
}

/** The origin a browser or connector sees. */
export function publicOrigin(request: Request): string {
  const configured = appOrigin();
  if (configured) return configured;

  const host = request.headers.get("x-forwarded-host");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  if (host) return `${proto}://${host}`;

  return new URL(request.url).origin;
}

/** An absolute URL on the public origin. Falls back to the request's own origin in dev. */
export function absoluteUrl(path: string, request?: Request): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const origin = appOrigin() ?? (request ? new URL(request.url).origin : undefined);
  return origin ? `${origin}${suffix}` : suffix;
}

/**
 * Only ever a path on this site. Anything that could leave it — a protocol-relative
 * `//evil.com`, an absolute `https://evil.com`, a backslash `/\evil.com`, a control
 * character — is refused, so an attacker-influenced `next` cannot bounce a freshly
 * signed-in founder to another host.
 */
export function isSafeNextPath(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const value = raw.trim();
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//") || value.startsWith("/\\")) return false;
  if (value.includes("\\")) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return true;
}

/** The sanitized path, or `fallback` when the value is not a safe in-site path. */
export function safeNextPath(raw: unknown, fallback = "/"): string {
  return isSafeNextPath(raw) ? String(raw).trim() : fallback;
}

/** Where to land after signing in. */
export function loginTarget(raw: unknown): string {
  return safeNextPath(raw, "/dashboard");
}

/** The sign-in URL, with a sanitized `next`, on the public origin. */
export function loginRedirectUrl(next: unknown, request?: Request): string {
  const target = absoluteUrl("/login", request);
  return `${target}?next=${encodeURIComponent(safeNextPath(next))}`;
}
