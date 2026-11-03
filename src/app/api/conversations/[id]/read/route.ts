import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { markConversationRead } from "@/lib/services/conversations";
import { fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireApiUser();
    const { id } = await context.params;
    await markConversationRead(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
