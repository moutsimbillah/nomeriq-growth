import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { getConversationForProspect } from "@/lib/services/conversations";
import { fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireEditor();
    const { id } = await context.params;
    const conversation = await getConversationForProspect(id);
    return NextResponse.json({
      ok: true,
      data: conversation
        ? { id: conversation.id, messages: conversation.messages.length }
        : null,
    });
  } catch (error) {
    return fail(error);
  }
}
