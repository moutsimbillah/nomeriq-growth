import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { hashPassword } from "@/lib/auth/password";
import { findUserByEmail } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppError, isEmail } from "@/lib/utils";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().min(3),
  password: z.string().min(10).max(200),
  role: z.enum(["admin", "member"]),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const input = schema.parse(await readJson(request));
    if (!isEmail(input.email)) throw new AppError("Enter a valid email address.");
    if (await findUserByEmail(input.email)) {
      throw new AppError("A user with that email already exists.", 409);
    }
    const db = await getDb();
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO users
        (id, email, normalized_email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        input.email.trim(),
        input.email.trim().toLowerCase(),
        input.name.trim(),
        hashPassword(input.password),
        input.role,
      ],
    );
    return NextResponse.json({
      ok: true,
      data: { id, name: input.name, email: input.email, role: input.role },
    });
  } catch (error) {
    return fail(error);
  }
}
