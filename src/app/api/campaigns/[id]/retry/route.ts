import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { retryFailedCampaignItems } from "@/lib/services/campaigns";
import { fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const { id } = await context.params;
    return NextResponse.json({
      ok: true,
      data: await retryFailedCampaignItems(id),
    });
  } catch (error) {
    return fail(error);
  }
}
