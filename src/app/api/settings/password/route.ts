import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { fail, readJson } from "@/lib/api";
import { hashToken } from "@/lib/auth/password";
import { assertSameOrigin } from "@/lib/auth/request";
import { SESSION_COOKIE, requireApiUser } from "@/lib/auth/session";
import { changePassword } from "@/lib/services/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(8, "Use at least 8 characters.")
    .max(16, "Use at most 16 characters."),
  confirmPassword: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireApiUser();
    const body = changePasswordSchema.parse(await readJson(request));

    const token = (await cookies()).get(SESSION_COOKIE)?.value ?? "";

    const { sessionsRevoked } = await changePassword({
      userId: user.id,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      confirmPassword: body.confirmPassword,
      currentTokenHash: token ? hashToken(token) : "",
    });

    return NextResponse.json({ ok: true, data: { sessionsRevoked } });
  } catch (error) {
    return fail(error);
  }
}
