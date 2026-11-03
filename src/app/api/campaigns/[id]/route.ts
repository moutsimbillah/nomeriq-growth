import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { getCampaign, renameCampaign } from "@/lib/services/campaigns";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ name: z.string().min(2).max(160) });

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireEditor();
    const { id } = await context.params;
    const campaign = await getCampaign(id);
    if (!campaign) {
      return NextResponse.json(
        { ok: false, error: "Campaign not found." },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, data: campaign });
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const { id } = await context.params;
    const input = schema.parse(await readJson(request));
    await renameCampaign(id, input.name);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
