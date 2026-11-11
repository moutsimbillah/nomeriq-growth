/**
 * Research targets count only qualified leads (docs/lead-rules.md, "Targets"): effective Tier 1 and
 * Other Signal Provider leads that are eligible. Email-no-website, Category B, excluded, unassessed,
 * legacy and archived records are kept but never counted. Progress and completion read the same
 * predicate; repeated saves, extra emails and extra assessments of one lead count once; later
 * downgrades and historical founder overrides decide through the effective lead model.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "@/lib/db/client";
import { ensureBootstrapUser } from "@/lib/auth/session";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import {
  createResearchJob,
  getOverallLeadTotals,
  getResearchJob,
  getResearchOverview,
  listResearchJobs,
  refreshResearchJobStatus,
  updateResearchJobStatus,
} from "@/lib/services/research";
import { archiveProspect, recordFounderEnteredEmail, saveProspect, type SaveProspectInput } from "@/lib/services/prospects";
import { getLeadModel, getLeadModels, saveLeadAssessment, setAssessmentOverride } from "@/lib/services/lead-model";
import { markProspectDuplicate } from "@/lib/services/prospect-duplicates";
import { runResearchTick } from "@/lib/services/research-engine";
import type { ResearchProvider } from "@/lib/deepseek/research-provider";
import { isQualifiedTargetModel, qualifiedTargetPredicateSql } from "@/lib/leads/qualified-target";
import type { LeadFinding } from "@/lib/leads/model";

type Kind = "tier_1" | "other" | "email_no_website" | "category_b" | "excluded";

const prospectIds = new Set<string>();
const jobIds = new Set<string>();
let founderId = "";
const now = () => new Date().toISOString();

function payload(kind: Kind, jobId: string | null): SaveProspectInput {
  const key = `qt${crypto.randomUUID().replaceAll("-", "")}`;
  const checkedAt = now();
  const website = `https://${key}.example.test`, profile = `https://instagram.com/${key}`;
  const url = kind === "email_no_website" ? profile : website;
  const fact = (area: LeadFinding["area"]): LeadFinding => ({ area, summary: `Synthetic official ${area} evidence`, sourceUrl: `${url}/${area}`, observedAt: checkedAt, verdict: "present" });
  const hasEmail = kind !== "category_b" && kind !== "excluded";
  return {
    businessName: `Qualified target ${kind} ${key}`,
    websiteUrl: kind === "email_no_website" ? null : website,
    instagramUrl: profile,
    categories: kind === "excluded" ? [] : ["forex"],
    signalDescription: "Synthetic official paid Forex VIP signals service",
    sources: [{ url: `${url}/signals`, label: "Official paid signals" }],
    email: hasEmail ? `owner@${key}.example.test` : null,
    emailSourceUrl: kind === "email_no_website" ? profile : `${website}/contact`,
    emailSourceType: kind === "email_no_website" ? "official_social" : "official_website",
    actorType: "api",
    researchJobId: jobId,
    leadAssessment: {
      assessedAt: checkedAt,
      eligibility: kind === "excluded" ? "excluded" : "eligible",
      exclusionReason: kind === "excluded" ? "Stocks and options only; no eligible signal market" : null,
      findings: [fact("paid_signals"), fact("markets"), fact("identity"), fact("activity"), ...(hasEmail ? [fact("email")] : [])],
    },
    audiences: kind === "tier_1" ? [{ platform: "instagram", accountKey: key, accountUrl: profile, countValue: 2500, countState: "verified", checkedAt, sourceUrl: profile }] : [],
    contactRoutes: kind === "category_b" ? [{ platform: "telegram", routeKind: "bot", routeUrl: `https://t.me/${key}_bot`, officialStatus: "verified", checkedAt, sourceUrl: `${website}/contact` }] : [],
  };
}

async function save(kind: Kind, jobId: string | null, assessedAt?: string) {
  const input = payload(kind, jobId);
  if (assessedAt) input.leadAssessment!.assessedAt = assessedAt;
  const saved = await saveProspect(input);
  expect(saved.created).toBe(true);
  prospectIds.add(saved.prospect.id);
  expect(saved.leadModel?.tier).toBe(kind);
  return { id: saved.prospect.id, input };
}

/** No assessment, saved explicitly as a candidate through the real service. */
async function saveUnassessed(jobId: string) {
  const key = `qt${crypto.randomUUID().replaceAll("-", "")}`;
  const saved = await saveProspect({
    businessName: `Qualified target unassessed ${key}`, websiteUrl: `https://${key}.example.test`, categories: ["forex"],
    email: `owner@${key}.example.test`, emailSourceUrl: `https://${key}.example.test/contact`, qualificationStatus: "candidate",
    signalDescription: "Synthetic signals", sources: [{ url: `https://${key}.example.test/signals`, label: "Signals" }],
    actorType: "api", researchJobId: jobId,
  });
  prospectIds.add(saved.prospect.id);
  return saved.prospect.id;
}

