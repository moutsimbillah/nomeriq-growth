import { NextResponse } from "next/server";
import { z } from "zod";

import { fail, readJson } from "@/lib/api";
import { assertSameOrigin } from "@/lib/auth/request";
import { requireEditor } from "@/lib/auth/session";
import { setFollowUpExclusion } from "@/lib/services/prospects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The founder's one-click exclusion of a lead from automatic follow-ups.
 *
 * Founder-only, and deliberately not exposed to any agent tool: AGENTS.md rule 5 keeps the agent
 * boundary to research, proposals and drafts. This only stops the 04:00 job writing to the lead —
 * `do_not_contact` is untouched, so a deliberate email from the founder still goes out.
 */
const schema = z.object({ excluded: z.boolean() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const { id } = await context.params;
    const input = schema.parse(await readJson(request));
    const excluded = await setFollowUpExclusion(id, input.excluded);
    return NextResponse.json({ ok: true, excluded });
  } catch (error) {
    return fail(error);
  }
}