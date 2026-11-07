import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiUser, requireFounder } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { fail } from "@/lib/api";
import { applyHistoricalBounces, previewHistoricalBounces } from "@/lib/email/bounce-handling";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    await requireApiUser();
    const { id } = await context.params;
    z.string().uuid().parse(id);
    return NextResponse.json({ ok: true, data: await previewHistoricalBounces(id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const user = await requireFounder();
    const { id } = await context.params;
    z.string().uuid().parse(id);
    const body = z.object({ confirmation: z.literal("APPLY HISTORICAL BOUNCES") }).strict().parse(await request.json());
    const data = await applyHistoricalBounces({ accountId: id, founderUserId: user.id, confirmation: body.confirmation });
    return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(error); }
}
