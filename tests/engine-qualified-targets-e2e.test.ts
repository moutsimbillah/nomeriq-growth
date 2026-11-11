import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { ensureBootstrapUser } from "@/lib/auth/session";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import {
  createResearchJob,
  getResearchJob,
  refreshResearchJobStatus,
  updateResearchJobStatus,
} from "@/lib/services/research";
import { saveProspect } from "@/lib/services/prospects";
import { getLeadModel } from "@/lib/services/lead-model";
import { runResearchTick } from "@/lib/services/research-engine";
import type { ResearchProvider } from "@/lib/deepseek/research-provider";
import { createFakeProvider, qualifyingSite, telegramOnlySite } from "./fake-provider";
import { assessmentFor } from "./helpers/lead-assessment";

/**
 * Synthetic end-to-end proof of the counting rule through the REAL engine, save and count services.
 *
 * Search, Fetch and the model are stubbed by `tests/fake-provider.ts`, so no provider is called and
 * no network is touched; the database is the isolated per-run PGlite instance. Nothing here starts a
 * live job or spends money.
 *
 * What it proves: a fully evidenced Tier 1/Other lead found by the engine increments target progress;
 * Category B and email-no-website records are saved but never counted; a re-discovered duplicate and
 * a retried tick cannot double-count; and only an active job completes, at the qualified target.
 */

const state = { founderId: "" };

async function newJob(target: number): Promise<string> {
  const job = await createResearchJob({
    name: `Synthetic qualified-target ${crypto.randomUUID()}`,
    targetCount: target,
    categories: ["forex"],
    regions: "Worldwide",
    engine: "deepseek",
    budgetUsd: 5,
    concurrency: 1,
    userId: state.founderId,
  });
  await updateResearchJobStatus(job.id, "active");
  return job.id;
}

/** A provider that must never be reached: every call fails the test loudly. */
function forbiddenProvider(): ResearchProvider {
  const fail = () => { throw new Error("No provider call was expected in this step."); };
  return { model: "forbidden", recordsUsage: false, search: fail, fetch: fail, chatJson: fail };
}

async function tickUntil(
  jobId: string,
  provider: ResearchProvider,
  done: () => Promise<boolean>,
  maxTicks = 12,
): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (await done()) return;
    await runResearchTick(jobId, { provider, workerId: `synthetic-${i}` });
  }
  if (!(await done())) throw new Error("The synthetic engine did not reach the expected state.");
}

async function prospectsIn(jobId: string): Promise<{ id: string; business_name: string }[]> {
  const db = await getDb();
  return (await db.query<{ id: string; business_name: string }>(
    "SELECT id, business_name FROM prospects WHERE research_job_id=$1 ORDER BY created_at",
    [jobId],
  )).rows;
}

async function completedEvents(jobId: string): Promise<number> {
  const db = await getDb();
  return Number((await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM research_events WHERE job_id=$1 AND event_type='job_completed'",
    [jobId],
  )).rows[0].n);
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  state.founderId = (await ensureBootstrapUser({
    email: `synthetic-engine-${crypto.randomUUID()}@example.test`,
    name: "Synthetic engine founder",
    password: crypto.randomUUID(),
  })).id;
});

beforeEach(() => {
  // Belt and braces: the engine never receives a real provider here, and any stray fetch fails.
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("The synthetic engine must not touch the network."); }));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

