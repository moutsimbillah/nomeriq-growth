import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { getResearchJob, updateResearchJobStatus } from "@/lib/services/research";
import { runResearchTick } from "@/lib/services/research-engine";
import { getJobBudget } from "@/lib/services/research-runs";
import { getResearchUsage } from "@/lib/services/research-usage";
import {
  getDeepSeekPublicSettings,
  resolveDeepSeekConfig,
} from "@/lib/deepseek/provider";
import { AppError } from "@/lib/utils";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const schema = z.object({
  action: z.enum(["start", "pause", "resume", "cancel", "tick"]),
  /** Runs a bounded tick inline so the founder sees immediate progress. */
  runNow: z.boolean().optional(),
});

/**
 * Founder control surface for the autonomous engine.
 *
 * `start`/`resume` activate a job and, unless disabled, immediately run one
 * bounded tick so the UI shows real progress instead of an empty promise.
 * `pause`/`cancel` are always safe: durable state is preserved either way.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const { id } = await context.params;
    const input = schema.parse(await readJson(request));

    const job = await getResearchJob(id);
    if (!job) throw new AppError("Research job not found.", 404);
    if (job.engine !== "deepseek") {
      throw new AppError(
        "This research target uses the manual engine. Create a DeepSeek target to run autonomous discovery.",
        409,
        "wrong_engine",
      );
    }

    if (input.action === "pause") {
      return NextResponse.json({
        ok: true,
        data: { job: await updateResearchJobStatus(id, "paused") },
      });
    }
    if (input.action === "cancel") {
      return NextResponse.json({
        ok: true,
        data: { job: await updateResearchJobStatus(id, "cancelled") },
      });
    }

    if (input.action === "start" || input.action === "resume") {
      const resolved = await resolveDeepSeekConfig();
      if (!resolved.config) {
        throw new AppError(
          resolved.error ||
            "DeepSeek is not configured. Add an API key before starting research.",
          409,
          "deepseek_not_configured",
        );
      }
      const budget = await getJobBudget(id);
      if (budget?.exhausted) {
        throw new AppError(
          `This job has spent its whole $${budget.budgetUsd.toFixed(2)} budget. Raise the budget before resuming.`,
          409,
          "budget_exhausted",
        );
      }
      await updateResearchJobStatus(id, "active");
    }

    // `start`, `resume` (with runNow) and `tick` all execute one bounded step.
    const runNow = input.runNow ?? true;
    let tick = null;
    if (runNow) {
      tick = await runResearchTick(id);
    }

    const [updated, budget, usage] = await Promise.all([
      getResearchJob(id),
      getJobBudget(id),
      getResearchUsage(id),
    ]);

    return NextResponse.json({
      ok: true,
      data: {
        job: updated,
        budget,
        usage,
        tick,
        deepseek: await getDeepSeekPublicSettings(),
      },
    });
  } catch (error) {
    return fail(error);
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireEditor();
    const { id } = await context.params;
    const job = await getResearchJob(id);
    if (!job) throw new AppError("Research job not found.", 404);
    const [budget, usage] = await Promise.all([
      getJobBudget(id),
      getResearchUsage(id),
    ]);
    return NextResponse.json({ ok: true, data: { job, budget, usage } });
  } catch (error) {
    return fail(error);
  }
}
