import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { FOLLOW_UP_BATCH_MAX, prepareFollowUpDraftOutcome } from "@/lib/services/followups";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  prospectIds: z.array(z.string().uuid()).max(FOLLOW_UP_BATCH_MAX).optional(),
  /** "Prepare next N": the batch size the founder chose. */
  limit: z.number().int().min(1).max(FOLLOW_UP_BATCH_MAX).optional(),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const input = schema.parse(await readJson(request).catch(() => ({})));
    const outcome = await prepareFollowUpDraftOutcome({
      userId: user.id,
      prospectIds: input.prospectIds,
      limit: input.limit ?? input.prospectIds?.length,
      // A click in the portal is the founder's own decision; only the scheduled job needs the switch.
      trigger: "founder",
    });
    // `reason` is null when drafts were created; otherwise it names the real cause (the switch, the
    // day's cap, or nothing due) so the button never reports a timing problem that is not one.
    return NextResponse.json({
      ok: true,
      data: {
        prepared: outcome.drafts.length,
        reason: outcome.reason,
        drafts: outcome.drafts,
      },
    });
  } catch (error) {
    return fail(error);
  }
}
