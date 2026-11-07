import { afterAll, beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getDb, closeDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { saveProspect } from "@/lib/services/prospects";
import { saveLeadAssessment, saveAudienceObservation, saveContactRoute, getLeadModel, setAssessmentOverride } from "@/lib/services/lead-model";
import { assessmentSchema, supportedFit, largestAudience, establishedAudience, emptyLeadModel, priorityFor, type LeadFinding } from "@/lib/leads/model";
import { ensureBootstrapUser } from "@/lib/auth/session";

const ids: string[] = []; let userId = "";
const checkedAt = new Date().toISOString();
function finding(area: LeadFinding["area"], sourceUrl = "https://fixture.example.test/signals", summary = "Verified official service evidence"): LeadFinding {
  return { area, summary, sourceUrl, observedAt: checkedAt, verdict: "present" };
}
function assessment(extra: Record<string, unknown> = {}) {
  return assessmentSchema.parse({ assessedAt: checkedAt, sourceKind: "research", provenanceKey: crypto.randomUUID(), ...extra });
}
beforeAll(async () => {
  await ensureWorkspaceDefaults();
  userId = (await ensureBootstrapUser({ email: `model-${crypto.randomUUID()}@example.test`, name: "Model fixture founder", password: crypto.randomUUID() })).id;
});
afterAll(async () => {
  const db = await getDb();
  for (const table of ["prospect_rejection_recommendations", "prospect_assessment_overrides", "prospect_audience_observations", "prospect_contact_route_observations", "prospect_assessments", "prospect_emails", "prospect_sources", "prospect_aliases"]) await db.query(`DELETE FROM ${table} WHERE prospect_id=ANY($1::uuid[])`, [ids]);
  await db.query("DELETE FROM prospects WHERE id=ANY($1::uuid[])", [ids]);
  await db.query("DELETE FROM api_keys WHERE created_by=$1", [userId]);
  await db.query("DELETE FROM users WHERE id=$1", [userId]);
  await closeDb();
});
async function lead(email = true, website = true) {
  const key = crypto.randomUUID().replaceAll("-", ""); const url = `https://${key}.example.test`;
  const profile = `https://instagram.com/m${key}`;
  const saved = await saveProspect({ businessName: `Model ${key}`, websiteUrl: website ? url : null, instagramUrl: profile,
    categories: ["forex"], qualificationStatus: "candidate", actorType: "seed",
    email: email ? `owner@${key}.example.test` : null, emailSourceUrl: website ? `${url}/contact` : profile, emailSourceType: "official_website",
    signalDescription: "Paid forex VIP signals with entries and exits", sources: [{ url: `${url}/signals`, label: "Paid service" }] });
  ids.push(saved.prospect.id); return { id: saved.prospect.id, url: website ? url : profile, profile };
}
function qualified(url: string, extra: Record<string, unknown> = {}) {
  return assessment({ eligibility: "eligible", findings: ["paid_signals", "markets", "email", "identity", "activity"].map(a => finding(a as LeadFinding["area"], `${url}/signals`)), ...extra });
}
it("approved additive migration is safe to re-run and does not reassess or alter existing leads", async () => {
  const f = await lead(); const db = await getDb();
  const before = (await db.query("SELECT * FROM prospects WHERE id=$1", [f.id])).rows;
  const sql = readFileSync("src/db/migrations/030_lead_model.sql", "utf8");
  await db.exec(sql); await db.exec(sql);
  expect((await db.query("SELECT * FROM prospects WHERE id=$1", [f.id])).rows).toEqual(before);
  expect(await getLeadModel(f.id)).toMatchObject({ tier: null, productFit: "unknown", priorityScore: null });
});
it("a basic website and Telegram delivery with an evidenced gap supports High", () => {
  const a = assessment({ productFit: "high", platformMaturity: "fragmented", fitReasoning: "Manual publishing is a verified gap", findings: [finding("delivery")], capabilityGaps: [finding("gap")] });
  expect(supportedFit(a)).toBe("high");
});
it("a membership site with an evidenced capability gap supports Medium", () => {
  expect(supportedFit(assessment({ productFit: "medium", platformMaturity: "partial", fitReasoning: "Membership exists but publishing is manual", findings: [finding("membership")], capabilityGaps: [finding("gap")] }))).toBe("medium");
});
it("a complete proprietary integrated platform supports Low only with sourced capabilities", () => {
  const a = assessment({ productFit: "low", platformMaturity: "integrated", fitReasoning: "The complete system already covers the platform need", findings: ["delivery", "membership", "publishing", "payments", "performance", "app"].map(a => finding(a as LeadFinding["area"])) });
  expect(supportedFit(a)).toBe("low");
  expect(supportedFit({ ...a, findings: [] })).toBe("unknown");
});
it("no technology information stays Unknown rather than High or Low", () => {
  for (const productFit of ["high", "low"] as const) expect(supportedFit(assessment({ productFit, fitReasoning: "No platform found" }))).toBe("unknown");
});
it("a branded app alone does not make weak remaining infrastructure Low", () => {
  expect(supportedFit(assessment({ productFit: "low", platformMaturity: "integrated", mobileAppStatus: "verified_present", fitReasoning: "An app is present", findings: [finding("app")] }))).toBe("unknown");
  expect(supportedFit(assessment({ productFit: "high", platformMaturity: "fragmented", mobileAppStatus: "verified_present", fitReasoning: "The app does not solve the verified manual publishing gap", findings: [finding("app"), finding("delivery")], capabilityGaps: [finding("gap")] }))).toBe("high");
});
it("qualification derives tiers from all mandatory checks, not a supplied label", async () => {
  const f = await lead(); const a = qualified(f.url);
  const saved = await saveLeadAssessment(f.id, a);
  expect(saved).toMatchObject({ tier: "other", eligibility: "eligible", productFit: "unknown", priorityProvisional: true });
  expect(Object.values(saved.eligibilityChecks).every(Boolean)).toBe(true);
  expect((await saveLeadAssessment(f.id, a)).assessmentId).toBe(saved.assessmentId);
  await expect(saveLeadAssessment(f.id, { ...a, fitReasoning: "Changed retry" })).rejects.toMatchObject({ code: "assessment_replay_conflict" });
  const incomplete = qualified(f.url, { assessedAt: new Date().toISOString(), findings: [finding("markets", `${f.url}/signals`)] });
  expect(await saveLeadAssessment(f.id, incomplete)).toMatchObject({ eligibility: "unknown", tier: null, priorityScore: null });
});
it("uses the largest single verified account; unknown replaces the account's old count, never zero", async () => {
  const f = await lead();
  const a = { platform: "instagram" as const, accountKey: "ignored-alias", handle: "@fixture", accountUrl: f.profile, countValue: 1200, countState: "verified" as const, checkedAt, sourceUrl: f.profile, provenanceKey: crypto.randomUUID() };
  await saveAudienceObservation(f.id, a);
  const saved = await saveLeadAssessment(f.id, qualified(f.url));
  expect(saved.tier).toBe("tier_1"); expect(establishedAudience(saved.audiences)).toBe(true); expect(largestAudience(saved.audiences,"tier_1")).toBe(1200);
  const unknown = await saveAudienceObservation(f.id, { ...a, countValue: null, countState: "unknown", checkedAt: new Date().toISOString(), provenanceKey: crypto.randomUUID() });
  expect(unknown.audiences).toHaveLength(1); expect(unknown.audiences[0].countValue).toBeNull();
  const next = await saveLeadAssessment(f.id, qualified(f.url, { assessedAt: new Date().toISOString() }));
  expect(next.tier).toBe("other");

});
it("Category B retains all official contact routes and never becomes email-qualified", async () => {
  const f = await lead(false);
  await saveContactRoute(f.id, { platform: "telegram", routeKind: "bot", routeUrl: "https://t.me/fixture_bot", officialStatus: "verified", checkedAt, sourceUrl: `${f.url}/contact`, provenanceKey: crypto.randomUUID() });
  await saveContactRoute(f.id, { platform: "website", routeKind: "form", routeUrl: `${f.url}/contact`, officialStatus: "verified", checkedAt, sourceUrl: `${f.url}/contact`, provenanceKey: crypto.randomUUID() });
  const saved = await saveLeadAssessment(f.id, qualified(f.url));
  expect(saved.tier).toBe("category_b"); expect(saved.contactRoutes).toHaveLength(2);
});
it("an officially published email without a website is retained outside counted tiers", async () => {
  const f = await lead(true, false);
  expect((await saveLeadAssessment(f.id, qualified(f.url))).tier).toBe("email_no_website");
});
it("founder overrides and history survive subsequent research, and only the founder can override", async () => {
  const f = await lead();
  const first = await saveLeadAssessment(f.id, qualified(f.url));
  const over = { field: "product_fit", decision: "set" as const, value: "high", reason: "Founder reviewed the opportunity", provenanceKey: crypto.randomUUID(), actorUserId: userId };
  expect((await setAssessmentOverride(f.id, over)).productFit).toBe("high");
  expect((await setAssessmentOverride(f.id, over)).productFit).toBe("high");
  const next = await saveLeadAssessment(f.id, qualified(f.url, { assessedAt: new Date().toISOString() }));
  expect(next.productFit).toBe("high"); expect(next.overriddenFields).toContain("product_fit");
  const db = await getDb(); expect((await db.query("SELECT id FROM prospect_assessments WHERE id=$1", [first.assessmentId])).rows).toHaveLength(1);
  await expect(setAssessmentOverride(f.id, { ...over, actorUserId: crypto.randomUUID(), provenanceKey: crypto.randomUUID() })).rejects.toMatchObject({ code: "founder_required" });
  const cleared = await setAssessmentOverride(f.id, { ...over, decision: "clear", value: undefined, provenanceKey: crypto.randomUUID() });
  expect(cleared.productFit).toBe("unknown");
});
it("new facts cannot be asserted using another business's official evidence", async () => {
  const f = await lead();
  await expect(saveLeadAssessment(f.id, qualified("https://not-this-business.example.test"))).rejects.toMatchObject({ code: "unlinked_assessment_source" });
});
it("checking a page today does not invent a recent activity event", () => {
  const event = finding("activity");
  const model = { ...emptyLeadModel(), findings: [event] };
  expect(priorityFor(model, new Date(checkedAt)).activity).toBe(1);
  model.findings = [{ ...event, activityAt: checkedAt }];
  expect(priorityFor(model, new Date(checkedAt)).activity).toBe(5);
  model.findings = [{ ...event, activityAt: new Date(Date.parse(checkedAt) - 45 * 86400000).toISOString() }];
  expect(priorityFor(model, new Date(checkedAt)).activity).toBe(3);
});
