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
  recordResearchEvent,
  updateResearchJobStatus,
} from "@/lib/services/research";
import { runResearchTick } from "@/lib/services/research-engine";
import { getResearchActivity } from "@/lib/services/research-activity";
import {
  claimJobLease,
  getJobBudget,
  releaseJobLease,
} from "@/lib/services/research-runs";
import { listProspects } from "@/lib/services/prospects";
import { brokerSite, createFakeProvider, qualifyingSite } from "./fake-provider";

/**
 * The live activity transcript.
 *
 * A founder watching a running job must be able to see what it is doing. These
 * tests pin two things: that the transcript reflects only real recorded rows, and
 * that the job lease prevents two tabs from double-spending — while never
 * replacing a job's genuine status with an invented "busy".
 */

const state = { userId: "" };

async function newJob(input: {
  name: string;
  target: number;
  budget?: number;
}): Promise<string> {
  const job = await createResearchJob({
    name: input.name,
    targetCount: input.target,
    categories: ["forex", "metals"],
    regions: "Worldwide",
    requirements: "Only paid trading-signal providers with a published business email.",
    engine: "deepseek",
    budgetUsd: input.budget ?? 5,
    concurrency: 3,
    userId: state.userId,
  });
  await updateResearchJobStatus(job.id, "active");
  return job.id;
}

