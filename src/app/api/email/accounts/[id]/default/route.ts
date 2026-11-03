import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { setDefaultEmailAccount } from "@/lib/email/accounts";
import { fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const { id } = await context.params;
    await setDefaultEmailAccount(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
