import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { getDraft, saveDraft } from "@/lib/services/drafts";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  subject: z.string().min(2).max(300),
  body: z.string().min(10).max(20000),
  recipientEmail: z.string().min(3),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireEditor();
    const { id } = await context.params;
    const draft = await getDraft(id);
    if (!draft) {
      return NextResponse.json(
        { ok: false, error: "Draft not found." },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, data: draft });
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const { id } = await context.params;
    const input = schema.parse(await readJson(request));
    const draft = await saveDraft({
      id,
      ...input,
      actorType: "founder",
      actorUserId: user.id,
    });
    return NextResponse.json({ ok: true, data: draft });
  } catch (error) {
    return fail(error);
  }
}
