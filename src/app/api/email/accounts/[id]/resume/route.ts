import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { resumeFromBouncePause } from "@/lib/email/bounce-handling";
import { fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Clear an automatic bounce pause.
 *
 * The pause is written by the sync when a profile's last 50 sends bounce more than 3% of the time; it
 * is cleared only here, by the founder, deliberately. Growth never resumes itself, because a profile
 * paused for bouncing would otherwise carry on sending into a reputation problem.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const { id } = await params;
    await resumeFromBouncePause(id);
    return NextResponse.json({ ok: true, data: { status: "connected" } });
  } catch (error) {
    return fail(error);
  }
}