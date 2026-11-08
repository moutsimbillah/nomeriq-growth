import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { getDb } from "@/lib/db/client";
import { ensureBootstrapUser } from "@/lib/auth/session";
import { createResearchJob, getResearchJob, updateResearchJobStatus } from "@/lib/services/research";
import { runResearchTick } from "@/lib/services/research-engine";
import { listDraftsForProspect } from "@/lib/services/drafts";
import { createFakeProvider, qualifyingSite } from "./fake-provider";
import { createResearchProvider } from "@/lib/services/research-provider-admin";
import { resolveLeadResearch } from "@/lib/services/research-routing";
import { getAllResearchUsage, getResearchUsage, recordResearchUsage } from "@/lib/services/research-usage";
import { getJobBudget } from "@/lib/services/research-runs";

let founder = "";
const jobs: string[] = [];
async function clear() {
  const db = await getDb();
  await db.query("DELETE FROM ai_task_fallbacks");
  await db.query("DELETE FROM ai_task_settings");
  await db.query("DELETE FROM research_providers");
}
beforeAll(async () => {
  founder = (await ensureBootstrapUser({ email: `unknown-${crypto.randomUUID()}@fixture.test`, password: crypto.randomUUID(), name: "Synthetic" })).id;
});
beforeEach(async () => { await clear(); });
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await clear();
  const db = await getDb();
  const prospects = await db.query<{ id: string }>("SELECT id FROM prospects WHERE research_job_id=ANY($1::uuid[])", [jobs]);
  for (const row of prospects.rows) {
    for (const table of ["prospect_rejection_recommendations", "prospect_assessment_overrides", "prospect_contact_route_observations", "prospect_audience_observations", "prospect_assessments"]) {
      await db.query(`DELETE FROM ${table} WHERE prospect_id=$1`, [row.id]);
    }
    await db.query("DELETE FROM prospects WHERE id=$1", [row.id]);
  }
  for (const id of jobs) await db.query("DELETE FROM research_jobs WHERE id=$1", [id]);
  await db.query("DELETE FROM users WHERE id=$1", [founder]);
});
async function job() {
  const row = await createResearchJob({ name: "Unknown-cost fixture", targetCount: 2, categories: ["forex"], userId: founder, engine: "deepseek", budgetUsd: 1 });
  jobs.push(row.id); return row.id;
}
async function provider(provider: string, extra: Record<string, unknown> = {}) {
  const id = await createResearchProvider({ name: `${provider}-${crypto.randomUUID()}`, provider, model: provider === "zai" ? "glm-5.3-flash" : "fixture-model", apiKey: crypto.randomUUID(), isEnabled: true, kinds: "chat", ...extra });
  await (await getDb()).query("UPDATE research_providers SET last_test_ok=true WHERE id=$1", [id]);
  return id;
}
async function assign(chat: string, source: string) {
  await (await getDb()).query("INSERT INTO ai_task_settings(task,provider_id,search_provider_id) VALUES('lead_research',$1,$2)", [chat, source]);
}

