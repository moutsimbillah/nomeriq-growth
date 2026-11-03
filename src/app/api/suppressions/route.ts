import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { addSuppression, listSuppressions } from "@/lib/services/suppressions";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().min(3),
  reason: z.enum(["unsubscribe", "opt_out", "bounce", "complaint", "manual"]),
  note: z.string().optional(),
});

export async function GET() {
  try {
    await requireEditor();
    return NextResponse.json({ ok: true, data: await listSuppressions() });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const input = schema.parse(await readJson(request));
    await addSuppression({ ...input, userId: user.id });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