describe("synthetic engine → save → count → completion", () => {
  it("a fully evidenced Tier 1/Other lead from the engine increments progress and completes an active job", async () => {
    const jobId = await newJob(1);
    const { provider, stats } = createFakeProvider({
      sites: [qualifyingSite({ domain: "synth-counted.example.com", businessName: "Synth Counted Signals" })],
    });

    await tickUntil(jobId, provider, async () => (await getResearchJob(jobId))!.verifiedCount >= 1);

    const job = (await getResearchJob(jobId))!;
    expect(job).toMatchObject({ status: "completed", verifiedCount: 1, remaining: 0, stopReason: "Target reached." });
    // It really went through Search → Fetch → model → save.
    expect(stats.searches).toBeGreaterThan(0);
    expect(stats.fetches).toBeGreaterThan(0);
    expect(stats.chats).toBeGreaterThan(0);

    const saved = await prospectsIn(jobId);
    expect(saved).toHaveLength(1);
    const model = await getLeadModel(saved[0].id);
    expect(model).toMatchObject({ eligibility: "eligible", tier: "other" });
    expect(await completedEvents(jobId)).toBe(1);
  });

  it("Category B and email-without-website records are saved but never increment the target", async () => {
    const jobId = await newJob(2);
    const { provider } = createFakeProvider({
      sites: [telegramOnlySite({ domain: "synth-catb.example.com", businessName: "Synth Catb Signals" })],
    });

    // Category B, discovered and saved by the engine itself.
    await tickUntil(jobId, provider, async () => (await prospectsIn(jobId)).some((p) => p.business_name === "Synth Catb Signals"));

    // Email-no-website, saved through the same shared save service with a real assessment.
    const key = `cb${crypto.randomUUID().replaceAll("-", "")}`;
    const profile = `https://instagram.com/${key}`;
    const savedNoWebsite = await saveProspect({
      businessName: `Synth Email No Website ${key}`,
      websiteUrl: null,
      instagramUrl: profile,
      categories: ["forex"],
      email: `owner@${key}.example.test`,
      emailSourceUrl: profile,
      emailSourceType: "official_social",
      signalDescription: "Sells paid forex signals through an official Instagram profile.",
      sources: [{ url: `${profile}/signals`, label: "Official profile signals" }],
      researchJobId: jobId,
      actorType: "api",
      leadAssessment: assessmentFor(profile),
    });
    expect(savedNoWebsite.prospect.qualificationStatus).toBe("verified"); // stored, but not counted
    expect(savedNoWebsite.leadModel?.tier).toBe("email_no_website");

    const job = (await getResearchJob(jobId))!;
    expect(job.verifiedCount).toBe(0); // neither record counts toward the target
    expect(job.status).toBe("active"); // so the job must keep working
    expect(job.emailCount).toBe(1); // the raw stored-email total is separate and does see one
    expect(await completedEvents(jobId)).toBe(0);
    const models = await Promise.all((await prospectsIn(jobId)).map((p) => getLeadModel(p.id)));
    expect(models.some((m) => m.tier === "category_b")).toBe(true);
    expect(models.some((m) => m.tier === "email_no_website")).toBe(true);
  });

  it("a re-discovered duplicate and a direct duplicate save cannot increment twice", async () => {
    const jobId = await newJob(5);
    const site = qualifyingSite({ domain: "synth-dupe.example.com", businessName: "Synth Dupe Signals" });
    const { provider } = createFakeProvider({ sites: [site] });

    await tickUntil(jobId, provider, async () => (await getResearchJob(jobId))!.verifiedCount >= 1);
    expect((await getResearchJob(jobId))!.verifiedCount).toBe(1);

    // The engine re-discovers the same business on later ticks. Its queue dedupes a candidate it has
    // already resolved, so this alone does not reach the save path — the direct save below does.
    for (let i = 0; i < 2; i += 1) await runResearchTick(jobId, { provider, workerId: `dupe-${i}` });
    expect((await getResearchJob(jobId))!.verifiedCount).toBe(1);
    expect(await prospectsIn(jobId)).toHaveLength(1);

    // And a direct duplicate save of the same identity is still a duplicate, through the real gate.
    const again = await saveProspect({
      businessName: "Synth Dupe Signals",
      websiteUrl: "https://synth-dupe.example.com",
      categories: ["forex"],
      email: "hello@synth-dupe.example.com",
      emailSourceUrl: "https://synth-dupe.example.com/contact",
      signalDescription: "Same business saved a second time.",
      sources: [{ url: "https://synth-dupe.example.com/pricing", label: "Pricing" }],
      researchJobId: jobId,
      actorType: "api",
    });
    expect(again).toMatchObject({ created: false, duplicate: true });
    expect((await getResearchJob(jobId))!.verifiedCount).toBe(1);
    expect(await prospectsIn(jobId)).toHaveLength(1);
  });

  it("an interrupted-and-retried run dedupes at the engine gate and cannot double-count", async () => {
    const jobId = await newJob(5);
    const { provider } = createFakeProvider({
      sites: [qualifyingSite({ domain: "synth-retry.example.com", businessName: "Synth Retry Signals" })],
    });

    await tickUntil(jobId, provider, async () => (await getResearchJob(jobId))!.verifiedCount >= 1);
    const before = (await getResearchJob(jobId))!;
    expect(before.verifiedCount).toBe(1);

    // Model a worker that died and whose candidate was requeued (claims expire in production), so the
    // same work is attempted again.
    const db = await getDb();
    const requeue = () => db.query(
      "UPDATE research_candidates SET status='pending', claim_id=NULL, attempts=0 WHERE job_id=$1",
      [jobId],
    );
    await requeue();
    await runResearchTick(jobId, { provider, workerId: "synthetic-retry" });
    await requeue();
    await runResearchTick(jobId, { provider, workerId: "synthetic-retry" });

    // The retry did real work at the engine's live duplicate gate (not a no-op), and that gate is what
    // stops the second attempt before any fetch, model call or save.
    const candidateStates = (await db.query<{ status: string }>(
      "SELECT status FROM research_candidates WHERE job_id=$1",
      [jobId],
    )).rows.map((row) => row.status);
    expect(candidateStates).toContain("duplicate");
    const after = (await getResearchJob(jobId))!;
    expect(after.duplicatesRejected).toBeGreaterThan(before.duplicatesRejected);
    expect(after.verifiedCount).toBe(before.verifiedCount); // 1, not 2 or 3
    expect(await prospectsIn(jobId)).toHaveLength(1);
    expect(after.draftCount).toBeLessThanOrEqual(1); // no duplicate first-contact drafts either

    // Defence in depth: even a re-issued identical save (the race path the engine also relies on) is a
    // duplicate and cannot move the count.
    const reissued = await saveProspect({
      businessName: "Synth Retry Signals",
      websiteUrl: "https://synth-retry.example.com",
      categories: ["forex"],
      email: "hello@synth-retry.example.com",
      emailSourceUrl: "https://synth-retry.example.com/contact",
      signalDescription: "Sells monthly trading-signal subscriptions with entry, stop and target levels.",
      sources: [{ url: "https://synth-retry.example.com/pricing", label: "Pricing" }],
      researchJobId: jobId,
      actorType: "api",
    });
    expect(reissued).toMatchObject({ created: false, duplicate: true });
    expect((await getResearchJob(jobId))!.verifiedCount).toBe(1);
    expect(await prospectsIn(jobId)).toHaveLength(1);
  });

  it("only an active job completes, and only at the qualified target", async () => {
    const jobId = await newJob(1);
    expect((await getResearchJob(jobId))!.status).toBe("active");

    // A counted lead exists while the job is still active: an explicit status refresh may complete it.
    const key = `act${crypto.randomUUID().replaceAll("-", "")}`;
    await saveProspect({
      businessName: `Synth Active Gate ${key}`,
      websiteUrl: `https://${key}.example.test`,
      categories: ["forex"],
      email: `owner@${key}.example.test`,
      emailSourceUrl: `https://${key}.example.test/contact`,
      signalDescription: "Sells paid forex signals with published pricing.",
      sources: [{ url: `https://${key}.example.test/signals`, label: "Signals" }],
      researchJobId: jobId,
      actorType: "api",
      leadAssessment: assessmentFor(`https://${key}.example.test`),
    });
    const completed = (await getResearchJob(jobId))!;
    expect(completed).toMatchObject({ status: "completed", verifiedCount: 1, remaining: 0 });

    // A paused job with a counted lead keeps its status; the completion check must not reopen it.
    const pausedJobId = await newJob(1);
    await updateResearchJobStatus(pausedJobId, "paused");
    const pausedKey = `pause${crypto.randomUUID().replaceAll("-", "")}`;
    await saveProspect({
      businessName: `Synth Paused Gate ${pausedKey}`,
      websiteUrl: `https://${pausedKey}.example.test`,
      categories: ["forex"],
      email: `owner@${pausedKey}.example.test`,
      emailSourceUrl: `https://${pausedKey}.example.test/contact`,
      signalDescription: "Sells paid forex signals with published pricing.",
      sources: [{ url: `https://${pausedKey}.example.test/signals`, label: "Signals" }],
      researchJobId: pausedJobId,
      actorType: "api",
      leadAssessment: assessmentFor(`https://${pausedKey}.example.test`),
    });
    await refreshResearchJobStatus(pausedJobId);
    const stillPaused = (await getResearchJob(pausedJobId))!;
    expect(stillPaused).toMatchObject({ status: "paused", verifiedCount: 1 });
    expect(stillPaused.completedAt).toBeNull();
    expect(await completedEvents(pausedJobId)).toBe(0);

    // A tick on a paused job makes no provider call and changes nothing.
    const forbidden = forbiddenProvider();
    const tick = await runResearchTick(pausedJobId, { provider: forbidden });
    expect(tick.status).toBe("paused");
    expect((await getResearchJob(pausedJobId))!.status).toBe("paused");
  });
});