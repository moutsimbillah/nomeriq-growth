import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { processNextCampaignItem } from "@/lib/services/campaigns";
import { fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const { id } = await context.params;
    return NextResponse.json({
      ok: true,
      data: await processNextCampaignItem(id, user.id),
    });
  } catch (error) {
    return fail(error);
  }
}
