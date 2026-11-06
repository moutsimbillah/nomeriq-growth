import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { draftSimulatedReply } from "@/lib/ai/simulate";
import { fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Drafts the text of a sandbox test reply, written as the prospect. Nothing is stored: the founder
 * reviews it in the simulation box and inserts it with the existing sandbox-only route.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const { id } = await context.params;
    return NextResponse.json({ ok: true, data: await draftSimulatedReply(id) });
  } catch (error) {
    return fail(error);
  }
}
