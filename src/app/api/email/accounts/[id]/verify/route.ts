import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { verifyEmailAccountConnection } from "@/lib/email/accounts";
import { fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const { id } = await context.params;
    const result = await verifyEmailAccountConnection(id);
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return fail(error);
  }
}
