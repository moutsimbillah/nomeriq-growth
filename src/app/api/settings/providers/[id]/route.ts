import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { listResearchProviders } from "@/lib/deepseek/provider-pool";
import { deleteResearchProvider, providerUsage, updateResearchProvider } from "@/lib/services/research-provider-admin";
import { listAiProviders } from "@/lib/ai/registry";
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

const deleteSchema = z.object({
  /** The working provider each action should move to. Required while anything still points here. */
  switchToProviderId: z.string().uuid().nullable().optional(),
});

/**
 * Retire a provider. Founder-only, and it refuses to leave an action pointing at nothing: while any
 * action or fallback list still names this provider, the caller must say which working provider takes
 * over, or the deletion does not happen.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const { id } = await context.params;
    const input = deleteSchema.parse(await readJson(request).catch(() => ({})));

    const outcome = await deleteResearchProvider(id, {
      actorUserId: user.id,
      switchToProviderId: input.switchToProviderId ?? null,
    });

    const remaining = await providerUsage();
    const usedBy = new Map(remaining.map(entry => [entry.providerId, entry.uses]));
    return NextResponse.json({
      ok: true,
      data: {
        deleted: outcome.name,
        reassignedTo: outcome.reassignedTo,
        providers: (await listResearchProviders()).map(provider => ({
          ...provider,
          usedBy: usedBy.get(provider.id) ?? [],
        })),
        aiProviders: (await listAiProviders()).map(provider => ({
          id: provider.id,
          name: provider.name,
          provider: provider.provider,
          kinds: provider.kinds,
          model: provider.model,
          priority: provider.priority,
          isEnabled: provider.isEnabled,
          lastTestOk: provider.lastTestOk,
        })),
      },
    });
  } catch (error) {
    return fail(error);
  }
}