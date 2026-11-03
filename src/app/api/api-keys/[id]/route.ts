import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { revokeApiKey } from "@/lib/agent/apiKeys";
import { fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const { id } = await context.params;
    await revokeApiKey(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
