import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { prepareFollowUpDraftOutcome } from "@/lib/services/followups";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  prospectIds: z.array(z.string().uuid()).optional(),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const input = schema.parse(await readJson(request).catch(() => ({})));
    const outcome = await prepareFollowUpDraftOutcome({
      userId: user.id,
      prospectIds: input.prospectIds,
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
