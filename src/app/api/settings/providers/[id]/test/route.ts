import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { listResearchProviders } from "@/lib/deepseek/provider-pool";
import { testResearchProvider } from "@/lib/services/research-provider-admin";
import { fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Tests one provider against its own key and endpoint and records the result on its row,
 * so the Settings screen shows the last real outcome instead of a guess.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const { id } = await context.params;

    const outcome = await testResearchProvider(id);

    return NextResponse.json({
      ok: true,
      data: { ...outcome, providers: await listResearchProviders() },
    });
  } catch (error) {
    return fail(error);
  }
}