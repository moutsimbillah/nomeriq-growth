import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertSameOrigin,
  checkLoginRateLimit,
  clearLoginFailures,
  clientIp,
  recordLoginFailure,
} from "@/lib/auth/request";
import {
  createSession,
  findUserByEmail,
  setSessionCookie,
} from "@/lib/auth/session";
import { verifyPassword } from "@/lib/auth/password";
import { AppError } from "@/lib/utils";
import { getDb } from "@/lib/db/client";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().min(3),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = schema.parse(await readJson(request));
    const ip = clientIp(request);
    const key = `${ip}:${input.email.toLowerCase()}`;
    checkLoginRateLimit(key);

    const user = await findUserByEmail(input.email);
    if (!user || !user.is_active || !verifyPassword(input.password, user.password_hash)) {
      recordLoginFailure(key);
      throw new AppError("Email or password is incorrect.", 401, "invalid_login");
    }
    clearLoginFailures(key);
    const session = await createSession(user.id, request.headers.get("user-agent"));
    await setSessionCookie(session.token, session.expiresAt);
    const db = await getDb();
    await db.query(
      `INSERT INTO audit_log (id, actor_type, actor_id, action, ip, metadata)
       VALUES ($1, 'founder', $2, 'auth.login', $3, '{}'::jsonb)`,
      [crypto.randomUUID(), user.id, ip],
    );
    return NextResponse.json({
      ok: true,
      data: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (error) {
    return fail(error);
  }
}
