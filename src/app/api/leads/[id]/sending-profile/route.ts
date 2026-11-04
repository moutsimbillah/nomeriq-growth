import { NextResponse } from "next/server";
import { z } from "zod";

import { fail, readJson } from "@/lib/api";
import { assertSameOrigin } from "@/lib/auth/request";
import { requireEditor } from "@/lib/auth/session";
import { changeSendingProfile } from "@/lib/email/profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The founder's one-click change of a lead's sending profile.
 *
 * Founder-only, and deliberately not exposed to any agent tool: AGENTS.md rule 5 keeps the agent
 * boundary to research, proposals and drafts. The refusal once a lead has already been emailed from its
 * profile comes from the service, so this route cannot be a way around it.
 */
const schema = z.object({ accountId: z.string().uuid() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const { id } = await context.params;
    const input = schema.parse(await readJson(request));
    await changeSendingProfile({ prospectId: id, accountId: input.accountId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