/**
 * A historical pre-lead-model "verified" lead with a published email and no assessment, inserted
 * explicitly as the old data looks. No current save path is used or bypassed to create it.
 */
async function insertLegacyVerified(jobId: string) {
  const db = await getDb();
  const key = `qt${crypto.randomUUID().replaceAll("-", "")}`, id = crypto.randomUUID();
  await db.query(
    `INSERT INTO prospects (id, business_name, name_key, website_url, domain_key, categories, qualification_status, verified_at, status, research_job_id, created_by_type)
     VALUES ($1, $2, $3, $4, $5, '["forex"]'::jsonb, 'verified', now(), 'verified', $6, 'legacy')`,
    [id, `Legacy verified ${key}`, `legacy verified ${key}`, `https://${key}.example.test/`, `${key}.example.test`, jobId],
  );
  prospectIds.add(id);
  await db.query(
    `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type, is_primary)
     VALUES ($1, $2, $3, $3, $4, 'official_website', true)`,
    [crypto.randomUUID(), id, `owner@${key}.example.test`, `https://${key}.example.test/contact`],
  );
  return id;
}

/** A historical founder decision on tier/eligibility. The current service refuses new ones. */
async function insertHistoricalOverride(prospectId: string, field: "tier" | "eligibility", decision: "set" | "clear", value: string | null, decidedAt: string) {
  const db = await getDb();
  await db.query(
    `INSERT INTO prospect_assessment_overrides (id, prospect_id, field_name, decision, value, reason, decided_by, decided_at, provenance_key)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'Historical founder decision', $6, $7, $8)`,
    [crypto.randomUUID(), prospectId, field, decision, value === null ? null : JSON.stringify(value), founderId, decidedAt, crypto.randomUUID()],
  );
}

async function newJob(target: number, engine: "manual" | "deepseek" = "manual") {
  const job = await createResearchJob({ name: `Qualified target job ${crypto.randomUUID()}`, targetCount: target, categories: ["forex"], engine, userId: founderId });
  jobIds.add(job.id);
  return job;
}

