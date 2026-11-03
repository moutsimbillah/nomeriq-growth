import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { createResearchJob, listResearchJobs } from "@/lib/services/research";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().min(2),
  targetCount: z.number().int().min(1).max(10000),
  categories: z.array(
    z.enum(["forex", "metals", "crypto", "indices", "commodities"]),
  ).min(1),
  regions: z.string().optional(),
  requirements: z.string().optional(),
  notes: z.string().optional(),
});

export async function GET() {
  try {
    await requireEditor();
    return NextResponse.json({ ok: true, data: await listResearchJobs() });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const input = schema.parse(await readJson(request));
    const job = await createResearchJob({ ...input, userId: user.id });
    return NextResponse.json({ ok: true, data: job });
  } catch (error) {
    return fail(error);
  }
}
