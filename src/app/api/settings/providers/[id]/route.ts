import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { listResearchProviders } from "@/lib/deepseek/provider-pool";
import { updateResearchProvider } from "@/lib/services/research-provider-admin";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  /** `chat`, `search` or `both` — correcting a row that was recorded wrongly. */
  kinds: z.enum(["chat", "search", "both"]).optional(),
  /** Empty or omitted keeps the stored key; the key is never sent back to the browser. */
  apiKey: z.string().max(500).optional().nullable(),
  baseUrl: z.string().max(500).optional(),
  model: z.string().max(300).optional(),
  searchPath: z.string().max(300).nullable().optional(),
  fetchPath: z.string().max(300).nullable().optional(),
  priority: z.number().int().min(1).max(1000).optional(),
  isEnabled: z.boolean().optional(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const { id } = await context.params;
    const input = patchSchema.parse(await readJson(request));

    await updateResearchProvider(id, input);

    return NextResponse.json({
      ok: true,
      data: { providers: await listResearchProviders() },
    });
  } catch (error) {
    return fail(error);
  }
}