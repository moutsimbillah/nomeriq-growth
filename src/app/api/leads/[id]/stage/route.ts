import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { FOUNDER_STAGES, setLeadStage } from "@/lib/services/stage";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The founder's stage buttons: Interested, Demo, Proposal, Won, Lost. Audited; sends nothing. */
const schema = z.object({ stage: z.enum(FOUNDER_STAGES) });

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const { id } = await context.params;
    const input = schema.parse(await readJson(request));
    const result = await setLeadStage(id, input.stage, user.id);
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return fail(error);
  }
}
