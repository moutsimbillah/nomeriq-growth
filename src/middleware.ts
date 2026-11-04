import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  isPagePath,
  isPublicPath,
  needsApiAuth,
} from "@/lib/auth/route-policy";
import { loginRedirectUrl } from "@/lib/app-url";

/**
 * Coarse authentication gate.
 *
 * This middleware only checks that *some* credential is present; it never
 * validates one. Each route still verifies the session or the API key itself,
 * and this gate does not replace that check. Its only job is to stop obviously
 * anonymous traffic early and to send browser page requests to the login page.
 */

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

function hasSessionCookie(request: NextRequest): boolean {
  return Boolean(request.cookies.get(SESSION_COOKIE)?.value);
}

function hasCredential(request: NextRequest): boolean {
  if (hasSessionCookie(request)) return true;
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return true;
  return Boolean(request.headers.get("x-api-key"));
}

/**
 * Where the app reaches itself for the two rewrites below.
 *
 * A rewrite target built from `request.url` is wrong behind a TLS proxy: Next sees the
 * forwarded proto (https) but its own loopback address, so it tries to speak TLS to a
 * plaintext port and the request dies with EPROTO / "wrong version number". The upstream is
 * always plain HTTP on the app's own port, so say so explicitly.
 */
const INTERNAL_ORIGIN = `http://127.0.0.1:${process.env.PORT ?? "3100"}`;

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // OAuth discovery documents live at the bare .well-known paths that connector clients
  // probe; they are served by route handlers under /api/oauth/wellknown.
  if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
    return NextResponse.rewrite(new URL("/api/oauth/wellknown/protected-resource", INTERNAL_ORIGIN));
  }
  if (pathname.startsWith("/.well-known/oauth-authorization-server")) {
    return NextResponse.rewrite(new URL("/api/oauth/wellknown/authorization-server", INTERNAL_ORIGIN));
  }

  // Never intercept static assets.
  if (pathname.includes(".")) return NextResponse.next();

  // Public paths pass through untouched.
  if (isPublicPath(pathname)) return NextResponse.next();

  if (needsApiAuth(pathname)) {
    if (hasCredential(request)) return NextResponse.next();
    return NextResponse.json(
      { ok: false, error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  }

  if (isPagePath(pathname) && !hasSessionCookie(request)) {
    // Built from APP_URL, never from request.url: behind the TLS proxy the request origin is
    // the loopback address, which would send the browser to http://localhost:3100.
    return NextResponse.redirect(loginRedirectUrl(`${pathname}${search}`, request));
  }

  return NextResponse.next();
}