async function completedEvents(jobId: string) {
  const db = await getDb();
  return (await db.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM research_events WHERE job_id=$1 AND event_type='job_completed'`, [jobId])).rows;
}

/** Per-lead membership straight from the shared predicate. */
async function sqlQualified(ids: string[]) {
  const db = await getDb();
  const rows = (await db.query<{ id: string }>(`SELECT p.id FROM prospects p WHERE p.id = ANY($1::uuid[]) AND ${qualifiedTargetPredicateSql("p")}`, [ids])).rows;
  return new Set(rows.map(r => r.id));
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  founderId = (await ensureBootstrapUser({ email: `qualified-${crypto.randomUUID()}@example.test`, name: "Qualified target founder", password: crypto.randomUUID() })).id;
});
beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Qualified-target tests must not call any external service"); })));
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  const db = await getDb();
  const ids = [...prospectIds];
  for (const id of jobIds) await db.query("DELETE FROM research_jobs WHERE id=$1", [id]);
  await db.query("DELETE FROM prospect_duplicate_links WHERE prospect_id=ANY($1::uuid[]) OR canonical_prospect_id=ANY($1::uuid[])", [ids]);
  for (const table of ["research_events", "suppressions", "drafts", "prospect_assessment_overrides", "prospect_assessments", "prospect_audience_observations", "prospect_contact_route_observations", "prospect_sources", "prospect_emails", "prospect_aliases"]) {
    await db.query(`DELETE FROM ${table} WHERE prospect_id=ANY($1::uuid[])`, [ids]);
  }
  await db.query("DELETE FROM prospects WHERE id=ANY($1::uuid[])", [ids]);
  await db.query("DELETE FROM users WHERE id=$1", [founderId]);
  await closeDb();
});

describe("qualified target counts", () => {
  it("counts only effective eligible Tier 1 / Other leads; every other kind is retained but not counted", async () => {
    const overallBefore = await getOverallLeadTotals();
    const overviewBefore = await getResearchOverview();
    const job = await newJob(50);
    const tier1 = await save("tier_1", job.id);
    const other = await save("other", job.id);
    const emailNoWebsite = await save("email_no_website", job.id);
    const categoryB = await save("category_b", job.id);
    const excluded = await save("excluded", job.id);
    const unassessed = await saveUnassessed(job.id);
    const legacy = await insertLegacyVerified(job.id);
    const archived = await save("other", job.id);
    await archiveProspect(archived.id, founderId);

    const after = (await getResearchJob(job.id))!;
    expect(after.verifiedCount).toBe(2);
    expect(after.remaining).toBe(48);
    expect(after.status).toBe("active");
    // listResearchJobs reads the same JOB_SELECT.
    expect((await listResearchJobs()).find(j => j.id === job.id)?.verifiedCount).toBe(2);
    // The raw email total stays separate: verified, unarchived job leads with any email, whatever their tier.
    expect(after.emailCount).toBe(4);

    // Retained, not counted: every record still exists.
    const all = [tier1.id, other.id, emailNoWebsite.id, categoryB.id, excluded.id, unassessed, legacy, archived.id];
    const db = await getDb();
    expect(Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM prospects WHERE id=ANY($1::uuid[])", [all])).rows[0].n)).toBe(8);

    // The SQL predicate and the effective lead-model reader agree on each lead.
    const members = await sqlQualified(all);
    expect([...members].sort()).toEqual([tier1.id, other.id].sort());
    const models = await getLeadModels(all);
    for (const id of all.filter(id => id !== archived.id)) expect(members.has(id)).toBe(isQualifiedTargetModel(models.get(id)!));
    expect(isQualifiedTargetModel(models.get(archived.id)!)).toBe(true); // archived only drops out of the count

    const overallAfter = await getOverallLeadTotals();
    expect(overallAfter.qualifiedTargetLeads - overallBefore.qualifiedTargetLeads).toBe(2);
    const overviewAfter = await getResearchOverview();
    expect(overviewAfter.totalVerified - overviewBefore.totalVerified).toBe(2);
  });

  it("repeated saves, extra emails and repeated assessments of one lead count it once", async () => {
    const job = await newJob(50);
    const lead = await save("other", job.id);
    const retry = await saveProspect(lead.input);
    expect(retry).toMatchObject({ created: false, duplicate: true });
    await recordFounderEnteredEmail(lead.id, `second@${new URL(lead.input.websiteUrl!).hostname}`);
    const db = await getDb();
    expect(Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM prospect_emails WHERE prospect_id=$1", [lead.id])).rows[0].n)).toBe(2);
    for (let i = 0; i < 2; i++) {
      await saveLeadAssessment(lead.id, { ...lead.input.leadAssessment!, assessedAt: now(), sourceKind: "research", provenanceKey: crypto.randomUUID() });
    }
    expect(Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM prospect_assessments WHERE prospect_id=$1", [lead.id])).rows[0].n)).toBe(3);
    await setAssessmentOverride(lead.id, { field: "product_fit", decision: "set", value: "high", reason: "Founder reviewed fit", provenanceKey: crypto.randomUUID(), actorUserId: founderId });
    const job2 = (await getResearchJob(job.id))!;
    expect(job2.verifiedCount).toBe(1);
    expect(job2.emailCount).toBe(1);
    expect(job2.duplicatesRejected).toBe(1);
  });

  it("a later downgrade stops counting and the latest deterministic assessment wins", async () => {
    const job = await newJob(50);
    const t = Date.now();
    const lead = await save("other", job.id, new Date(t - 120_000).toISOString());
    expect((await getResearchJob(job.id))!.verifiedCount).toBe(1);
    // Later assessment without email evidence: eligibility unknown, no tier.
    await saveLeadAssessment(lead.id, { ...lead.input.leadAssessment!, assessedAt: new Date(t - 60_000).toISOString(), findings: lead.input.leadAssessment!.findings!.filter(f => f.area !== "email"), sourceKind: "research", provenanceKey: crypto.randomUUID() });
    expect((await getLeadModel(lead.id)).tier).toBeNull();
    expect((await getResearchJob(job.id))!.verifiedCount).toBe(0);
    // A back-dated eligible assessment saved afterwards is older by assessed_at, so it does not win.
    await saveLeadAssessment(lead.id, { ...lead.input.leadAssessment!, assessedAt: new Date(t - 90_000).toISOString(), sourceKind: "research", provenanceKey: crypto.randomUUID() });
    expect((await getLeadModel(lead.id)).tier).toBeNull();
    expect((await getResearchJob(job.id))!.verifiedCount).toBe(0);
    // A genuinely later eligible assessment counts again; every historical row is preserved.
    await saveLeadAssessment(lead.id, { ...lead.input.leadAssessment!, assessedAt: new Date(t - 30_000).toISOString(), sourceKind: "research", provenanceKey: crypto.randomUUID() });
    expect((await getLeadModel(lead.id)).tier).toBe("other");
    expect((await getResearchJob(job.id))!.verifiedCount).toBe(1);
    const db = await getDb();
    expect(Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM prospect_assessments WHERE prospect_id=$1", [lead.id])).rows[0].n)).toBe(4);
  });

  it("historical tier/eligibility founder overrides win exactly as the lead model reads them", async () => {
    const job = await newJob(50);
    const promoted = await save("email_no_website", job.id);
    const demoted = await save("tier_1", job.id);
    const cleared = await save("email_no_website", job.id);
    const base = Date.now();
    await insertHistoricalOverride(promoted.id, "tier", "set", "other", new Date(base - 5000).toISOString());
    await insertHistoricalOverride(demoted.id, "eligibility", "set", "excluded", new Date(base - 5000).toISOString());
    await insertHistoricalOverride(demoted.id, "tier", "set", "excluded", new Date(base - 5000).toISOString());
    await insertHistoricalOverride(cleared.id, "tier", "set", "tier_1", new Date(base - 5000).toISOString());
    await insertHistoricalOverride(cleared.id, "tier", "clear", null, new Date(base - 1000).toISOString());

    const models = await getLeadModels([promoted.id, demoted.id, cleared.id]);
    expect(models.get(promoted.id)).toMatchObject({ tier: "other", eligibility: "eligible" });
    expect(models.get(demoted.id)!.tier).toBe("excluded");
    expect(models.get(cleared.id)!.tier).toBe("email_no_website");
    const members = await sqlQualified([promoted.id, demoted.id, cleared.id]);
    expect([...members]).toEqual([promoted.id]);
    for (const [id, model] of models) expect(members.has(id)).toBe(isQualifiedTargetModel(model));
    expect((await getResearchJob(job.id))!.verifiedCount).toBe(1);
    // The current service still refuses new free-form tier overrides; history is untouched.
    await expect(setAssessmentOverride(promoted.id, { field: "tier", decision: "set", value: "tier_1", reason: "Try to promote", provenanceKey: crypto.randomUUID(), actorUserId: founderId })).rejects.toMatchObject({ code: "invalid_assessment_override" });
    const db = await getDb();
    expect(Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM prospect_assessment_overrides WHERE prospect_id=ANY($1::uuid[])", [[promoted.id, demoted.id, cleared.id]])).rows[0].n)).toBe(5);
  });

  it("a lead the founder marks as a duplicate stops counting", async () => {
    const job = await newJob(50);
    const canonical = await save("other", null);
    const duplicate = await save("other", job.id);
    expect((await getResearchJob(job.id))!.verifiedCount).toBe(1);
    await markProspectDuplicate({ prospectId: duplicate.id, canonicalProspectId: canonical.id, actor: { id: founderId, role: "founder" } });
    expect((await getResearchJob(job.id))!.verifiedCount).toBe(0);
  });

  it("a founder-entered email alone is not a published email and never makes a lead count", async () => {
    const job = await newJob(50);
    const key = `qt${crypto.randomUUID().replaceAll("-", "")}`;
    // No source-backed email at all: only an address the founder typed.
    const founderStaged = await saveProspect({
      businessName: `Founder email only ${key}`, websiteUrl: `https://${key}.example.test`, categories: ["forex"],
      signalDescription: "Synthetic signals", actorType: "founder", researchJobId: job.id,
      sources: [{ url: `https://${key}.example.test/signals`, label: "Signals" }],
    });
    prospectIds.add(founderStaged.prospect.id);
    await recordFounderEnteredEmail(founderStaged.prospect.id, `owner@${key}.example.test`);
    expect((await getResearchJob(job.id))!.verifiedCount).toBe(0);
    expect((await getResearchJob(job.id))!.emailCount).toBe(0);
  });

  it("a source-backed email counts once even after the founder adds another address", async () => {
    const job = await newJob(50);
    const lead = await save("other", job.id);
    expect((await getResearchJob(job.id))!.verifiedCount).toBe(1);
    await recordFounderEnteredEmail(lead.id, `second@${new URL(lead.input.websiteUrl!).hostname}`);
    // Two stored addresses on one prospect: the target is still one, and the raw emailed-record
    // total (rows, not addresses) is still one — never two counted prospects.
    expect((await getResearchJob(job.id))!.verifiedCount).toBe(1);
    expect((await getResearchJob(job.id))!.emailCount).toBe(1);
  });

  it("an unassessed lead with a website and an email is retained but never counts", async () => {
    const job = await newJob(50);
    const key = `qt${crypto.randomUUID().replaceAll("-", "")}`;
    const saved = await saveProspect({
      businessName: `Unassessed email ${key}`, websiteUrl: `https://${key}.example.test`, categories: ["forex"],
      email: `owner@${key}.example.test`, emailSourceUrl: `https://${key}.example.test/contact`,
      signalDescription: "Synthetic signals", actorType: "api", researchJobId: job.id,
      sources: [{ url: `https://${key}.example.test/signals`, label: "Signals" }],
    });
    prospectIds.add(saved.prospect.id);
    expect(saved.prospect.qualificationStatus).toBe("candidate");
    expect((await getResearchJob(job.id))!.verifiedCount).toBe(0);
    expect((await getResearchJob(job.id))!.emailCount).toBe(0);
    expect(await sqlQualified([saved.prospect.id])).toEqual(new Set());
    expect(isQualifiedTargetModel(await getLeadModel(saved.prospect.id))).toBe(false);
  });

  it("job counters, the per-job overview and the raw overall totals stay separate", async () => {
    const jobsBefore = (await getResearchOverview()).totalEmailsStored;
    const job = await newJob(50);
    const counted = await save("tier_1", job.id);
    const notCounted = await save("email_no_website", job.id);
    const current = (await getResearchJob(job.id))!;
    // Progress is the shared count; the stored-email figure is a raw total that includes both.
    expect(current).toMatchObject({ verifiedCount: 1, emailCount: 2, remaining: 49 });
    const overview = await getResearchOverview();
    expect(overview.totalEmailsStored - jobsBefore).toBe(2);
    // Raw overall verified records include the non-target tier; qualified targets do not.
    const overall = await getOverallLeadTotals();
    expect(overall.qualifiedTargetLeads).toBeLessThan(overall.verifiedLeads);
    // The not-counted lead's snapshot still reads as eligible under its own non-target tier.
    const model = await getLeadModel(notCounted.id);
    expect(model).toMatchObject({ tier: "email_no_website", eligibility: "eligible" });
    expect(isQualifiedTargetModel(model)).toBe(false);
    expect((await getLeadModel(counted.id)).tier).toBe("tier_1");
  });
});

