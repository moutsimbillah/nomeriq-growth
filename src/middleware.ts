import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  isPagePath,
  isPublicPath,
  needsApiAuth,
} from "@/lib/auth/route-policy";

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

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

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
    const login = new URL("/login", request.url);
    login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}
