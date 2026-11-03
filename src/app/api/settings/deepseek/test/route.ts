import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import {
  getDeepSeekPublicSettings,
  recordDeepSeekTest,
  resolveDeepSeekConfig,
  testDeepSeekConnection,
} from "@/lib/deepseek/provider";
import { recordResearchUsage } from "@/lib/services/research-usage";
import { AppError } from "@/lib/utils";
import { fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const { config, error } = await resolveDeepSeekConfig();
    if (!config) {
      throw new AppError(
        error || "DeepSeek is not configured.",
        409,
        "deepseek_not_configured",
      );
    }
    let result;
    try {
      result = await testDeepSeekConnection(config);
    } catch (testError) {
      const message =
        testError instanceof Error ? testError.message : "Connection test failed.";
      await recordDeepSeekTest({ ok: false, message });
      throw new AppError(message, 502, "deepseek_test_failed");
    }
    await recordDeepSeekTest({ ok: result.ok, message: result.message });
    await recordResearchUsage({
      operation: "search",
      model: config.model,
      costUsd: result.costUsd,
      metadata: {
        connectionTest: true,
        searchOk: result.searchOk,
        fetchOk: result.fetchOk,
      },
    }).catch(() => undefined);
    return NextResponse.json({
      ok: true,
      data: {
        ...result,
        settings: await getDeepSeekPublicSettings(),
      },
    });
  } catch (error) {
    return fail(error);
  }
}
