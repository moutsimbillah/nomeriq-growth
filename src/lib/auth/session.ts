import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/lib/db/client";
import { AppError, iso } from "@/lib/utils";
import type { Role, SessionUser } from "@/lib/types";
import { createSessionToken, hashToken } from "./password";

export const SESSION_COOKIE = "nomeriq_growth_session";
const SESSION_DAYS = 30;

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export async function createSession(
  userId: string,
  userAgent?: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const db = await getDb();
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      crypto.randomUUID(),
      userId,
      hashToken(token),
      expiresAt.toISOString(),
      userAgent?.slice(0, 500) ?? null,
    ],
  );
  await db.query(
    `UPDATE users SET last_login_at = now() WHERE id = $1`,
    [userId],
  );
  return { token, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const db = await getDb();
    await db.query("DELETE FROM sessions WHERE token_hash = $1", [
      hashToken(token),
    ]);
  }
  jar.delete(SESSION_COOKIE);
}

export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = await getDb();
  const result = await db.query<UserRow & { expires_at: string }>(
    `SELECT u.id, u.email, u.name, u.role, s.expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active = true
     LIMIT 1`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role };
});

export async function requirePageUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireApiUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    throw new AppError("Sign in to continue.", 401, "unauthorized");
  }
  return user;
}

export async function requireEditor(): Promise<SessionUser> {
  const user = await requireApiUser();
  if (user.role !== "founder" && user.role !== "admin") {
    throw new AppError(
      "This action requires a founder or admin account.",
      403,
      "forbidden",
    );
  }
  return user;
}

export function isEditor(user: SessionUser): boolean {
  return user.role === "founder" || user.role === "admin";
}

export async function userCount(): Promise<number> {
  const db = await getDb();
  const result = await db.query<{ count: string | number }>(
    "SELECT count(*) AS count FROM users",
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function findUserByEmail(email: string) {
  const db = await getDb();
  const result = await db.query<{
    id: string;
    email: string;
    normalized_email: string;
    name: string;
    role: Role;
    password_hash: string;
    is_active: boolean;
    created_at: string;
    last_login_at: string | null;
  }>(`SELECT * FROM users WHERE normalized_email = $1 LIMIT 1`, [
    email.trim().toLowerCase(),
  ]);
  return result.rows[0] ?? null;
}

export async function ensureBootstrapUser(input: {
  email: string;
  password: string;
  name: string;
  role?: Role;
}): Promise<{ created: boolean; id: string }> {
  const { hashPassword } = await import("./password");
  const db = await getDb();
  const existing = await findUserByEmail(input.email);
  if (existing) return { created: false, id: existing.id };
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      input.email.trim(),
      input.email.trim().toLowerCase(),
      input.name.trim(),
      hashPassword(input.password),
      input.role ?? "founder",
    ],
  );
  return { created: true, id };
}

export function sessionExpiryFromRow(value: unknown): Date | null {
  const valueIso = iso(value);
  return valueIso ? new Date(valueIso) : null;
}
