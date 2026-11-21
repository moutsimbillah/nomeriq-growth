import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { updateCampaignPacing } from "@/lib/services/campaigns";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  // Omitted = leave as is. null = no per-minute limit. 1..6 = that many. 0 / 7+ are refused.
  perMinuteCap: z.number().int().nullable().optional(),
  scheduledAt: z.string().nullable().optional(),
});

/**
 * The founder edits a campaign's pacing — including while it is running. The change takes effect on
 * the next send and is audited with the old and the new value.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const { id } = await context.params;
    const input = schema.parse(await readJson(request));
    const data = await updateCampaignPacing(
      id,
      { perMinuteCap: input.perMinuteCap, scheduledAt: input.scheduledAt },
      user.id,
    );
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    return fail(error);
  }
}
