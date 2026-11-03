import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { approveDraft, getDraft } from "@/lib/services/drafts";
import { sendDraft } from "@/lib/services/email-sending";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const { id } = await context.params;
    const body = await readJson<{ approveFirst?: boolean }>(request).catch(
      () => ({}) as { approveFirst?: boolean },
    );
    let draft = await getDraft(id);
    if (!draft) {
      return NextResponse.json(
        { ok: false, error: "Draft not found." },
        { status: 404 },
      );
    }
    if (draft.status === "draft" && body?.approveFirst) {
      draft = await approveDraft(id, user.id);
    }
    const result = await sendDraft({
      draftId: id,
      actorUserId: user.id,
    });
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return fail(error);
  }
}
