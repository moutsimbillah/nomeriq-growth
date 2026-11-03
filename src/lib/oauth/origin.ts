/**
 * The origin a client sees, not the one Next sees internally.
 *
 * Behind a tunnel or reverse proxy the request URL is http://localhost:3100, so any URL we
 * hand back to a browser or a connector (OAuth metadata, redirects, the WWW-Authenticate
 * pointer) must be built from the forwarded headers instead.
 */
export function publicOrigin(request: Request): string {
  const proto = request.headers.get("x-forwarded-proto");
  const host = request.headers.get("x-forwarded-host");
  if (host) return `${proto ?? "https"}://${host}`;
  return new URL(request.url).origin;
}