import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { runWorkerForAllDueJobs } from "@/lib/services/research-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Durable research worker.
 *
 * Vercel Cron (or any scheduler) calls this on a fixed cadence. Each invocation
 * takes one bounded step per due active job. Because every piece of progress is
 * persisted, a timeout or redeploy cannot lose or restart the research.
 *
 * This route only researches and saves drafts. It never sends email.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET is not configured." },
      { status: 503 },
    );
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  // Fail closed if the database itself is unreachable, rather than reporting
  // fabricated progress.
  const db = await getDb();
  await db.query("SELECT 1");

  const { ticks, interruptedRuns } = await runWorkerForAllDueJobs({
    maxJobs: Number(process.env.RESEARCH_WORKER_MAX_JOBS ?? 3),
  });

  const saved = ticks.reduce((sum, tick) => sum + tick.saved, 0);
  const spent = ticks.reduce((sum, tick) => sum + tick.spentUsd, 0);

  return NextResponse.json({
    ok: true,
    data: {
      jobsAdvanced: ticks.length,
      saved,
      spentUsd: spent,
      interruptedRuns,
      ticks,
      note: "Research only. No email was sent.",
    },
  });
}
