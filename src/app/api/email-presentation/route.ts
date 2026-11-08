import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiUser } from "@/lib/auth/session";
import { fail } from "@/lib/api";
import { getEmailPresentation } from "@/lib/services/email-presentation";
import { getConversation } from "@/lib/services/conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const uuid = z.string().uuid();

/** Authenticated read only: no generation, delivery, settings changes or unsubscribe-token writes. */
export async function GET(request: Request) {
  try {
    await requireApiUser();
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId");
    let prospectId: string;
    if (conversationId) {
      uuid.parse(conversationId);
      const conversation = await getConversation(conversationId);
      if (!conversation) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
      prospectId = conversation.prospect.id;
    } else {
      prospectId = uuid.parse(url.searchParams.get("prospectId"));
    }
    return NextResponse.json({ ok: true, data: await getEmailPresentation({ prospectId, conversationId }) }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) { return fail(error); }
}
