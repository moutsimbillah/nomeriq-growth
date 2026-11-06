import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { saveProductTruth } from "@/lib/services/settings";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  oneLiner: z.string().min(1).max(500),
  offerSummary: z.string().max(5000),
  howItWorks: z.string().max(5000),
  pricingNotes: z.string().max(5000),
  integrations: z.string().max(5000),
  limitations: z.string().max(5000),
  approvedClaims: z.array(z.string().max(1000)).max(100),
  prohibitedClaims: z.array(z.string().max(500)).max(100),
  discoveryQuestions: z.array(z.string().max(1000)).max(50).optional(),
  approve: z.boolean(),
});

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const input = schema.parse(await readJson(request));
    return NextResponse.json({
      ok: true,
      data: await saveProductTruth(input, user.id),
    });
  } catch (error) {
    return fail(error);
  }
}
