import { z } from "zod";

/** The founder's canonical policy and dated amendments, not a model-authored instruction. */
export const LEAD_RULES_PATH = "docs/lead-rules.md";
export const LEAD_RULES_VERSION = "lead-rules-2026-11-07";
export const ESTABLISHED_AUDIENCE = 1000;
export const TIERS = ["tier_1", "other", "email_no_website", "category_b", "excluded"] as const;
export const FITS = ["high", "medium", "unknown", "low"] as const;
export type LeadTier = typeof TIERS[number];
export type ProductFit = typeof FITS[number];
export const FIT_POINTS: Record<ProductFit, number> = { high: 70, medium: 45, unknown: 30, low: 10 };
export const TIER_POINTS: Record<LeadTier, number> = { tier_1: 10, other: 7, email_no_website: 3, category_b: 0, excluded: 0 };
export const publicUrl = z.string().url().refine(value => {
  const u = new URL(value);
  return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password;
}, "A public HTTP(S) source URL without credentials is required.");
export const observedDate = z.string().datetime({ offset: true }).refine(value => Date.parse(value) <= Date.now(), "An observation cannot be dated in the future.");
export const findingSchema = z.object({
  area: z.enum(["paid_signals", "markets", "email", "identity", "activity", "delivery", "membership", "dashboard", "publishing", "performance", "payments", "app", "gap"]),
  summary: z.string().trim().min(3).max(4000), sourceUrl: publicUrl, observedAt: observedDate,
  verdict: z.enum(["present", "absent", "unknown"]).default("present"),
  activityAt: observedDate.optional(),
}).strict();
export type LeadFinding = z.infer<typeof findingSchema>;
export const audienceSchema = z.object({
  platform: z.enum(["instagram", "youtube", "telegram"]), accountKey: z.string().trim().min(1),
  handle: z.string().nullable().default(null), accountUrl: publicUrl,
  countValue: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  countState: z.enum(["verified", "unknown"]), checkedAt: observedDate, sourceUrl: publicUrl,
  officialLinkSourceUrl: publicUrl.nullable().default(null), isApproximate: z.boolean().default(false),
  displayedText: z.string().nullable().default(null), provenanceKey: z.string().trim().min(1),
}).strict().refine(a => a.countState === "verified" ? a.countValue !== null : a.countValue === null, "Unknown and zero are different; verified counts need a number.");
export type AudienceInput = z.infer<typeof audienceSchema>;
export interface AudienceObservation extends AudienceInput { id: string }
export const routeSchema = z.object({
  platform: z.string().trim().min(1), routeKind: z.enum(["dm", "group", "channel", "bot", "form", "other"]),
  handle: z.string().nullable().default(null), routeUrl: publicUrl.nullable().default(null),
  officialStatus: z.enum(["verified", "unknown", "unofficial"]).default("unknown"),
  checkedAt: observedDate, sourceUrl: publicUrl, officialLinkSourceUrl: publicUrl.nullable().default(null),
  notes: z.string().default(""), provenanceKey: z.string().trim().min(1),
}).strict().refine(r => Boolean(r.handle?.trim() || r.routeUrl), "A route needs a handle or URL.");
export type ContactRoute = z.infer<typeof routeSchema> & { id: string };
export const assessmentSchema = z.object({
  assessedAt: observedDate, sourceKind: z.enum(["research", "legacy_backfill", "founder"]),
  sourceReference: z.string().nullable().default(null), sourceAgent: z.string().nullable().default(null),
  aiProvider: z.string().nullable().default(null), aiModel: z.string().nullable().default(null),
  eligibility: z.enum(["unknown", "eligible", "excluded"]).default("unknown"),
  exclusionReason: z.string().trim().nullable().default(null),
  platformMaturity: z.enum(["unknown", "fragmented", "partial", "integrated"]).default("unknown"),
  mobileAppStatus: z.enum(["unknown", "verified_present", "not_found_in_checked_sources", "verified_absent"]).default("unknown"),
  productFit: z.enum(FITS).default("unknown"), capabilityGaps: z.array(findingSchema).default([]),
  findings: z.array(findingSchema).default([]), sourcesChecked: z.array(z.object({ url: publicUrl, checkedAt: observedDate })).default([]),
  missingInformation: z.array(z.string()).default([]), fitReasoning: z.string().default(""),
  researchConfidence: z.enum(["unknown", "low", "medium", "high"]).default("unknown"),
  legacySnapshot: z.record(z.string(), z.unknown()).default({}), provenanceKey: z.string().trim().min(1),
}).strict().refine(a => a.eligibility !== "excluded" || Boolean(a.exclusionReason), "Exclusion requires a reason.");
export type AssessmentInput = z.input<typeof assessmentSchema>;
export type ParsedAssessment = z.infer<typeof assessmentSchema>;
export interface PriorityComponents { productFit: number; tier: number; audience: number; evidence: number; activity: number }
export interface LeadModel {
  assessmentId: string | null; tier: LeadTier | null; eligibility: "unknown" | "eligible" | "excluded";
  exclusionReason: string | null; eligibilityChecks: Record<string, boolean>; productFit: ProductFit;
  platformMaturity: string; mobileAppStatus: string; fitReasoning: string;
  capabilityGaps: LeadFinding[]; findings: LeadFinding[]; sourcesChecked: { url: string; checkedAt: string }[];
  missingInformation: string[]; researchConfidence: string; priorityScore: number | null;
  priorityProvisional: boolean; priorityComponents: PriorityComponents; assessedAt: string | null;
  overriddenFields: string[]; audiences: AudienceObservation[]; contactRoutes: ContactRoute[];
}
export function emptyLeadModel(): LeadModel {
  return { assessmentId: null, tier: null, eligibility: "unknown", exclusionReason: null, eligibilityChecks: {}, productFit: "unknown", platformMaturity: "unknown", mobileAppStatus: "unknown", fitReasoning: "", capabilityGaps: [], findings: [], sourcesChecked: [], missingInformation: [], researchConfidence: "unknown", priorityScore: null, priorityProvisional: true, priorityComponents: { productFit: 30, tier: 0, audience: 0, evidence: 0, activity: 0 }, assessedAt: null, overriddenFields: [], audiences: [], contactRoutes: [] };
}
export function largestAudience(accounts: AudienceObservation[], tier: LeadTier | null): number | null {
  const platforms = tier === "category_b" || tier === "email_no_website" ? ["instagram", "youtube", "telegram"] : ["instagram", "youtube"];
  const verified = accounts.filter(a => platforms.includes(a.platform) && a.countState === "verified" && a.countValue !== null).map(a => a.countValue!);
  return verified.length ? Math.max(...verified) : null;
}
export function establishedAudience(accounts: AudienceObservation[]): boolean {
  return (largestAudience(accounts, "tier_1") ?? -1) >= ESTABLISHED_AUDIENCE;
}
export function audiencePoints(count: number | null): number {
  if (count === null) return 0;
  return count >= 100000 ? 8 : count >= 50000 ? 6 : count >= 10000 ? 4 : count >= 1000 ? 2 : 1;
}
/** A failed source lookup cannot establish absence. Non-Unknown fit requires actual setup evidence. */
export function supportedFit(input: ParsedAssessment): ProductFit {
  const present = new Set(input.findings.filter(f => f.verdict === "present").map(f => f.area));
  const gap = input.capabilityGaps.some(f => f.area === "gap" && f.verdict === "present");
  if (!input.fitReasoning.trim()) return "unknown";
  if (input.productFit === "high" && gap && present.has("delivery") && input.platformMaturity !== "unknown") return "high";
  if (input.productFit === "medium" && gap && ["membership", "dashboard", "publishing", "payments"].some(v => present.has(v as LeadFinding["area"]))) return "medium";
  if (input.productFit === "low" && input.platformMaturity === "integrated" && ["delivery", "membership", "publishing", "payments", "performance", "app"].every(v => present.has(v as LeadFinding["area"]))) return "low";
  return "unknown";
}
export function priorityFor(model: LeadModel, now = new Date()): PriorityComponents {
  const present = new Set(model.findings.filter(f => f.verdict === "present").map(f => f.area));
  const evidence = [present.has("paid_signals"), present.has("markets"), present.has("email") || model.contactRoutes.some(r=>r.officialStatus==="verified"), present.has("identity"), ["delivery","membership","dashboard","publishing","performance","payments"].some(a=>present.has(a as LeadFinding["area"])), model.findings.some(f=>f.area==="app"), present.has("gap") || model.capabilityGaps.some(g=>g.verdict==="present")].filter(Boolean).length;
  const activity = model.findings.filter(f => f.area === "activity" && f.verdict === "present");
  // The date checked is not an activity date. An undated working join earns only availability's 1.
  const datedActivity = activity.filter(f => f.activityAt);
  const age = datedActivity.length ? Math.min(...datedActivity.map(f => (now.getTime() - Date.parse(f.activityAt!)) / 86400000)) : Infinity;
  return { productFit: FIT_POINTS[model.productFit], tier: model.tier ? TIER_POINTS[model.tier] : 0, audience: audiencePoints(largestAudience(model.audiences, model.tier)), evidence, activity: age <= 30 ? 5 : age <= 90 ? 3 : activity.length ? 1 : 0 };
}
export function totalPriority(parts: PriorityComponents): number { return Object.values(parts).reduce((a, b) => a + b, 0); }
/** Approved ordering: effective score, then fit for ties; a founder score is never recalculated. */
export function compareLeadPriority(a: LeadModel, b: LeadModel): number {
  const band = { high: 4, medium: 3, unknown: 2, low: 1 };
  return (b.priorityScore ?? 0) - (a.priorityScore ?? 0) || band[b.productFit] - band[a.productFit];
}
