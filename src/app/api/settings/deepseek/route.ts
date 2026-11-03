import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import {
  getDeepSeekPublicSettings,
  saveDeepSeekSettings,
} from "@/lib/deepseek/provider";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  apiKey: z.string().max(500).optional(),
  baseUrl: z.string().max(500).optional(),
  model: z.string().max(100).optional(),
});

export async function GET() {
  try {
    await requireEditor();
    return NextResponse.json({
      ok: true,
      data: await getDeepSeekPublicSettings(),
    });
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const input = schema.parse(await readJson(request));
    return NextResponse.json({
      ok: true,
      data: await saveDeepSeekSettings({ ...input, userId: user.id }),
    });
  } catch (error) {
    return fail(error);
  }
}
