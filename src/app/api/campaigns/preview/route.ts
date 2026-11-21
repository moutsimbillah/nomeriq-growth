import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { previewCampaignBatch, MAX_CAMPAIGN_BATCH } from "@/lib/services/campaigns";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  filters: z.object({
    agent: z.string().min(1).optional(),
    sender: z.string().min(1).optional(),
    market: z.string().min(1).optional(),
    stage: z.string().min(1).optional(),
    tier: z.enum(["tier_1", "other", "email_no_website", "category_b", "excluded", "unassessed"]).optional(),
    hasEmail: z.boolean().optional(),
    notContacted: z.boolean().optional(),
    added: z
      .enum(["today", "yesterday", "last7", "last30", "this_month", "last_month", "custom"])
      .optional(),
    addedFrom: z.string().optional(),
    addedTo: z.string().optional(),
  }),
  limit: z.number().int().min(1).max(MAX_CAMPAIGN_BATCH).optional(),
});

/**
 * A read-only "what would this batch be?" for the founder: the total matches, the ids a limit selects
 * and every mechanical refusal. Nothing is approved, created or sent.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const input = schema.parse(await readJson(request));
    const preview = await previewCampaignBatch({
      filters: input.filters,
      limit: input.limit ?? 50,
    });
    return NextResponse.json({ ok: true, data: preview });
  } catch (error) {
    return fail(error);
  }
}
