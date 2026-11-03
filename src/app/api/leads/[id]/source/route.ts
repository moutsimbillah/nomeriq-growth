import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { addProspectSource } from "@/lib/services/prospects";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  url: z.string().min(4),
  label: z.string().min(1),
  notes: z.string().optional().nullable(),
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
    return NextResponse.json({
      ok: true,
      data: await addProspectSource(id, input),
    });
  } catch (error) {
    return fail(error);
  }
}
