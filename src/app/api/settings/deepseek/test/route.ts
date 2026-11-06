import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import {
  getDeepSeekPublicSettings,
  recordDeepSeekTest,
  resolveDeepSeekConfig,
  saveDeepSeekSettings,
  testDeepSeekConnection,
} from "@/lib/deepseek/provider";
import { recordResearchUsage } from "@/lib/services/research-usage";
import { AppError } from "@/lib/utils";
import { fail } from "@/lib/api";
import { testProviderChat } from "@/lib/ai/provider-test";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const { config, error } = await resolveDeepSeekConfig();
    if (!config) {
      throw new AppError(
        error || "DeepSeek is not configured.",
        409,
        "deepseek_not_configured",
      );
    }
    const current = await getDeepSeekPublicSettings();
    let result;
    try {
      const chat = await testProviderChat({ provider: "deepseek", baseUrl: config.baseUrl, model: config.model }, config.apiKey);
      if (!chat.ok) throw new AppError(chat.message, 502, chat.code ?? "chat_test_failed");
      result = await testDeepSeekConnection(config);
      result = { ...result, ok: result.ok && result.fetchOk, message: `${chat.message} ${result.message}` };
    } catch (testError) {
      const message =
        testError instanceof Error ? testError.message : "Connection test failed.";
      await recordDeepSeekTest({ ok: false, message });
      throw new AppError(message, 502, "deepseek_test_failed");
    }
    await recordDeepSeekTest({ ok: result.ok, message: result.message });

    // A custom endpoint may implement Search and Fetch at non-DeepSeek paths.
    // Persist what actually worked, but only when the credential came from the
    // database (an environment-configured key has no row to update) and only when
    // the detected path differs from what is already stored.
    if (
      config.source === "database" &&
      result.ok &&
      (result.searchPath !== (current?.searchPath ?? null) ||
        result.fetchPath !== (current?.fetchPath ?? null))
    ) {
      await saveDeepSeekSettings({
        searchPath: result.searchPath,
        fetchPath: result.fetchPath,
        userId: user.id,
      }).catch(() => undefined);
    }

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
