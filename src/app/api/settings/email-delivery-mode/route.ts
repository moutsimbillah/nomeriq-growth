import { NextResponse } from "next/server";
import { z } from "zod";
import { requireFounder } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { fail, readJson } from "@/lib/api";
import { setEmailDeliveryMode } from "@/lib/services/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ mode: z.enum(["sandbox", "live"]) });

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireFounder();
    const { mode } = schema.parse(await readJson(request));
    const effectiveMode = await setEmailDeliveryMode(mode, user.id);
    return NextResponse.json({ ok: true, data: { mode: effectiveMode } });
  } catch (error) {
    return fail(error);
  }
}
