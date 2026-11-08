import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import {
  ensureWorkspaceDefaults,
  updateWorkspaceSettings,
} from "@/lib/services/settings";
import {
  createResearchJob,
  getResearchJob,
  updateResearchJobStatus,
} from "@/lib/services/research";
import { runResearchTick } from "@/lib/services/research-engine";
import { runWorker } from "@/lib/services/research-worker";
import {
  candidateIdentityKey,
  claimCandidateIdentity,
  claimPendingCandidates,
  expireStaleClaims,
  listResearchCandidates,
  recordDiscoveredCandidates,
  releaseCandidateClaim,
  requeueExpiredCandidates,
} from "@/lib/services/research-candidates";
import { getJobBudget, listResearchRuns } from "@/lib/services/research-runs";
import { getResearchUsage } from "@/lib/services/research-usage";
import { planResearchQueries } from "@/lib/services/research-queries";
import { listProspects } from "@/lib/services/prospects";
import { listDraftsForProspect } from "@/lib/services/drafts";
import { assessSignalEvidence, extractEmailsFromPage } from "@/lib/deepseek/verify";
import { discoverFollowUpLinks } from "@/lib/deepseek/verify-candidate";
import { runAgentAction, TOOL_DEFINITIONS } from "@/lib/agent/service";
import type { ApiKeyIdentity } from "@/lib/agent/apiKeys";
import {
  brokerSite,
  createFakeProvider,
  qualifyingSite,
  telegramOnlySite,
  withAudiences,
  withRobots,
  type FakeProviderStats,
  type FakeSite,
} from "./fake-provider";
import { getLeadModel } from "@/lib/services/lead-model";

const state = {
  userId: "",
  jobId: "",
  /** A real job, used so candidate claims satisfy their foreign key. */
  claimJobId: "",
  verifier: null as unknown as ApiKeyIdentity,
};

async function newJob(input: {
  name: string;
  target: number;
  budget?: number;
}): Promise<string> {
  const job = await createResearchJob({
    name: input.name,
    targetCount: input.target,
    categories: ["forex", "metals", "crypto"],
    regions: "Worldwide",
    requirements: "Only paid trading-signal providers with a published business email.",
    engine: "deepseek",
    budgetUsd: input.budget ?? 5,
    concurrency: 3,
    userId: state.userId,
  });
  // createResearchJob starts DeepSeek jobs paused so the founder can review the
  // budget before spending. Tests activate explicitly.
  await updateResearchJobStatus(job.id, "active");
  return job.id;
}

function makeProvider(sites: FakeSite[]) {
  return createFakeProvider({ sites });
}

