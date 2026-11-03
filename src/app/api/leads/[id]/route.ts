import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { getProspect, updateProspect } from "@/lib/services/prospects";
import { fail, readJson } from "@/lib/api";
import type { Category, PipelineStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireEditor();
    const { id } = await context.params;
    const prospect = await getProspect(id);
    if (!prospect) {
      return NextResponse.json(
        { ok: false, error: "Prospect not found." },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, data: prospect });
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const { id } = await context.params;
    const body = await readJson<Record<string, any>>(request);
    const allowed = [
      "businessName",
      "websiteUrl",
      "country",
      "signalDescription",
      "pricingDetails",
      "evidenceSummary",
      "researchNotes",
      "founderNotes",
      "instagramUrl",
      "youtubeUrl",
      "xUrl",
      "telegramUrl",
      "linkedinUrl",
      "followerCount",
      "subscriberCount",
      "status",
      "nextAction",
      "nextActionAt",
      "doNotContact",
      "qualificationStatus",
      "rejectionReason",
    ];
    const update: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in body) update[key] = body[key];
    }
    if (Array.isArray(body.categories)) {
      update.categories = body.categories as Category[];
    }
    if (typeof update.status === "string") {
      const valid = [
        "new",
        "verified",
        "draft_prepared",
        "contacted",
        "replied",
        "interested",
        "demo",
        "proposal",
        "won",
        "lost",
      ];
      if (!valid.includes(update.status)) {
        return NextResponse.json(
          { ok: false, error: "Invalid pipeline status." },
          { status: 400 },
        );
      }
      update.status = update.status as PipelineStatus;
    }
    const prospect = await updateProspect(id, update, user.id);
    return NextResponse.json({ ok: true, data: prospect });
  } catch (error) {
    return fail(error);
  }
}
