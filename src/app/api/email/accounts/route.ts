import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiUser, requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import {
  createEmailAccount,
  listEmailAccounts,
} from "@/lib/email/accounts";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const createSchema = z.object({
  name: z.string().optional(),
  provider: z.enum(["ionos", "smtp_imap", "sandbox"]),
  emailAddress: z.string().min(3),
  fromName: z.string().min(1),
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
});

export async function GET() {
  try {
    await requireApiUser();
    return NextResponse.json({ ok: true, data: await listEmailAccounts() });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const input = createSchema.parse(await readJson(request));
    const account = await createEmailAccount(input, user.id);
    return NextResponse.json({ ok: true, data: account });
  } catch (error) {
    return fail(error);
  }
}
