import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { setCampaignStatus } from "@/lib/services/campaigns";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  status: z.enum(["paused", "active", "cancelled"]),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const { id } = await context.params;
    const input = schema.parse(await readJson(request));
    await setCampaignStatus(id, input.status);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
