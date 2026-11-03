import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { archiveProspect } from "@/lib/services/prospects";
import { fail } from "@/lib/api";

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
    await archiveProspect(id, user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
