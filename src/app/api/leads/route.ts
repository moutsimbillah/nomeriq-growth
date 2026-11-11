import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { saveProspect } from "@/lib/services/prospects";
import { fail, readJson } from "@/lib/api";
import type { Category } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const body = await readJson<Record<string, any>>(request);
    const result = await saveProspect({
      businessName: String(body.businessName || ""),
      websiteUrl: body.websiteUrl || null,
      country: body.country || null,
      categories: (Array.isArray(body.categories) ? body.categories : []) as Category[],
      signalDescription: body.signalDescription || null,
      pricingDetails: body.pricingDetails || null,
      evidenceSummary: body.evidenceSummary || null,
      researchNotes: body.researchNotes || null,
      email: body.email || null,
      emailSourceUrl: body.emailSourceUrl || null,
      emailSourceType: body.emailSourceType || "official_website",
      instagramUrl: body.instagramUrl || null,
      youtubeUrl: body.youtubeUrl || null,
      xUrl: body.xUrl || null,
      telegramUrl: body.telegramUrl || null,
      linkedinUrl: body.linkedinUrl || null,
      otherSocials: [],
      followerCount: body.followerCount || null,
      subscriberCount: body.subscriberCount || null,
      sources: Array.isArray(body.sources) ? body.sources : [],
      aliases: Array.isArray(body.aliases) ? body.aliases : [],
      researchJobId: body.researchJobId || null,
      qualificationStatus: "candidate",
      leadAssessment: body.leadAssessment,
      audiences: body.audiences,
      contactRoutes: body.contactRoutes,
      actorType: "founder",
      actorUserId: user.id,
    });
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return fail(error);
  }
}