it.each(["openai", "anthropic", "gemini", "zai", "openrouter", "custom", "deepseek"])("%s researches through its own chat protocol with separate Search/Fetch and unknown cost, not fake DeepSeek billing", async vendor => {
  const chat = await provider(vendor, vendor === "custom" ? { baseUrl: "https://gateway.fixture.test" } : {});
  const source = await provider("custom", { baseUrl: "https://source.fixture.test", kinds: "both", searchPath: "/v1/search", fetchPath: "/v1/scrape" });
  await assign(chat, source);
  const id = await job();
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push(String(url));
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/v1/search")) return Response.json({ data: { web: [{ title: "Synthetic", url: "https://business.fixture.test", description: "Signals" }] } });
    if (url.endsWith("/v1/scrape")) return Response.json({ data: { title: "Synthetic", markdown: "Synthetic official page" } });
    const answer = '{"ok":true}';
    if (vendor === "anthropic") {
      expect(url.endsWith("/v1/messages")).toBe(true);
      expect(body.max_tokens).toBe(123);
      return Response.json({ model: body.model, content: [{ type: "text", text: answer }], usage: { input_tokens: 8, output_tokens: 3 } });
    }
    if (vendor === "gemini") {
      expect(url.endsWith(":generateContent")).toBe(true);
      return Response.json({ candidates: [{ content: { parts: [{ text: answer }] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3 } });
    }
    expect(url.endsWith(vendor === "zai" ? "/v4/chat/completions" : vendor === "deepseek" ? "/chat/completions" : "/v1/chat/completions")).toBe(true);
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(123);
    return Response.json({ model: body.model, choices: [{ message: { content: answer } }], usage: { prompt_tokens: 8, completion_tokens: 3 } });
  }));
  const resolved = await resolveLeadResearch({ searchQps: 5, fetchQps: 5, jobId: id });
  expect(resolved.configuration.configured).toBe(true);
  const search = await resolved.provider!.search({ query: "synthetic", count: 1 });
  expect(search.costUsd).toBeNull();
  expect((await resolved.provider!.fetch({ url: "https://business.fixture.test" })).costUsd).toBeNull();
  const result = await resolved.provider!.chatJson({ system: "Synthetic", user: "Synthetic", maxTokens: 123 });
  expect(result.data).toEqual({ ok: true });
  expect(result.usage).toMatchObject({ inputTokens: 8, outputTokens: 3, costUsd: null });
  expect(calls).toHaveLength(3);
  const usage = await getResearchUsage(id);
  expect(usage).toMatchObject({ costUsd: null, knownCostUsd: 0, unknownCostCalls: 3, requests: 3, searches: 1, fetches: 1, modelCalls: 1 });
  expect(usage.recent.every(row => row.costUsd === null)).toBe(true);
  expect((await getResearchJob(id))?.status).toBe("paused"); // resolving/calling an adapter never activates a job
});

it("mixed known/unknown usage keeps a known subtotal and enforces its budget without claiming total cost", async () => {
  const id = await job();
  await recordResearchUsage({ jobId: id, provider: "official", operation: "search", costUsd: 0.25 });
  await recordResearchUsage({ jobId: id, provider: "custom", operation: "chat", costUsd: null, inputTokens: null, outputTokens: null });
  expect(await getResearchUsage(id)).toMatchObject({ costUsd: null, knownCostUsd: 0.25, unknownCostCalls: 1, unknownTokenCalls: 1 });
  expect(await getJobBudget(id)).toMatchObject({ spentUsd: 0.25, remainingUsd: 0.75, exhausted: false, unknownCostCalls: 1 });
  expect(await getAllResearchUsage()).toMatchObject({ costUsd: null, cost24h: null });
  await recordResearchUsage({ jobId: id, operation: "search", costUsd: 0.75 });
  expect(await getJobBudget(id)).toMatchObject({ spentUsd: 1, exhausted: true });
});

it("an accounting write failure prevents fallback or another paid call in the same resolved tick", async () => {
  const chat = await provider("custom", { baseUrl: "https://chat.fixture.test" });
  const source = await provider("custom", { baseUrl: "https://source.fixture.test", kinds: "both", searchPath: "/v1/search", fetchPath: "/v1/scrape" });
  await assign(chat, source);
  const id = await job();
  const { provider: resolved } = await resolveLeadResearch({ searchQps: 5, fetchQps: 5, jobId: id });
  const network = vi.fn(async () => Response.json({ title: "Synthetic", content: "Synthetic page" }));
  vi.stubGlobal("fetch", network);
  const db = await getDb();
  const transaction = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("Synthetic accounting failure"));
  try {
    await expect(resolved!.fetch({ url: "https://business.fixture.test" })).rejects.toMatchObject({ name: "ResearchAccountingError" });
    transaction.mockRestore();
    await expect(resolved!.fetch({ url: "https://business.fixture.test/contact" })).rejects.toMatchObject({ name: "ResearchAccountingError" });
    expect(network).toHaveBeenCalledTimes(1);
  } finally { transaction.mockRestore(); }
});

