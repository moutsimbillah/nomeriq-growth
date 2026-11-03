import { AppError } from "@/lib/utils";

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) {
    throw new AppError(
      "This request is missing an Origin header and was blocked.",
      403,
      "origin_required",
    );
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new AppError("Invalid request origin.", 403, "invalid_origin");
  }

  const allowed = new Set<string>();
  try {
    allowed.add(new URL(request.url).host);
  } catch {
    // Ignore invalid request URL; the configured APP_URL is still checked.
  }
  if (process.env.APP_URL) {
    try {
      allowed.add(new URL(process.env.APP_URL).host);
    } catch {
      // Configuration error is surfaced elsewhere.
    }
  }
  const host = request.headers.get("host");
  if (host) allowed.add(host);

  if (!allowed.has(originUrl.host)) {
    throw new AppError("Cross-origin request blocked.", 403, "invalid_origin");
  }
}

const attempts = new Map<string, { count: number; resetAt: number }>();

export function checkLoginRateLimit(key: string): void {
  const now = Date.now();
  const record = attempts.get(key);
  if (!record || record.resetAt < now) {
    attempts.set(key, { count: 0, resetAt: now + 15 * 60_000 });
    return;
  }
  if (record.count >= 8) {
    throw new AppError(
      "Too many sign-in attempts. Try again in 15 minutes.",
      429,
      "rate_limited",
    );
  }
}

export function recordLoginFailure(key: string): void {
  const now = Date.now();
  const record = attempts.get(key);
  if (!record || record.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
  } else {
    record.count += 1;
  }
}

export function clearLoginFailures(key: string): void {
  attempts.delete(key);
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}