describe("refreshResearchJobStatus completes only on a genuine qualified target", () => {
  it("non-target records never complete a job; the second qualified lead completes it once", async () => {
    const job = await newJob(2);
    await save("email_no_website", job.id);
    await save("category_b", job.id);
    await save("excluded", job.id);
    await saveUnassessed(job.id);
    await insertLegacyVerified(job.id);
    await save("email_no_website", job.id);
    await refreshResearchJobStatus(job.id);
    let current = (await getResearchJob(job.id))!;
    expect(current).toMatchObject({ status: "active", verifiedCount: 0, completedAt: null });
    expect(current.emailCount).toBeGreaterThanOrEqual(2); // raw emails alone never complete a target
    expect(await completedEvents(job.id)).toHaveLength(0);

    await save("tier_1", job.id);
    expect((await getResearchJob(job.id))!.status).toBe("active");
    await save("other", job.id); // saveProspect refreshes the job itself
    current = (await getResearchJob(job.id))!;
    expect(current).toMatchObject({ status: "completed", verifiedCount: 2, remaining: 0, stopReason: "Target reached." });
    expect(current.completedAt).not.toBeNull();
    await refreshResearchJobStatus(job.id);
    await refreshResearchJobStatus(job.id);
    const events = await completedEvents(job.id);
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ verifiedCount: 2, target: 2 });
  });

  it.each(["paused", "cancelled", "archived"] as const)("a %s job keeps its status even when the target is met", async status => {
    const job = await newJob(1);
    await updateResearchJobStatus(job.id, status);
    const before = (await getResearchJob(job.id))!;
    await save("other", job.id);
    await refreshResearchJobStatus(job.id);
    const after = (await getResearchJob(job.id))!;
    expect(after.verifiedCount).toBe(1);
    expect(after.status).toBe(status);
    expect(after.completedAt).toBe(before.completedAt);
    expect(after.stopReason).toBe(before.stopReason);
    expect(await completedEvents(job.id)).toHaveLength(0);
  });

  it("a completed job is not completed again or reopened", async () => {
    const job = await newJob(1);
    await save("tier_1", job.id);
    const done = (await getResearchJob(job.id))!;
    expect(done.status).toBe("completed");
    await save("other", job.id);
    await refreshResearchJobStatus(job.id);
    const after = (await getResearchJob(job.id))!;
    expect(after).toMatchObject({ status: "completed", completedAt: done.completedAt, verifiedCount: 2 });
    expect(await completedEvents(job.id)).toHaveLength(1);
  });
});

