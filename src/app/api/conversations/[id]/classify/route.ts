import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { updateConversationClassification } from "@/lib/services/conversations";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  classification: z.enum([
    "interested",
    "demo",
    "features",
    "pricing",
    "technical",
    "not_interested",
    "unsubscribe",
    "other",
  ]),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const { id } = await context.params;
    const input = schema.parse(await readJson(request));
    await updateConversationClassification(id, input.classification, user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
