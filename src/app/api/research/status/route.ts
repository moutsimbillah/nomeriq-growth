import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { listResearchJobs } from "@/lib/services/research";
import { getAllResearchUsage } from "@/lib/services/research-usage";
import { getResearchConfiguration } from "@/lib/services/research-routing";
import { fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live engine status for the research UI: jobs, aggregate DeepSeek spend and
 * whether the provider is configured. Costs are the real recorded amounts.
 */
export async function GET() {
  try {
    await requireEditor();
    const [jobs, usage, configuration] = await Promise.all([
      listResearchJobs(),
      getAllResearchUsage(),
      getResearchConfiguration(),
    ]);
    return NextResponse.json({
      ok: true,
      data: {
        jobs,
        usage,
        configuration,
        engineJobs: jobs.filter((job) => job.engine === "deepseek").length,
        activeEngineJobs: jobs.filter(
          (job) => job.engine === "deepseek" && job.status === "active",
        ).length,
      },
    });
  } catch (error) {
    return fail(error);
  }
}
