import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { getResearchJob } from "@/lib/services/research";
import { getResearchActivity } from "@/lib/services/research-activity";
import { fail } from "@/lib/api";
import { AppError } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The live transcript for one research job.
 *
 * Read-only. The client polls this while a job is active so the founder can see
 * what the engine is doing as it happens, rather than a spinner. Every line is
 * derived from a persisted row.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireEditor();
    const { id } = await context.params;
    const job = await getResearchJob(id);
    if (!job) throw new AppError("Research job not found.", 404);
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? 60);
    return NextResponse.json({
      ok: true,
      data: {
        job: {
          id: job.id,
          status: job.status,
          verifiedCount: job.verifiedCount,
          targetCount: job.targetCount,
          candidatesDiscovered: job.candidatesDiscovered,
          spentUsd: job.spentUsd,
          stopReason: job.stopReason,
        },
        items: await getResearchActivity(
          id,
          Number.isFinite(limit) ? limit : 60,
        ),
      },
    });
  } catch (error) {
    return fail(error);
  }
}
