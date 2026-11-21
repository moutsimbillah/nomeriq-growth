import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import {
  createCampaign,
  createBatchCampaign,
  listCampaigns,
  MAX_CAMPAIGN_BATCH,
} from "@/lib/services/campaigns";
import { fail, readJson } from "@/lib/api";
import { AppError } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const filtersSchema = z.object({
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
});

const schema = z.object({
  name: z.string().min(2),
  accountId: z.string().uuid(),
  // The single-draft path. Omit it and give `filters` to create from a batch instead.
  draftIds: z.array(z.string().uuid()).min(1).optional(),
  filters: filtersSchema.optional(),
  limit: z.number().int().min(1).max(MAX_CAMPAIGN_BATCH).optional(),
  scheduledAt: z.string().nullable().optional(),
  // 1..6, or null for "no per-minute limit". Out-of-range values are refused by the service, never clamped.
  perMinuteCap: z.number().int().nullable().optional(),
  /** The founder's explicit "approve this batch" action. Required for the batch path. */
  approveBatch: z.boolean().optional(),
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
    if (input.draftIds?.length) {
      const campaign = await createCampaign({
        name: input.name,
        draftIds: input.draftIds,
        accountId: input.accountId,
        userId: user.id,
        authorize: true,
        scheduledAt: input.scheduledAt,
        perMinuteCap: input.perMinuteCap,
      });
      return NextResponse.json({ ok: true, data: campaign });
    }
    if (input.filters) {
      const campaign = await createBatchCampaign({
        name: input.name,
        accountId: input.accountId,
        userId: user.id,
        authorize: true,
        approveBatch: input.approveBatch === true,
        filters: input.filters,
        limit: input.limit ?? 50,
        scheduledAt: input.scheduledAt,
        perMinuteCap: input.perMinuteCap,
      });
      return NextResponse.json({ ok: true, data: campaign });
    }
    throw new AppError(
      "Provide draftIds for a single-draft campaign, or filters for a batch.",
      400,
      "invalid_campaign_request",
    );
  } catch (error) {
    return fail(error);
  }
}

