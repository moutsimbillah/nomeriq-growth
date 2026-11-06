import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { FOUNDER_STAGES, STAGE_MOVE_SOURCES, setLeadStage } from "@/lib/services/stage";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The founder's stage moves (inbox buttons, board click or drag): Interested, Demo, Proposal, Won,
 * Lost. Audited with where the move came from; sends nothing. */
const schema = z.object({ stage: z.enum(FOUNDER_STAGES), via: z.enum(STAGE_MOVE_SOURCES).optional() });

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const { id } = await context.params;
    const input = schema.parse(await readJson(request));
    const result = await setLeadStage(id, input.stage, user.id, input.via);
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return fail(error);
  }
}