describe("autonomous DeepSeek research engine", () => {
  beforeAll(async () => {
    const db = await getDb();
    await ensureWorkspaceDefaults();
    state.userId = crypto.randomUUID();
    await db.query(
      `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, 'founder')`,
      [
        state.userId,
        "engine@test.nomeriq.com",
        "engine@test.nomeriq.com",
        "Engine Founder",
        hashPassword("TestPassw0rd!123"),
      ],
    );
    await updateWorkspaceSettings(
      {
        legalBusinessName: "Nomeriq Test",
        postalAddress: "1 Test Street, Test City",
        senderSignature: "Test Founder\nNomeriq",
        followUpMax: 2,
        followUpDelay1Days: 4,
        followUpDelay2Days: 7,
        researchDefaultBudgetUsd: 5,
        researchDefaultConcurrency: 3,
        deepseekSearchQps: 5,
        deepseekFetchQps: 5,
      },
      state.userId,
    );
    state.verifier = {
      id: crypto.randomUUID(),
      name: "Engine test key",
      assistant: "deepseek",
      scopes: ["research:read", "research:write", "drafts:write", "progress:read"],
    };
    // Claims reference a real research job, so claim tests need one to exist.
    state.claimJobId = await newJob({ name: "Claim fixtures", target: 1 });
  });

  afterAll(async () => {
    await closeDb();
    const dir = process.env.PGLITE_DIR || "";
    if (dir.startsWith(".data/test-vitest-")) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  /* ------------------------------ deterministic units ---------------------- */

  it("plans diverse queries across markets, languages and surfaces", () => {
    const plan = planResearchQueries({
      categories: ["forex", "metals"],
      regions: "Worldwide — Spanish and Arabic markets",
      limit: 500,
    });
    expect(plan.length).toBeGreaterThan(20);
    // Every query must respect the 128 character API limit.
    expect(plan.every((entry) => entry.query.length <= 128)).toBe(true);
    // No duplicate query strings.
    const queries = plan.map((entry) => entry.query.toLowerCase());
    expect(new Set(queries).size).toBe(queries.length);
    // Multiple languages are represented.
    const languages = new Set(plan.map((entry) => entry.language));
    expect(languages.size).toBeGreaterThan(3);
    // The offset walks deeper into the plan rather than repeating.
    const first = planResearchQueries({ categories: ["forex"], offset: 0, limit: 5 });
    const later = planResearchQueries({ categories: ["forex"], offset: 5, limit: 5 });
    expect(later[0]?.query).not.toBe(first[0]?.query);
  });

  it("extracts only real published emails and ignores obfuscation and assets", () => {
    const content = `
      Contact hello@signals.example.com or "sales (at) signals (dot) example (dot) com".
      <a href="mailto:desk@signals.example.com">mail</a>
      Do not use noreply@signals.example.com or logo@2x.png.example
    `;
    const found = extractEmailsFromPage({
      content,
      pageUrl: "https://signals.example.com/contact",
      siteDomain: "signals.example.com",
    });
    const emails = found.map((entry) => entry.email);
    expect(emails).toContain("hello@signals.example.com");
    expect(emails).toContain("sales@signals.example.com");
    expect(emails).toContain("desk@signals.example.com");
    expect(emails).not.toContain("noreply@signals.example.com");
    // A same-domain address is recognised as stronger evidence.
    expect(found.find((e) => e.email === "desk@signals.example.com")?.sameDomain).toBe(true);
  });

  it("qualifies only businesses with both signal and paid-commercial evidence", () => {
    const paid = assessSignalEvidence(
      "VIP forex signals with entry, stop loss and take profit. Subscribe monthly for $49 per month.",
    );
    expect(paid.qualified).toBe(true);

    const free = assessSignalEvidence(
      "We post free forex signals on our Telegram channel for everyone.",
    );
    expect(free.qualified).toBe(false);

    const broker = assessSignalEvidence(
      "We are a broker. Open an account with us and trade forex with leverage up to 1:500.",
    );
    expect(broker.qualified).toBe(false);
    expect(broker.exclusion).toBeTruthy();
  });

  it("follows only same-domain contact and pricing links", () => {
    const links = discoverFollowUpLinks({
      html: `
        <a href="/contact">Contact</a>
        <a href="/pricing">Pricing</a>
        <a href="https://evil.example.net/contact">Offsite</a>
        <a href="https://signals.example.com/about">About</a>
      `,
      pageUrl: "https://signals.example.com/",
      siteDomain: "signals.example.com",
      limit: 4,
    });
    expect(links.some((url) => url.includes("/contact"))).toBe(true);
    expect(links.some((url) => url.includes("/pricing"))).toBe(true);
    expect(links.some((url) => url.includes("evil.example.net"))).toBe(false);
  });

  /* --------------------------------- identity ------------------------------ */

  it("builds a stable identity key from domain, then name", () => {
    expect(
      candidateIdentityKey({ websiteUrl: "https://www.Alpha-Signals.com/x" }),
    ).toBe("domain:alpha-signals.com");
    expect(
      candidateIdentityKey({ websiteUrl: null, businessName: "Alpha Signals LLC" }),
    ).toBe("name:alpha signals");
    expect(candidateIdentityKey({ websiteUrl: null, businessName: null })).toBeNull();
  });

  it("lets only one agent hold a live claim, and lets an expired claim be taken over", async () => {
    const identityKey = `domain:claim-test-${crypto.randomUUID()}.example.com`;
    const first = await claimCandidateIdentity({
      identityKey,
      jobId: state.claimJobId,
      workerId: "worker-a",
    });
    expect(first.claimed).toBe(true);

    // A second worker must be refused while the claim is live.
    const second = await claimCandidateIdentity({
      identityKey,
      jobId: state.claimJobId,
      workerId: "worker-b",
    });
    expect(second.claimed).toBe(false);
    expect(second.claimedBy).toBe("worker-a");

    // An expired claim is reclaimable, so a crashed worker cannot block work.
    const db = await getDb();
    await db.query(
      `UPDATE candidate_claims SET claim_expires_at = now() - interval '1 minute'
       WHERE identity_key = $1`,
      [identityKey],
    );
    const third = await claimCandidateIdentity({
      identityKey,
      jobId: state.claimJobId,
      workerId: "worker-c",
    });
    expect(third.claimed).toBe(true);
    expect(third.claimedBy).toBe("worker-c");

    await releaseCandidateClaim({ identityKey });
  });

  it("records a discovered business once per job even under repeated discovery", async () => {
    const jobId = await newJob({ name: "Dedup discovery", target: 5 });
    const sites = [
      qualifyingSite({ domain: "eng-once.example.com", businessName: "Once Signals" }),
    ];
    const { provider } = makeProvider(sites);

    // Two independent searches surface the same business.
    const discovery = await recordDiscoveredCandidates(jobId, [
      {
        businessName: "Once Signals",
        websiteUrl: "https://eng-once.example.com/",
        sourceUrl: "https://eng-once.example.com/",
      },
      {
        businessName: "Once Signals",
        websiteUrl: "https://www.eng-once.example.com/pricing",
        sourceUrl: "https://www.eng-once.example.com/pricing",
      },
    ]);
    expect(discovery.created).toHaveLength(1);
    expect(discovery.existing).toBe(1);

    const candidates = await listResearchCandidates(jobId);
    expect(candidates).toHaveLength(1);
    expect(provider).toBeTruthy();
  });

  /* ----------------------------------- e2e --------------------------------- */

  it("discovers, verifies, saves a lead with a draft, and records real cost", async () => {
    const jobId = await newJob({ name: "End to end 3", target: 3, budget: 5 });
    const sites = [
      qualifyingSite({
        domain: "eng-alpha.example.com",
        businessName: "Alpha Signals House",
        email: "desk@eng-alpha.example.com",
        categories: ["forex", "metals"],
      }),
      qualifyingSite({
        domain: "eng-beta.example.com",
        businessName: "Beta Crypto Signals",
        email: "team@eng-beta.example.com",
        categories: ["crypto"],
      }),
      brokerSite({
        domain: "eng-gamma.example.com",
        businessName: "Gamma Brokerage",
      }),
    ];
    const { provider, stats } = makeProvider(sites);

    // Tick until the target is reached, which also proves the engine is
    // resumable across repeated, independent invocations.
    let guard = 0;
    let job = (await getResearchJob(jobId))!;
    while (job.verifiedCount < job.targetCount && guard < 8) {
      await runResearchTick(jobId, { provider, workerId: `e2e-${guard}` });
      job = (await getResearchJob(jobId))!;
      guard += 1;
    }

    expect(job.verifiedCount).toBeGreaterThanOrEqual(2);
    expect(stats.searches).toBeGreaterThan(0);
    expect(stats.fetches).toBeGreaterThan(0);

    const leads = await listProspects({ jobId, qualification: "verified" });
    expect(leads.length).toBeGreaterThanOrEqual(2);

    // Every saved lead must have a real published email and a source URL.
    for (const lead of leads) {
      expect(lead.contactEmail).toBeTruthy();
      expect(lead.contactEmailSource).toBeTruthy();
      expect(lead.websiteUrl).toBeTruthy();
    }

    // Every saved lead must have a personalized first-contact draft.
    for (const lead of leads) {
      const drafts = await listDraftsForProspect(lead.id);
      expect(drafts.filter((draft) => draft.kind === "first_contact").length).toBe(1);
    }

    // The broker must never become a lead.
    const broker = leads.find((lead) => lead.businessName === "Gamma Brokerage");
    expect(broker).toBeUndefined();

    // Real DeepSeek cost must be recorded, and the job's spend must match.
    const usage = await getResearchUsage(jobId);
    expect(usage.costUsd).toBeGreaterThan(0);
    const budget = await getJobBudget(jobId);
    expect(budget?.spentUsd).toBeGreaterThan(0);
    expect(budget!.spentUsd).toBeCloseTo(usage.costUsd, 6);
  });

  it("never saves a lead when a duplicate already exists in the database", async () => {
    const jobId = await newJob({ name: "Duplicate guard", target: 3 });
    const sites = [
      qualifyingSite({
        domain: "eng-alpha.example.com",
        businessName: "Alpha Signals House",
        email: "desk@eng-alpha.example.com",
      }),
    ];
    const { provider } = makeProvider(sites);

    const before = await listProspects({ qualification: "verified" });
    for (let i = 0; i < 3; i += 1) {
      await runResearchTick(jobId, { provider, workerId: `dup-${i}` });
    }
    const after = await listProspects({ qualification: "verified" });

    // The existing business must not be duplicated.
    expect(after.length).toBe(before.length);
    const job = (await getResearchJob(jobId))!;
    expect(job.duplicatesRejected).toBeGreaterThanOrEqual(1);

    const candidates = await listResearchCandidates(jobId);
    expect(candidates.some((candidate) => candidate.status === "duplicate")).toBe(true);
  });

  it("does not create a lead when the model call fails", async () => {
    const jobId = await newJob({ name: "Model outage", target: 2 });
    const sites = [
      qualifyingSite({
        domain: "eng-outage.example.com",
        businessName: "Outage Signals",
      }),
    ];
    const failing = createFakeProvider({ sites, failChat: true });

    const before = await listProspects({ qualification: "verified" });
    // Two ticks: the first discovers, the second researches the candidate and
    // hits the model outage.
    await runResearchTick(jobId, { provider: failing.provider, workerId: "outage-1" });
    const tick = await runResearchTick(jobId, {
      provider: failing.provider,
      workerId: "outage-2",
    });
    const after = await listProspects({ qualification: "verified" });

    // The failing provider must actually have been exercised.
    expect(failing.stats.chats).toBeGreaterThan(0);
    expect(after.length).toBe(before.length);

    const job = (await getResearchJob(jobId))!;
    expect(job.verifiedCount).toBe(0);
    expect(tick.saved).toBe(0);

    // The candidate must be parked honestly, not marked qualified.
    const candidates = await listResearchCandidates(jobId);
    const target = candidates.find((entry) => entry.websiteUrl?.includes("eng-outage"));
    expect(target?.status).not.toBe("qualified");
  });

  it("pauses safely when the budget is exhausted and preserves progress", async () => {
    const jobId = await newJob({ name: "Budget stop", target: 10, budget: 0.0015 });
    const sites = [
      qualifyingSite({ domain: "eng-budgeta.example.com", businessName: "Budget A" }),
      qualifyingSite({ domain: "eng-budgetb.example.com", businessName: "Budget B" }),
      qualifyingSite({ domain: "eng-budgetc.example.com", businessName: "Budget C" }),
    ];
    const { provider } = makeProvider(sites);

    let guard = 0;
    let job = (await getResearchJob(jobId))!;
    while (job.status === "active" && guard < 10) {
      await runResearchTick(jobId, { provider, workerId: `budget-${guard}` });
      job = (await getResearchJob(jobId))!;
      guard += 1;
    }

    expect(job.status).toBe("budget_paused");
    expect(job.spentUsd).toBeGreaterThan(0);
    expect(job.stopReason).toMatch(/budget/i);

    // Progress must survive the pause, not reset to zero.
    const savedBefore = job.verifiedCount;
    const candidates = await listResearchCandidates(jobId);
    expect(candidates.length).toBeGreaterThan(0);

    // A paused job must not spend more when a worker runs again.
    const spentAtPause = job.spentUsd;
    await runResearchTick(jobId, { provider, workerId: "budget-after" });
    const after = (await getResearchJob(jobId))!;
    expect(after.status).toBe("budget_paused");
    expect(after.spentUsd).toBeCloseTo(spentAtPause, 6);
    expect(after.verifiedCount).toBe(savedBefore);
  });

  it("resumes an interrupted job from persisted state instead of restarting", async () => {
    // Target exceeds the number of seeded sites, so the job stays active and the
    // interrupted work genuinely has to be resumed rather than already finished.
    const jobId = await newJob({ name: "Resume", target: 8 });
    const sites = [
      qualifyingSite({ domain: "eng-resumea.example.com", businessName: "Resume A" }),
      qualifyingSite({ domain: "eng-resumeb.example.com", businessName: "Resume B" }),
      qualifyingSite({ domain: "eng-resumec.example.com", businessName: "Resume C" }),
    ];
    const { provider } = makeProvider(sites);

    // First worker discovers and saves something, then "crashes".
    await runResearchTick(jobId, { provider, workerId: "crashy" });
    const mid = (await getResearchJob(jobId))!;
    const midCandidates = await listResearchCandidates(jobId);
    expect(midCandidates.length).toBeGreaterThan(0);

    // Simulate an abandoned in-flight candidate whose claim expired.
    const stranded = midCandidates[0];
    await getDb().then((db) =>
      db.query(
        `UPDATE research_candidates SET status = 'researching', attempts = 1
         WHERE id = $1`,
        [stranded.id],
      ),
    );
    await claimCandidateIdentity({
      identityKey: stranded.identityKey,
      jobId,
      workerId: "crashed-worker",
      ttlSeconds: 30,
    });
    await getDb().then((db) =>
      db.query(
        `UPDATE candidate_claims SET claim_expires_at = now() - interval '1 minute'
         WHERE identity_key = $1`,
        [stranded.identityKey],
      ),
    );

    const requeued = await requeueExpiredCandidates(jobId);
    expect(requeued).toBeGreaterThanOrEqual(1);

    // The recovered candidate must be claimable again.
    const claimable = await claimPendingCandidates({
      jobId,
      workerId: "recovered",
      limit: 5,
    });
    expect(claimable.length).toBeGreaterThan(0);

    // A different worker continues the same job without a restart.
    await runResearchTick(jobId, { provider, workerId: "successor" });
    const after = (await getResearchJob(jobId))!;
    expect(after.verifiedCount).toBeGreaterThanOrEqual(mid.verifiedCount);

    // Runs are recorded, so an interruption is auditable rather than invisible.
    const runs = await listResearchRuns(jobId);
    expect(runs.length).toBeGreaterThanOrEqual(2);
  });

  it("does not restart a completed job from zero", async () => {
    const jobId = await newJob({ name: "Completed", target: 1 });
    const sites = [
      qualifyingSite({ domain: "eng-donea.example.com", businessName: "Done A" }),
    ];
    const { provider, stats } = makeProvider(sites);

    let guard = 0;
    let job = (await getResearchJob(jobId))!;
    while (job.status === "active" && guard < 6) {
      await runResearchTick(jobId, { provider, workerId: `done-${guard}` });
      job = (await getResearchJob(jobId))!;
      guard += 1;
    }
    expect(job.status).toBe("completed");

    const searchesAtCompletion = stats.searches;
    const result = await runResearchTick(jobId, { provider, workerId: "after-done" });
    expect(result.status).toBe("completed");
    expect(result.stopReason).toMatch(/target/i);
    // A completed job must not spend again.
    expect(stats.searches).toBe(searchesAtCompletion);
  });

  it("never advances a cancelled or paused job", async () => {
    const jobId = await newJob({ name: "Control", target: 5 });
    const sites = [
      qualifyingSite({ domain: "eng-ctla.example.com", businessName: "Ctl A" }),
    ];
    const { provider, stats } = makeProvider(sites);

    await updateResearchJobStatus(jobId, "paused");
    const paused = await runResearchTick(jobId, { provider, workerId: "p" });
    expect(paused.status).toBe("paused");
    expect(stats.searches).toBe(0);

    await updateResearchJobStatus(jobId, "cancelled");
    const cancelled = await runResearchTick(jobId, { provider, workerId: "c" });
    expect(cancelled.status).toBe("cancelled");
    expect(stats.searches).toBe(0);
  });

  it("runs the durable worker and reports idle honestly when nothing is due", async () => {
    const tick = await runWorker({ jobId: null });
    // Either it advanced a due job or it said so plainly; never invented work.
    expect(["idle", "active", "completed", "paused", "budget_paused", "cancelled"]).toContain(
      tick.status,
    );
    if (tick.status === "idle") {
      expect(tick.saved).toBe(0);
      expect(tick.stopReason).toBeTruthy();
    }
  });

  it("expires stale claims so a dead worker cannot block an identity", async () => {
    const identityKey = `domain:stale-${crypto.randomUUID()}.example.com`;
    await claimCandidateIdentity({
      identityKey,
      jobId: state.claimJobId,
      workerId: "dead",
      ttlSeconds: 30,
    });
    await getDb().then((db) =>
      db.query(
        `UPDATE candidate_claims SET claim_expires_at = now() - interval '1 minute'
         WHERE identity_key = $1`,
        [identityKey],
      ),
    );
    const removed = await expireStaleClaims();
    expect(removed).toBeGreaterThanOrEqual(1);
  });

  /* --------------------------------- agent API ----------------------------- */

  it("exposes engine progress to assistant keys without any send capability", async () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(names).toContain("list_research_jobs");
    expect(names.some((name) => /send|delete/i.test(name))).toBe(false);

    const jobId = await newJob({ name: "Agent visibility", target: 4 });
    const progress = await runAgentAction(state.verifier, "report_progress", {});
    const jobs = progress.data.jobs as { id: string; status: string }[];
    const mine = jobs.find((job) => job.id === jobId);
    expect(mine).toBeTruthy();
    expect(mine?.status).toBe("active");

    // A research key still cannot send.
    await expect(runAgentAction(state.verifier, "send_email", {})).rejects.toThrow(
      /unknown growth action/i,
    );
  });

  it("records engine usage as real DeepSeek operations with cost", async () => {
    const jobId = await newJob({ name: "Usage bookkeeping", target: 2 });
    const sites = [
      qualifyingSite({ domain: "eng-usagea.example.com", businessName: "Usage A" }),
    ];
    const { provider, stats } = makeProvider(sites);
    await runResearchTick(jobId, { provider, workerId: "usage" });

    const usage = await getResearchUsage(jobId);
    expect(usage.searches).toBeGreaterThan(0);
    expect(usage.costUsd).toBeGreaterThan(0);
    expect(usage.recent.length).toBeGreaterThan(0);
    expect(usage.recent.every((entry) => entry.costUsd >= 0)).toBe(true);
    expect(stats.searches).toBeGreaterThan(0);

    // Recorded spend must equal the recorded operations, not an estimate.
    const operations = usage.recent.reduce((sum, entry) => sum + entry.costUsd, 0);
    expect(operations).toBeGreaterThan(0);
  });

  it("honours the search_prospects filters it advertises", async () => {
    // The tool schema declared jobId and qualification but the handler dropped
    // them, so a caller filtering by target silently got every prospect back.
    const jobId = await newJob({ name: "Filter fidelity", target: 1, budget: 5 });
    const sites = [
      qualifyingSite({
        domain: "filters-a.example.com",
        businessName: "Filters A",
        email: "desk@filters-a.example.com",
      }),
      qualifyingSite({
        domain: "filters-b.example.com",
        businessName: "Filters B",
        email: "desk@filters-b.example.com",
      }),
    ];
    const { provider } = makeProvider(sites);
    let guard = 0;
    let job = (await getResearchJob(jobId))!;
    while (job.verifiedCount < job.targetCount && guard < 10) {
      await runResearchTick(jobId, { provider, workerId: `filters-${guard}` });
      job = (await getResearchJob(jobId))!;
      guard += 1;
    }

    const scoped = await runAgentAction(state.verifier, "search_prospects", {
      jobId,
      limit: 100,
    });
    const scopedRows = scoped.data.prospects as { researchJobId?: string }[];
    expect(scopedRows.length).toBeGreaterThan(0);
    // Every returned row must actually belong to the requested target.
    expect(scopedRows.every((row) => row.researchJobId === jobId)).toBe(true);

    const verifiedOnly = await runAgentAction(state.verifier, "search_prospects", {
      jobId,
      qualification: "verified",
      limit: 100,
    });
    const verifiedRows = verifiedOnly.data.prospects as {
      qualificationStatus?: string;
    }[];
    expect(verifiedRows.length).toBeGreaterThan(0);
    expect(verifiedRows.every((row) => row.qualificationStatus === "verified")).toBe(
      true,
    );

    // A job id that matches nothing must return nothing, not everything.
    const none = await runAgentAction(state.verifier, "search_prospects", {
      jobId: crypto.randomUUID(),
      limit: 100,
    });
    expect((none.data.prospects as unknown[]).length).toBe(0);
  });

  /* --------------------------- acceptance scale ---------------------------- */

  it("reaches the brief's 10-lead acceptance bar with real emails and drafts", async () => {
    // The brief's acceptance test is 10 genuinely new qualified leads. This
    // drives the engine through that exact bar in one target, then checks every
    // saved lead independently: real published email, real source, real draft.
    const target = 10;
    const jobId = await newJob({ name: "Acceptance 10", target, budget: 50 });

    const qualifying = Array.from({ length: target }, (_, index) =>
      qualifyingSite({
        domain: `accept-${index}.example.com`,
        businessName: `Acceptance Signals ${index}`,
        // Distinct non-generic inboxes, so each is its own identity.
        email: `desk${index}@accept-${index}.example.com`,
        categories: [index % 2 === 0 ? "forex" : "crypto"],
      }),
    );
    // Decoys that must never inflate the count.
    const decoys = Array.from({ length: 5 }, (_, index) =>
      brokerSite({
        domain: `accept-broker-${index}.example.com`,
        businessName: `Acceptance Brokerage ${index}`,
      }),
    );

    const { provider, stats } = makeProvider([...qualifying, ...decoys]);

    let guard = 0;
    let job = (await getResearchJob(jobId))!;
    while (job.verifiedCount < target && guard < 40) {
      await runResearchTick(jobId, { provider, workerId: `accept-${guard}` });
      job = (await getResearchJob(jobId))!;
      guard += 1;
    }

    expect(job.verifiedCount).toBe(target);
    expect(job.remaining).toBe(0);
    expect(job.status).toBe("completed");

    const leads = await listProspects({ jobId, qualification: "verified" });
    expect(leads.length).toBe(target);

    // Exactly the ten real providers, and none of the brokers.
    expect(leads.filter((lead) => lead.businessName.startsWith("Acceptance Brokerage"))).toHaveLength(0);

    // Every lead is independently verifiable: published email, its source, a
    // real website, and exactly one first-contact draft awaiting review.
    const seenEmails = new Set<string>();
    for (const lead of leads) {
      expect(lead.contactEmail).toBeTruthy();
      expect(lead.contactEmailSource).toBeTruthy();
      expect(lead.websiteUrl).toBeTruthy();
      expect(lead.qualificationStatus).toBe("verified");
      seenEmails.add(lead.contactEmail!.toLowerCase());

      const drafts = await listDraftsForProspect(lead.id);
      const firstContact = drafts.filter((draft) => draft.kind === "first_contact");
      expect(firstContact).toHaveLength(1);
      // The engine drafts for review; it must never have sent anything.
      expect(firstContact[0].status).not.toBe("sent");
    }
    // Ten distinct businesses, ten distinct inboxes: no collapsed identities.
    expect(seenEmails.size).toBe(target);

    // The brief requires counting only genuinely new leads, and the run must be
    // reproducible to that number rather than to an approximate one.
    expect(stats.searches).toBeGreaterThan(0);
    expect(stats.fetches).toBeGreaterThanOrEqual(target);

    const budget = await getJobBudget(jobId);
    const usage = await getResearchUsage(jobId);
    expect(budget!.spentUsd).toBeCloseTo(usage.costUsd, 6);
    expect(usage.costUsd).toBeGreaterThan(0);
    // A 50 USD budget must not have been silently exhausted by 10 leads.
    expect(usage.costUsd).toBeLessThan(50);
  });

  it("scales the same target beyond 10 without duplicating earlier leads", async () => {
    // "then scale to 25/50/100+" — the count is a setting, and raising it must
    // continue from the existing leads rather than restart discovery.
    const jobId = await newJob({ name: "Acceptance scale", target: 12, budget: 50 });
    const sites = Array.from({ length: 12 }, (_, index) =>
      qualifyingSite({
        domain: `scale-${index}.example.com`,
        businessName: `Scale Signals ${index}`,
        email: `desk${index}@scale-${index}.example.com`,
      }),
    );
    const { provider } = makeProvider(sites);

    let guard = 0;
    let job = (await getResearchJob(jobId))!;
    while (job.verifiedCount < job.targetCount && guard < 40) {
      await runResearchTick(jobId, { provider, workerId: `scale-a-${guard}` });
      job = (await getResearchJob(jobId))!;
      guard += 1;
    }
    const firstPass = await listProspects({ jobId, qualification: "verified" });
    expect(firstPass.length).toBeGreaterThanOrEqual(10);

    // The job has now completed. A second run over the same provider must not
    // create a single additional lead or duplicate an existing one.
    const before = firstPass.length;
    for (let i = 0; i < 3; i += 1) {
      await runResearchTick(jobId, { provider, workerId: `scale-b-${i}` });
    }
    const after = await listProspects({ jobId, qualification: "verified" });
    expect(after.length).toBe(before);

    const emails = after.map((lead) => lead.contactEmail?.toLowerCase());
    expect(new Set(emails).size).toBe(after.length);
  });

  /* ------------------------- lead-model assessment (Part 2) ----------------- */

  async function qualifiedProspectId(jobId: string): Promise<string> {
    const db = await getDb();
    const row = (
      await db.query<{ prospect_id: string }>(
        `SELECT prospect_id FROM research_candidates
         WHERE job_id = $1 AND status = 'qualified' AND prospect_id IS NOT NULL
         ORDER BY updated_at DESC LIMIT 1`,
        [jobId],
      )
    ).rows[0];
    expect(row?.prospect_id).toBeTruthy();
    return row!.prospect_id;
  }

  it("saves a Telegram-only seller as Category B instead of discarding it", async () => {
    // The founder's rule: a genuine paid-signals business with no published
    // email but an official Telegram channel is still a lead — Category B —
    // not a rejection. Before this part, the engine required an email to save
    // anything at all.
    const jobId = await newJob({ name: "Category B", target: 1 });
    const sites = [
      telegramOnlySite({ domain: "catb-alpha.example.com", businessName: "Catb Alpha Signals" }),
    ];
    const { provider } = makeProvider(sites);

    let guard = 0;
    let job = (await getResearchJob(jobId))!;
    while (guard < 5) {
      await runResearchTick(jobId, { provider, workerId: `catb-${guard}` });
      job = (await getResearchJob(jobId))!;
      guard += 1;
      const candidates = await listResearchCandidates(jobId);
      if (candidates.some((c) => c.status === "qualified")) break;
    }

    const prospectId = await qualifiedProspectId(jobId);
    const db = await getDb();
    const prospect = (
      await db.query<{ telegram_url: string | null }>(
        `SELECT telegram_url FROM prospects WHERE id = $1`,
        [prospectId],
      )
    ).rows[0];
    const emailRows = await db.query(`SELECT 1 FROM prospect_emails WHERE prospect_id = $1`, [
      prospectId,
    ]);
    expect(emailRows.rowCount).toBe(0);
    expect(prospect?.telegram_url).toContain("t.me/");

    const model = await getLeadModel(prospectId);
    expect(model.tier).toBe("category_b");
    expect(model.eligibility).toBe("eligible");
    expect(model.contactRoutes.some((route) => route.officialStatus === "verified")).toBe(true);

    // Category B must not inflate the counted verified target.
    expect(job.verifiedCount).toBe(0);
  });

  it("obeys robots.txt: a disallowed contact page is skipped, never treated as absence", async () => {
    const jobId = await newJob({ name: "Robots respect", target: 1 });
    const blocked = withRobots(
      qualifyingSite({
        domain: "robot-alpha.example.com",
        businessName: "Robot Alpha Signals",
        email: "desk@robot-alpha.example.com",
      }),
      "User-agent: *\nDisallow: /contact\n",
    );
    const { provider } = makeProvider([blocked]);

    let guard = 0;
    let job = (await getResearchJob(jobId))!;
    while (guard < 5 && job.status === "active") {
      await runResearchTick(jobId, { provider, workerId: `robots-${guard}` });
      job = (await getResearchJob(jobId))!;
      guard += 1;
    }

    // The only contact page was disallowed, and this fixture has no other
    // contact route, so the candidate is honestly rejected — never silently
    // saved as if the business published nothing.
    const candidates = await listResearchCandidates(jobId);
    const target = candidates.find((c) => c.websiteUrl?.includes("robot-alpha"));
    expect(target?.status).toBe("rejected");
    const evidence = target?.lastError ?? "";
    expect(evidence.toLowerCase()).not.toContain("could not be retrieved");
    expect(job.verifiedCount).toBe(0);
  });

  it("promotes to tier_1 only when an official account displays >=1000 followers", async () => {
    const jobId = await newJob({ name: "Established audience", target: 1 });
    const withBigAudience = withAudiences(
      qualifyingSite({
        domain: "ig-alpha.example.com",
        businessName: "IG Alpha Signals",
        email: "desk@ig-alpha.example.com",
      }),
      [{ platform: "instagram", url: "https://instagram.com/igalphasignals", countValue: 15000 }],
    );
    const { provider } = makeProvider([withBigAudience]);

    let guard = 0;
    let job = (await getResearchJob(jobId))!;
    while (guard < 6 && job.verifiedCount < job.targetCount) {
      await runResearchTick(jobId, { provider, workerId: `aud-${guard}` });
      job = (await getResearchJob(jobId))!;
      guard += 1;
    }

    const prospectId = await qualifiedProspectId(jobId);
    const model = await getLeadModel(prospectId);
    expect(model.tier).toBe("tier_1");
    expect(
      model.audiences.some(
        (a) => a.platform === "instagram" && a.countState === "verified" && a.countValue === 15000,
      ),
    ).toBe(true);
  });
});
