import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ allowed: true }));
vi.mock("@/lib/auth/session", async original => ({
  ...await original<typeof import("@/lib/auth/session")>(),
  requireEditor: async () => {
    if (!auth.allowed) throw new (await import("@/lib/utils")).AppError("Sign in required.", 401, "unauthorized");
    return { id: "synthetic-read-only-user", role: "founder" };
  },
}));
import { getDb, closeDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { saveProspect } from "@/lib/services/prospects";
import { saveLeadAssessment, saveAudienceObservation } from "@/lib/services/lead-model";
import { runAgentAction } from "@/lib/agent/service";
import { GET } from "@/app/api/leads/[id]/route";
import type { LeadFinding } from "@/lib/leads/model";
const identity = { id: "oauth:lead-model-read-fixture", name: "Fixture reader", assistant: "custom" as const, scopes: ["research:read"] };
const ids: string[] = [];
let plainId = "", assessedId = "";
const checkedAt = new Date().toISOString();
beforeAll(async () => {
  await ensureWorkspaceDefaults();
  for (const assessed of [false, true]) {
    const key = crypto.randomUUID().replaceAll("-", ""); const url = `https://${key}.example.test`;
    const saved = await saveProspect({ businessName: `Read boundary ${key}`, websiteUrl: url, email: `owner@${key}.example.test`, emailSourceUrl: `${url}/contact`, categories: ["forex"], qualificationStatus: "candidate", actorType: "seed" });
    ids.push(saved.prospect.id);
    if (!assessed) { plainId = saved.prospect.id; continue; }
    assessedId = saved.prospect.id;
    const fact = (area: LeadFinding["area"]): LeadFinding => ({ area, summary: `Official fixture ${area} evidence`, sourceUrl: `${url}/${area}`, observedAt: checkedAt, verdict: "present" });
    await saveAudienceObservation(assessedId, { platform: "youtube", accountKey: key, accountUrl: `https://youtube.com/@${key}`, countValue: null, countState: "unknown", checkedAt, sourceUrl: `${url}/social`, officialLinkSourceUrl: `${url}/social`, provenanceKey: crypto.randomUUID() });
    await saveLeadAssessment(assessedId, { assessedAt: checkedAt, sourceKind: "research", productFit: "high", platformMaturity: "fragmented", fitReasoning: "Official evidence supports a manual delivery gap.", findings: ["paid_signals", "markets", "email", "identity", "activity", "delivery"].map(area => fact(area as LeadFinding["area"])), capabilityGaps: [fact("gap")], provenanceKey: crypto.randomUUID() });
  }
});
afterEach(() => { auth.allowed = true; });
afterAll(async () => {
  const db = await getDb();
  for (const table of ["prospect_assessments", "prospect_audience_observations", "prospect_sources", "prospect_emails", "prospect_aliases"]) await db.query(`DELETE FROM ${table} WHERE prospect_id=ANY($1::uuid[])`, [ids]);
  await db.query("DELETE FROM prospects WHERE id=ANY($1::uuid[])", [ids]);
  await closeDb();
});
async function read(id: string) {
  return GET(new Request(`http://localhost/api/leads/${id}`), { params: Promise.resolve({ id }) });
}
async function modelRowCount() {
  const db = await getDb();
  return (await db.query<{ n: string }>("SELECT count(*) AS n FROM prospect_assessments WHERE prospect_id=ANY($1::uuid[])", [ids])).rows[0].n;
}
it("the authenticated lead GET exposes the same sourced assessment as the agent reader", async () => {
  const response = await read(assessedId); expect(response.status).toBe(200);
  const json = await response.json();
  expect(json.data.leadModel).toMatchObject({ tier: "other", productFit: "high", platformMaturity: "fragmented", mobileAppStatus: "unknown" });
  expect(json.data.leadModel.capabilityGaps[0]).toMatchObject({ area: "gap", observedAt: checkedAt });
  expect(json.data.leadModel.audiences[0]).toMatchObject({ countValue: null, countState: "unknown", checkedAt });
  const agent = await runAgentAction(identity, "get_prospect", { prospectId: assessedId });
  expect((agent.data.prospect as { leadModel: unknown }).leadModel).toEqual(json.data.leadModel);
});
it("reading an unassessed import does not create an assessment or invent a score", async () => {
  const before = await modelRowCount();
  const response = await read(plainId); const json = await response.json();
  expect(json.data.leadModel).toMatchObject({ assessmentId: null, tier: null, productFit: "unknown", priorityScore: null });
  await runAgentAction(identity, "get_prospect", { prospectId: plainId });
  expect(await modelRowCount()).toBe(before);
});
it("GET still requires a session and the agent reader still requires research:read", async () => {
  auth.allowed = false;
  expect((await read(assessedId)).status).toBe(401);
  await expect(runAgentAction({ ...identity, scopes: [] }, "get_prospect", { prospectId: assessedId })).rejects.toMatchObject({ status: 403 });
});
it("a missing lead remains 404 rather than yielding a fabricated Unknown record", async () => {
  const missing = crypto.randomUUID();
  expect((await read(missing)).status).toBe(404);
  await expect(runAgentAction(identity, "get_prospect", { prospectId: missing })).rejects.toMatchObject({ code: "prospect_not_found" });
});
