import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { updateResearchJobStatus } from "@/lib/services/research";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  status: z.enum(["active", "paused", "completed", "archived"]),
});

export async function PATCH(
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
      data: await updateResearchJobStatus(id, input.status),
    });
  } catch (error) {
    return fail(error);
  }
}
