import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { prepareFollowUpDrafts } from "@/lib/services/followups";
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
    const drafts = await prepareFollowUpDrafts({
      userId: user.id,
      prospectIds: input.prospectIds,
    });
    return NextResponse.json({
      ok: true,
      data: {
        prepared: drafts.length,
        drafts,
      },
    });
  } catch (error) {
    return fail(error);
  }
}
