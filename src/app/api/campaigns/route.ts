import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { createCampaign, listCampaigns } from "@/lib/services/campaigns";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().min(2),
  accountId: z.string().uuid(),
  draftIds: z.array(z.string().uuid()).min(1),
  authorize: z.literal(true),
});

export async function GET() {
  try {
    await requireEditor();
    return NextResponse.json({ ok: true, data: await listCampaigns() });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const input = schema.parse(await readJson(request));
    const campaign = await createCampaign({ ...input, userId: user.id });
    return NextResponse.json({ ok: true, data: campaign });
  } catch (error) {
    return fail(error);
  }
}