it("records failed custom attempts separately before fallback and preserves fallback model provenance", async () => {
  const first = await provider("custom", { baseUrl: "https://failed.fixture.test", model: "first-model" });
  const second = await provider("custom", { baseUrl: "https://fallback.fixture.test", model: "fallback-model" });
  const source = await provider("custom", { baseUrl: "https://source.fixture.test", kinds: "both", searchPath: "/search", fetchPath: "/fetch" });
  await assign(first, source);
  await (await getDb()).query("INSERT INTO ai_task_fallbacks(task,provider_id,priority) VALUES('lead_research',$1,1)", [second]);
  const id = await job();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("failed.fixture")
    ? Response.json({ error: { code: "invalid_api_key" } }, { status: 401 })
    : Response.json({ model: "fallback-model", choices: [{ message: { content: '{"ok":true}' } }] })));
  const { provider: resolved } = await resolveLeadResearch({ searchQps: 5, fetchQps: 5, jobId: id });
  expect((await resolved!.chatJson({ system: "Synthetic", user: "Synthetic" })).usage).toMatchObject({ model: "fallback-model", costUsd: null, inputTokens: null, outputTokens: null });
  expect(resolved!.model).toBe("fallback-model");
  const rows = await (await getDb()).query<{ provider: string; status: string; model: string }>("SELECT provider,status,model FROM research_usage WHERE job_id=$1 ORDER BY created_at", [id]);
  expect(rows.rows).toHaveLength(2);
  expect(rows.rows.map(row => [row.status, row.model])).toEqual([["error", "first-model"], ["success", "fallback-model"]]);
  expect(await getResearchUsage(id)).toMatchObject({ costUsd: null, unknownCostCalls: 2, unknownTokenCalls: 2 });
});

it("033 executes twice on isolated PGlite without changing historical values or stored unknown flags", async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE TABLE research_usage(id text PRIMARY KEY,cost_usd numeric NOT NULL,input_tokens int NOT NULL); INSERT INTO research_usage VALUES('history',0.12,14)");
    const sql = readFileSync("src/db/migrations/033_research_usage_certainty.sql", "utf8");
    await db.exec(sql);
    expect((await db.query("SELECT * FROM research_usage")).rows).toEqual([{ id: "history", cost_usd: "0.12", input_tokens: 14, cost_known: true, tokens_known: true }]);
    await db.exec("INSERT INTO research_usage VALUES('unknown',0,0,false,false)");
    const before = (await db.query("SELECT * FROM research_usage ORDER BY id")).rows;
    await db.exec(sql);
    expect((await db.query("SELECT * FROM research_usage ORDER BY id")).rows).toEqual(before);
  } finally { await db.close(); }
});

it("a full registry-driven custom research tick discovers, verifies and saves a draft with unknown cost and zero sends", async () => {
  const chat = await provider("custom", { baseUrl: "https://chat.fixture.test" });
  const source = await provider("custom", { baseUrl: "https://source.fixture.test", kinds: "both", searchPath: "/v1/search", fetchPath: "/v1/scrape" });
  await assign(chat, source);
  const id = await job();
  const site = qualifyingSite({ domain: `unknown-${crypto.randomUUID()}.example.com`, businessName: "Synthetic Forex Signals", email: `desk@unknown-fixture.example.com` });
  const { provider: fake } = createFakeProvider({ sites: [site] });
  const db = await getDb();
  const before = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM outbound_sends");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url === "https://source.fixture.test/v1/search") return Response.json(await fake.search({ query: body.query, count: body.count }));
    if (url === "https://source.fixture.test/v1/scrape") return Response.json(await fake.fetch({ url: body.url }));
    expect(url).toBe("https://chat.fixture.test/v1/chat/completions");
    const response = await fake.chatJson({ system: body.messages[0].content, user: body.messages[1].content });
    return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify(response.data) } }] });
  }));
  await updateResearchJobStatus(id, "active");
  const tick = await runResearchTick(id, { maxCandidatesPerTick: 1 });
  expect(tick.saved).toBe(1);
  expect(tick.failed).toBe(0);
  const saved = await db.query<{ id: string; ai_provider: string; ai_model: string }>("SELECT id,ai_provider,ai_model FROM prospects WHERE research_job_id=$1", [id]);
  expect(saved.rows).toHaveLength(1);
  expect(saved.rows[0].ai_model).toBe("fixture-model");
  const drafts = await listDraftsForProspect(saved.rows[0].id);
  expect(drafts.filter(draft => draft.kind === "first_contact")).toHaveLength(1);
  expect(drafts[0].status).not.toBe("sent");
  const usage = await getResearchUsage(id);
  expect(usage.costUsd).toBeNull();
  expect(usage.unknownCostCalls).toBeGreaterThan(0);
  expect(usage.modelCalls).toBe(1);
  expect(usage.unknownTokenCalls).toBe(1);
  expect((await db.query("SELECT count(*)::int AS n FROM outbound_sends")).rows).toEqual(before.rows);
});
