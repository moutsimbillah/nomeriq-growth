import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import {
  disableEmailAccount,
  updateEmailAccount,
} from "@/lib/email/accounts";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  name: z.string().optional(),
  emailAddress: z.string().optional(),
  fromName: z.string().optional(),
  replyTo: z.string().optional().nullable(),
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpSecure: z.boolean().optional(),
  imapHost: z.string().optional(),
  imapPort: z.number().int().min(1).max(65535).optional(),
  imapSecure: z.boolean().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  dailySendLimit: z.number().int().min(1).max(500).optional(),
  minIntervalSeconds: z.number().int().min(5).max(3600).optional(),
  isDefault: z.boolean().optional(),
  /** The profile's own sign-off, or "" to fall back to the workspace signature. */
  signature: z.string().max(2000).optional(),
  /** When this profile's warm-up began, or null for no ramp at all. */
  warmupStartedAt: z.string().datetime().nullable().optional(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const { id } = await context.params;
    const input = updateSchema.parse(await readJson(request));
    const update = { ...input };
    if (!update.password) delete update.password;
    return NextResponse.json({
      ok: true,
      data: await updateEmailAccount(id, update),
    });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const { id } = await context.params;
    await disableEmailAccount(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
