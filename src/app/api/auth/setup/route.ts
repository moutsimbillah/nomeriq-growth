import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertSameOrigin,
  clientIp,
  checkLoginRateLimit,
} from "@/lib/auth/request";
import {
  createSession,
  ensureBootstrapUser,
  setSessionCookie,
  userCount,
} from "@/lib/auth/session";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { AppError, isEmail } from "@/lib/utils";
import { getDb } from "@/lib/db/client";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().min(3),
  password: z.string().min(10).max(200),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    checkLoginRateLimit(`setup:${clientIp(request)}`);
    if ((await userCount()) > 0) {
      throw new AppError(
        "Growth has already been initialized. Sign in instead.",
        409,
        "already_initialized",
      );
    }
    const input = schema.parse(await readJson(request));
    if (!isEmail(input.email)) throw new AppError("Enter a valid email address.");
    const user = await ensureBootstrapUser({
      name: input.name,
      email: input.email,
      password: input.password,
      role: "founder",
    });
    await ensureWorkspaceDefaults();
    const session = await createSession(user.id, request.headers.get("user-agent"));
    await setSessionCookie(session.token, session.expiresAt);
    const db = await getDb();
    await db.query(
      `INSERT INTO audit_log (id, actor_type, actor_id, action, ip, metadata)
       VALUES ($1, 'founder', $2, 'auth.setup', $3, '{}'::jsonb)`,
      [crypto.randomUUID(), user.id, clientIp(request)],
    );
    return NextResponse.json({ ok: true, data: { id: user.id } });
  } catch (error) {
    return fail(error);
  }
}
