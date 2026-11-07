/**
 * The research job's start/resume gate resolves the provider exactly as the Research engine card does.
 *
 * THE DEFECT THIS COVERS
 * The card above the job read its state from the AI provider registry — the Lead research assignment,
 * the provider list and its fallbacks — and said "Configured". The start/resume path underneath still
 * asked the retired legacy resolver (a `provider_credentials` row or `DEEPSEEK_API_KEY` in the
 * environment), found neither, and refused the job with "DeepSeek is not configured. Add an API key
 * before starting research." with a job whose provider was configured in Settings all along. The
 * founder saw a page that contradicted itself.
 *
 * WHAT IS ASSERTED
 * With a provider-list entry and a Lead research assignment, and NOTHING else — no
 * `provider_credentials` row, no `DEEPSEEK_API_KEY` — the job resumes: it becomes active, and the same
 * resolution the card renders reports configured. With no usable provider the refusal is the card's
 * own wording under `research_not_configured`, the job stays paused, and the retired code is not what
 * decided it.
 *
 * `runNow` is false throughout: this file proves the gate, and a tick would mean a paid provider call.
 */

const signedIn = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth/session")>();
  return { ...original, requireEditor: async () => signedIn() };
});

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { ensureBootstrapUser } from "@/lib/auth/session";
import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { createResearchProvider } from "@/lib/services/research-provider-admin";
import { saveTaskSetting } from "@/lib/services/ai-task-settings";
import { createResearchJob, getResearchJob } from "@/lib/services/research";
import { getResearchConfiguration } from "@/lib/services/research-routing";
import { POST } from "@/app/api/research/[id]/engine/route";

const ORIGIN = process.env.APP_URL ?? "http://localhost:3100";
const SYNTHETIC_KEY = "synthetic-fixture-key-not-a-real-credential";

let founderId = "";
let providerId = "";

/** The live shape: one enabled, Test-passed DeepSeek row, nothing in the legacy credential table. */
async function seedProviderListEntry(): Promise<void> {
  providerId = await createResearchProvider({
    name: "Growth-Chat-Search",
    provider: "deepseek",
    kinds: "both",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com",
    apiKey: SYNTHETIC_KEY,
    priority: 10,
  });
  const db = await getDb();
  await db.query(`UPDATE research_providers SET last_test_ok = true WHERE id = $1`, [providerId]);
  await saveTaskSetting("lead_research", { providerId, model: null });
}

async function clearProviderList(): Promise<void> {
  const db = await getDb();
  await db.query(`DELETE FROM ai_task_fallbacks`);
  await db.query(`DELETE FROM ai_task_settings`);
  await db.query(`DELETE FROM research_providers`);
}

async function newJob(input: { budgetUsd?: number; spentUsd?: number } = {}): Promise<string> {
  const job = await createResearchJob({
    name: "Resume gate fixture",
    targetCount: 5,
    categories: ["forex"],
    engine: "deepseek",
    budgetUsd: input.budgetUsd ?? 1,
    userId: founderId,
  });
  if (input.spentUsd !== undefined) {
    const db = await getDb();
    await db.query(`UPDATE research_jobs SET spent_usd = $2 WHERE id = $1`, [job.id, input.spentUsd]);
  }
  return job.id;
}

function request(jobId: string, body: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}/api/research/${jobId}/engine`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

const context = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  founderId = (await ensureBootstrapUser({
    email: `resume-gate-${Date.now()}@fixture.test`,
    password: crypto.randomUUID(),
    name: "Resume Gate Founder",
  })).id;
});

afterAll(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM research_jobs WHERE name = 'Resume gate fixture'`);
  await clearProviderList();
  await db.query(`DELETE FROM users WHERE email LIKE 'resume-gate-%@fixture.test'`);
  await closeDb();
});

beforeEach(async () => {
  signedIn.mockResolvedValue({ id: "fixture-editor" });
  await clearProviderList();
  const db = await getDb();
  // The legacy path must be genuinely absent for the assertion to mean anything.
  await db.query(`DELETE FROM provider_credentials WHERE provider = 'deepseek'`);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearProviderList();
});

it("resumes a job whose provider exists only as a provider-list entry", async () => {
  await seedProviderListEntry();
  const jobId = await newJob();

  // The premise: no credential row, no environment key — the provider list is the only configuration.
  const db = await getDb();
  const credentials = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM provider_credentials WHERE provider = 'deepseek'`,
  );
  expect(Number(credentials.rows[0].n)).toBe(0);
  expect((process.env.DEEPSEEK_API_KEY ?? "").trim()).toBe("");
  // The same resolution the card above the job shows.
  expect((await getResearchConfiguration()).configured).toBe(true);

  const response = await POST(request(jobId, { action: "resume", runNow: false }), context(jobId));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.data.job.status).toBe("active");
  expect((await getResearchJob(jobId))?.status).toBe("active");
});

it("starts a paused job through the same resolution, and never reports the retired error", async () => {
  await seedProviderListEntry();
  const jobId = await newJob();
  const response = await POST(request(jobId, { action: "start", runNow: false }), context(jobId));
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).not.toContain("DEEPSEEK_API_KEY");
  expect(text).not.toContain("deepseek_not_configured");
});

it("refuses with the card's own wording when no provider is usable, and leaves the job paused", async () => {
  const jobId = await newJob();
  const response = await POST(request(jobId, { action: "resume", runNow: false }), context(jobId));
  expect(response.status).toBe(409);
  const body = await response.json();
  expect(body.code ?? body.error?.code).toBe("research_not_configured");
  // The refusal explains itself in the founder's terms, not in environment-variable terms.
  const text = JSON.stringify(body);
  expect(text).not.toContain("DEEPSEEK_API_KEY");
  expect((await getResearchJob(jobId))?.status).toBe("paused");
});

it("still refuses an exhausted budget before activating the job", async () => {
  await seedProviderListEntry();
  const jobId = await newJob({ budgetUsd: 0.1, spentUsd: 0.1 });
  const response = await POST(request(jobId, { action: "resume", runNow: false }), context(jobId));
  expect(response.status).toBe(409);
  expect((await response.json()).code ?? "").toBe("budget_exhausted");
  expect((await getResearchJob(jobId))?.status).toBe("paused");
});

it("refuses a cross-origin resume without resolving anything or activating the job", async () => {
  await seedProviderListEntry();
  const jobId = await newJob();
  const response = await POST(
    request(jobId, { action: "resume", runNow: false }, "https://untrusted.test"),
    context(jobId),
  );
  expect(response.status).toBe(403);
  expect((await getResearchJob(jobId))?.status).toBe("paused");
});

it("refuses an unauthenticated resume and leaves the job paused", async () => {
  signedIn.mockRejectedValue(new Error("not signed in"));
  await seedProviderListEntry();
  const jobId = await newJob();
  const response = await POST(request(jobId, { action: "resume", runNow: false }), context(jobId));
  expect(response.status).not.toBe(200);
  expect((await getResearchJob(jobId))?.status).toBe("paused");
});
