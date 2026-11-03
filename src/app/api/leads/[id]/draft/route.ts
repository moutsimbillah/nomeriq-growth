import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { generateDraftForProspect, getFirstContactDraft } from "@/lib/services/drafts";
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
    const body = await readJson<{ force?: boolean }>(request).catch(
      () => ({}) as { force?: boolean },
    );
    const draft = await generateDraftForProspect({
      prospectId: id,
      actorType: "founder",
      actorUserId: user.id,
      force: Boolean(body?.force),
    });
    return NextResponse.json({ ok: true, data: draft });
  } catch (error) {
    return fail(error);
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireEditor();
    const { id } = await context.params;
    return NextResponse.json({
      ok: true,
      data: await getFirstContactDraft(id),
    });
  } catch (error) {
    return fail(error);
  }
}
