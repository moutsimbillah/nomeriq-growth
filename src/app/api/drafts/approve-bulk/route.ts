import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { approveDrafts } from "@/lib/services/drafts";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Approve selected / Approve all shown. Approval only — nothing is sent from here. */
const schema = z.object({
  draftIds: z.array(z.string().uuid()).min(1).max(100),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const input = schema.parse(await readJson(request));
    const result = await approveDrafts(input.draftIds, user.id);
    return NextResponse.json({ ok: true, data: { ...result, sent: 0 } });
  } catch (error) {
    return fail(error);
  }
}