describe("engine tick uses the shared qualified count", () => {
  function stubProvider(searchResults: "throw" | "empty") {
    const calls = { search: 0, fetch: 0, chat: 0 };
    const provider: ResearchProvider = {
      model: "stub-no-network",
      recordsUsage: false,
      async search() {
        calls.search++;
        if (searchResults === "throw") throw new Error("search must not be called");
        return { results: [], costUsd: 0 };
      },
      async fetch() { calls.fetch++; throw new Error("fetch must not be called"); },
      async chatJson() { calls.chat++; throw new Error("chat must not be called"); },
    };
    return { provider, calls };
  }

  it("completes early with no provider calls once the genuine target is already met", async () => {
    const job = await newJob(1, "deepseek");
    expect(job.status).toBe("paused");
    await save("other", job.id); // a paused job never completes on save
    expect((await getResearchJob(job.id))!.status).toBe("paused");
    await updateResearchJobStatus(job.id, "active");
    const { provider, calls } = stubProvider("throw");
    const result = await runResearchTick(job.id, { provider });
    expect(result).toMatchObject({ status: "completed", stopReason: "Target reached." });
    expect(calls).toEqual({ search: 0, fetch: 0, chat: 0 });
    const after = (await getResearchJob(job.id))!;
    expect(after).toMatchObject({ status: "completed", verifiedCount: 1, ticks: 0 });
    const db = await getDb();
    expect((await db.query("SELECT id FROM research_runs WHERE job_id=$1", [job.id])).rows).toHaveLength(0);
    expect(await completedEvents(job.id)).toHaveLength(1);
  });

  it("does not complete early when only non-target records exist", async () => {
    const job = await newJob(1, "deepseek");
    await save("email_no_website", job.id);
    await save("category_b", job.id);
    await insertLegacyVerified(job.id);
    await updateResearchJobStatus(job.id, "active");
    const { provider, calls } = stubProvider("empty");
    const result = await runResearchTick(job.id, { provider, maxCandidatesPerTick: 1 });
    expect(result.status).not.toBe("completed");
    expect(calls.search).toBeGreaterThan(0); // the engine went on to search instead of stopping
    expect(calls.fetch + calls.chat).toBe(0);
    const after = (await getResearchJob(job.id))!;
    expect(after.verifiedCount).toBe(0);
    expect(after.status).not.toBe("completed");
    expect(await completedEvents(job.id)).toHaveLength(0);
  });
});
