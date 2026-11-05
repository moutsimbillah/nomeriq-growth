import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { fail } from "@/lib/api";
import { translateMessage } from "@/lib/services/message-translations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const id = z.string().uuid().parse((await params).id);
    const outcome = await translateMessage(id);
    return NextResponse.json({ ok: true, data: outcome });
  } catch (error) {
    return fail(error);
  }
}
