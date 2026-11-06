import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { fail, readJson } from "@/lib/api";
import { PROVIDER_CATALOG } from "@/lib/ai/provider-catalog";
import { listProviderModels } from "@/lib/ai/chat-transport";
import { AppError } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ provider: z.string(), baseUrl: z.string().max(500).optional(), apiKey: z.string().min(1).max(4000) });

/** Model discovery before saving a provider. The supplied credential is never persisted or returned. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const input = schema.parse(await readJson(request));
    const defaults = PROVIDER_CATALOG[input.provider];
    if (!defaults || input.provider === "brave") throw new AppError("Choose a chat provider.", 400, "invalid_provider");
    const baseUrl = input.baseUrl?.trim() || defaults.baseUrl;
    if (!baseUrl) throw new AppError("Enter the custom provider base URL first.", 400, "invalid_provider");
    let models: string[];
    try { models = await listProviderModels({ provider: input.provider, baseUrl, model: "" }, input.apiKey); }
    catch { throw new AppError("Could not load the model list. Check the provider URL and credential.", 502, "model_list_failed"); }
    return NextResponse.json({ ok: true, data: { models } });
  } catch (error) { return fail(error); }
}