describe("live research activity", () => {
  beforeAll(async () => {
    const db = await getDb();
    await ensureWorkspaceDefaults();
    state.userId = crypto.randomUUID();
    await db.query(
      `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, 'founder')`,
      [
        state.userId,
        "activity@test.nomeriq.com",
        "activity@test.nomeriq.com",
        "Activity Founder",
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
  });

  afterAll(async () => {
    await closeDb();
    const dir = process.env.PGLITE_DIR || "";
    if (dir.startsWith(".data/test-vitest-")) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("invents no activity for a job that has done no work", async () => {
    const jobId = await newJob({ name: "Silent job", target: 5 });
    const items = await getResearchActivity(jobId);
    // Activating the job legitimately records a resume event, and that is all:
    // no search, fetch, verdict or lead may be fabricated to look busy. This is
    // the honest counterpart to the founder's complaint that a job looked silent.
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.kind === "job")).toBe(true);
    expect(items.some((item) => item.kind === "search")).toBe(false);
    expect(items.some((item) => item.kind === "fetch")).toBe(false);
    expect(items.some((item) => item.kind === "lead")).toBe(false);
  });

  it("shows real discovery, page reads, verdicts and the saved lead", async () => {
    // A target of 3 with only two qualifying sites forces the broker to be
    // examined too, which is what makes the rejection visible in the transcript.
    const jobId = await newJob({ name: "Activity transcript", target: 3 });
    const { provider } = createFakeProvider({
      sites: [
        qualifyingSite({
          domain: "act-alpha.example.com",
          businessName: "Alpha Gold Signals",
          email: "desk@act-alpha.example.com",
          categories: ["metals"],
        }),
        qualifyingSite({
          domain: "act-beta.example.com",
          businessName: "Beta Forex VIP",
          email: "hello@act-beta.example.com",
          categories: ["forex"],
        }),
        brokerSite({
          domain: "act-broker.example.com",
          businessName: "Broker Decoy",
        }),
      ],
    });

    let job = (await getResearchJob(jobId))!;
    let guard = 0;
    while (job.verifiedCount < job.targetCount && guard < 6) {
      await runResearchTick(jobId, { provider, workerId: `activity-${guard}` });
      job = (await getResearchJob(jobId))!;
      guard += 1;
    }

    const items = await getResearchActivity(jobId, 200);
    const kinds = new Set(items.map((item) => item.kind));

    // A search must be visible, and so must the pages actually read.
    expect(kinds.has("search")).toBe(true);
    expect(kinds.has("fetch")).toBe(true);
    // The saved lead and its draft must both appear.
    expect(kinds.has("lead")).toBe(true);
    expect(kinds.has("draft")).toBe(true);

    const searches = items.filter((item) => item.kind === "search");
    // Real recorded cost is attached to the search lines, not invented.
    expect(searches.some((item) => (item.costUsd ?? 0) > 0)).toBe(true);

    const lead = items.find((item) => item.kind === "lead");
    expect(lead?.title).toMatch(/Alpha Gold Signals|Beta Forex VIP/);

    // The broker must be explained, not silently dropped.
    const rejected = items.filter(
      (item) => item.kind === "rejected" || item.kind === "duplicate",
    );
    expect(rejected.length).toBeGreaterThan(0);

    // Every line must carry a real timestamp and a non-empty title.
    for (const item of items) {
      expect(item.at).toBeTruthy();
      expect(item.title.trim().length).toBeGreaterThan(0);
    }

    // Newest first, so the founder reads the latest step at the top of the data.
    const times = items.map((item) => item.at);
    const sorted = [...times].sort().reverse();
    expect(times).toEqual(sorted);

    // The transcript and the database must agree on the outcome.
    const leads = await listProspects({ jobId, qualification: "verified" });
    expect(leads.length).toBe(job.verifiedCount);
  });

  it("explains an unreadable site instead of failing silently", async () => {
    const jobId = await newJob({ name: "Unreadable site", target: 1 });
    const { provider } = createFakeProvider({
      sites: [
        qualifyingSite({
          domain: "act-dead.example.com",
          businessName: "Dead Site Signals",
          email: "hi@act-dead.example.com",
        }),
      ],
      // The Fetch capability is broken upstream, which is exactly the situation
      // the founder hit: the scraper raises an error, so no page is read and
      // nothing can be verified. It must surface, not vanish.
      throwOnFetch: true,
    });

    await runResearchTick(jobId, { provider, workerId: "dead-site" });

    const items = await getResearchActivity(jobId, 200);
    // The failure must be visible in the transcript with its real message.
    const failure = items.find((item) => item.tone === "bad" || item.kind === "failed");
    expect(failure).toBeTruthy();
    // The upstream provider's own words must reach the founder, not a bare
    // "Not found" that hides what actually went wrong.
    expect(`${failure?.title} ${failure?.detail}`).toMatch(/Firecrawl/);

    // And it must not have been counted as a lead.
    const job = (await getResearchJob(jobId))!;
    expect(job.verifiedCount).toBe(0);
  });

  it("reports a paused job's real status rather than claiming it is busy", async () => {
    const jobId = await newJob({ name: "Paused honesty", target: 3 });
    await updateResearchJobStatus(jobId, "paused");

    const { provider } = createFakeProvider({ sites: [] });
    const tick = await runResearchTick(jobId, { provider, workerId: "paused-check" });

    // A paused job must say it is paused. Reporting "another worker is advancing
    // this job" would be a fabricated concurrency conflict.
    expect(tick.status).not.toBe("busy");
    expect(tick.stopReason).toMatch(/not active/i);
    expect(tick.spentUsd).toBe(0);
  });

  it("stops a second worker from advancing the same job at once", async () => {
    const jobId = await newJob({ name: "Lease guard", target: 3 });

    const first = await claimJobLease({ jobId, workerId: "tab-a" });
    expect(first.claimed).toBe(true);

    // A different worker must be refused while the lease is live, which is what
    // stops two open tabs from each spending the founder's budget.
    const second = await claimJobLease({ jobId, workerId: "tab-b" });
    expect(second.claimed).toBe(false);
    expect(second.holder).toBe("tab-a");

    // The same worker may refresh its own lease.
    const renew = await claimJobLease({ jobId, workerId: "tab-a" });
    expect(renew.claimed).toBe(true);

    await releaseJobLease({ jobId, workerId: "tab-a" });

    // Once released, another worker can take over immediately.
    const third = await claimJobLease({ jobId, workerId: "tab-c" });
    expect(third.claimed).toBe(true);
    await releaseJobLease({ jobId, workerId: "tab-c" });
  });

  it("does not leak a lease when a tick returns with nothing to do", async () => {
    const jobId = await newJob({ name: "Lease release", target: 2 });
    const { provider } = createFakeProvider({ sites: [] });

    await runResearchTick(jobId, { provider, workerId: "releaser" });

    // The lease must have been handed back, or one tick would block the job for
    // the whole TTL and look like a hang.
    const after = await getDb().then((db) =>
      db.query<{ worker_id: string | null; worker_claim_expires_at: string | null }>(
        `SELECT worker_id, worker_claim_expires_at FROM research_jobs WHERE id = $1`,
        [jobId],
      ),
    );
    expect(after.rows[0]?.worker_id).toBeNull();
    expect(after.rows[0]?.worker_claim_expires_at).toBeNull();
  });

  it("advances the recorded tick counter so progress survives restarts", async () => {
    const jobId = await newJob({ name: "Tick counter", target: 2 });
    const before = (await getResearchJob(jobId))!;
    const { provider } = createFakeProvider({ sites: [] });

    await runResearchTick(jobId, { provider, workerId: "counter" });

    const after = (await getResearchJob(jobId))!;
    expect(after.ticks).toBe(before.ticks + 1);
  });

  it("keeps the transcript bounded and ordered regardless of volume", async () => {
    const jobId = await newJob({ name: "Large transcript", target: 2 });
    // Write far more events than the requested limit.
    for (let index = 0; index < 40; index += 1) {
      await recordResearchEvent(jobId, "note", {
        detail: { step: `step-${index}` },
        actorType: "deepseek",
      });
    }
    const items = await getResearchActivity(jobId, 10);
    expect(items.length).toBeLessThanOrEqual(10);
    const times = items.map((item) => item.at);
    expect(times).toEqual([...times].sort().reverse());
  });

  it("shows each operation once, not once per source table", async () => {
    const jobId = await newJob({ name: "No double lines", target: 1 });
    const { provider } = createFakeProvider({
      sites: [
        qualifyingSite({
          domain: "act-once.example.com",
          businessName: "Once Signals",
          email: "hi@act-once.example.com",
        }),
      ],
    });
    await runResearchTick(jobId, { provider, workerId: "once" });

    const items = await getResearchActivity(jobId, 200);
    const searchLines = items.filter(
      (item) => item.kind === "search" && item.title.startsWith("Searched"),
    );
    const queries = searchLines.map((item) => item.title);
    // A single search writes a research_events row and a research_usage row for
    // the same request. Rendering both would show every query twice.
    expect(new Set(queries).size).toBe(queries.length);

    // The cost must still be visible, merged onto the surviving line.
    expect(searchLines.some((item) => (item.costUsd ?? 0) > 0)).toBe(true);
  });

  it("records real spend per line without inventing cost", async () => {
    const jobId = await newJob({ name: "Costed transcript", target: 1 });
    const { provider } = createFakeProvider({
      sites: [
        qualifyingSite({
          domain: "act-cost.example.com",
          businessName: "Costed Signals",
          email: "billing@act-cost.example.com",
        }),
      ],
    });
    await runResearchTick(jobId, { provider, workerId: "costed" });

    const items = await getResearchActivity(jobId, 200);
    const withCost = items.filter((item) => (item.costUsd ?? 0) > 0);
    expect(withCost.length).toBeGreaterThan(0);

    // The sum of the itemized transcript lines must equal the job's recorded
    // spend, so the log can never disagree with the budget gate.
    const summed = withCost.reduce((sum, item) => sum + (item.costUsd ?? 0), 0);
    const budget = await getJobBudget(jobId);
    expect(summed).toBeCloseTo(budget!.spentUsd, 6);
  });
});
