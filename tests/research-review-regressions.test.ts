import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import * as sessions from "@/lib/auth/session";
import { createResearchJob, getResearchJob, updateResearchJobStatus } from "@/lib/services/research";
import { createResearchProvider, testResearchProvider } from "@/lib/services/research-provider-admin";
import { resolveAiTask } from "@/lib/ai/registry";
import { resolveLeadResearch as resolveWithLimits } from "@/lib/services/research-routing";
import { runResearchTick } from "@/lib/services/research-engine";
import { getResearchUsage, recordResearchUsage } from "@/lib/services/research-usage";
import { listDraftsForProspect } from "@/lib/services/drafts";
import { runAgentAction } from "@/lib/agent/service";
import { GET } from "@/app/api/research/[id]/activity/route";
import { extractChatUsage } from "@/lib/ai/chat-usage";
import { createFakeProvider, qualifyingSite } from "./fake-provider";

let founder: Awaited<ReturnType<typeof sessions.ensureBootstrapUser>>;
const jobs: string[] = [];
function resolveLeadResearch(options: { jobId: string }) {
  return resolveWithLimits({ searchQps: 5, fetchQps: 5, ...options });
}
async function clearProviders() {
  const db = await getDb();
  await db.query("DELETE FROM ai_task_fallbacks");
  await db.query("DELETE FROM ai_task_settings");
  await db.query("DELETE FROM research_providers");
}
beforeAll(async () => {
  founder = await sessions.ensureBootstrapUser({ email: `review-${crypto.randomUUID()}@fixture.test`, password: crypto.randomUUID(), name: "Synthetic reviewer fixture" });
});
beforeEach(clearProviders);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => {
  await clearProviders();
  const db = await getDb();
  const prospects = await db.query<{ id: string }>("SELECT id FROM prospects WHERE research_job_id=ANY($1::uuid[])", [jobs]);
  for (const { id } of prospects.rows) {
    for (const table of ["prospect_rejection_recommendations", "prospect_assessment_overrides", "prospect_contact_route_observations", "prospect_audience_observations", "prospect_assessments"]) await db.query(`DELETE FROM ${table} WHERE prospect_id=$1`, [id]);
    await db.query("DELETE FROM prospects WHERE id=$1", [id]);
  }
  for (const id of jobs) await db.query("DELETE FROM research_jobs WHERE id=$1", [id]);
  await db.query("DELETE FROM users WHERE id=$1", [founder.id]);
});
async function job() {
  const result = await createResearchJob({ name: "Accounting review fixture", targetCount: 2, categories: ["forex"], userId: founder.id, engine: "deepseek", budgetUsd: 1 });
  jobs.push(result.id);
  return result.id;
}
async function provider(vendor: string, extra: Record<string, unknown> = {}) {
  const id = await createResearchProvider({ name: `${vendor}-${crypto.randomUUID()}`, provider: vendor, model: "fixture-model", apiKey: crypto.randomUUID(), isEnabled: true, kinds: "chat", ...extra });
  await (await getDb()).query("UPDATE research_providers SET last_test_ok=true WHERE id=$1", [id]);
  return id;
}
async function assign(chat: string, source: string) {
  await (await getDb()).query("INSERT INTO ai_task_settings(task,provider_id,search_provider_id) VALUES('lead_research',$1,$2)", [chat, source]);
}

it("official research preserves bounded non-thinking JSON requests and configured-model pricing despite a served alias", async () => {
  const chat = await provider("deepseek", { model: "deepseek-flash", kinds: "both" });
  await assign(chat, chat);
  const id = await job();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(JSON.parse(String(init.body))).toMatchObject({ thinking: { type: "disabled" }, temperature: 0.2, stream: false, max_tokens: 123 });
    expect(JSON.parse(String(init.body))).not.toHaveProperty("stream_options");
    return Response.json({ model: "official-served-alias", choices: [{ message: { content: 'Preface {"ok":true} trailing text' } }], usage: { prompt_tokens: 80, completion_tokens: 30 } });
  }));
  const resolved = (await resolveLeadResearch({ jobId: id })).provider!;
  const result = await resolved.chatJson({ system: "Synthetic", user: "Synthetic", maxTokens: 123 });
  expect(result.data).toEqual({ ok: true });
  expect(result.usage.model).toBe("official-served-alias");
  expect(result.usage.costUsd).toBeGreaterThan(0);
  expect((await getResearchUsage(id)).unknownCostCalls).toBe(0);
});

it("canonical official validation, HTTP and empty results retain known zero and upstream request counts", async () => {
  const chat = await provider("deepseek", { model: "deepseek-flash", kinds: "both" });
  await assign(chat, chat);
  const id = await job();
  const network = vi.fn(async () => Response.json({ error: "Synthetic" }, { status: 404 }));
  vi.stubGlobal("fetch", network);
  const resolved = (await resolveLeadResearch({ jobId: id })).provider!;
  await expect(resolved.search({ query: "", count: 1 })).rejects.toThrow();
  await expect(resolved.fetch({ url: "not-a-url" })).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
  await expect(resolved.fetch({ url: "https://business.fixture.test/robots.txt" })).rejects.toThrow();
  network.mockImplementation(async () => Response.json({ content: "" }));
  expect((await resolved.fetch({ url: "https://business.fixture.test/empty" })).costUsd).toBe(0);
  expect(await getResearchUsage(id)).toMatchObject({ costUsd: 0, unknownCostCalls: 0, requests: 0 });
  network.mockImplementation(async () => { throw new Error("Synthetic connection loss"); });
  await expect(resolved.fetch({ url: "https://business.fixture.test/network" })).rejects.toThrow();
  expect((await getResearchUsage(id)).unknownCostCalls).toBe(1);
});

it("an accounting failure on a later fallback latches the whole pool including earlier entries", async () => {
  const first = await provider("custom", { baseUrl: "https://first.fixture.test", kinds: "both" });
  const second = await provider("custom", { baseUrl: "https://second.fixture.test", kinds: "both" });
  await assign(first, first);
  const db = await getDb();
  await db.query("INSERT INTO ai_task_fallbacks(task,provider_id,priority) VALUES('lead_research',$1,1)", [second]);
  const id = await job();
  const network = vi.fn(async (url: string) => url.includes("first.fixture") ? Response.json({}, { status: 401 }) : Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }));
  vi.stubGlobal("fetch", network);
  const resolved = (await resolveLeadResearch({ jobId: id })).provider!;
  const original = db.transaction.bind(db);
  const transaction = vi.spyOn(db, "transaction").mockImplementationOnce(original).mockRejectedValueOnce(new Error("Synthetic accounting failure"));
  try {
    await expect(resolved.chatJson({ system: "Synthetic", user: "Synthetic" })).rejects.toMatchObject({ name: "ResearchAccountingError" });
    transaction.mockRestore();
    const attempts = network.mock.calls.length;
    await expect(resolved.search({ query: "Synthetic", count: 1 })).rejects.toMatchObject({ name: "ResearchAccountingError" });
    expect(network).toHaveBeenCalledTimes(attempts);
    expect(network.mock.calls.some(([url]) => url.includes("second.fixture"))).toBe(true);
  } finally { transaction.mockRestore(); }
});

it.each(["search", "robots", "chat", "draft"])("%s accounting failure pauses the engine and preserves progress across ticks", async stage => {
  const chat = await provider("custom", { baseUrl: "https://chat.fixture.test" });
  const source = await provider("custom", { baseUrl: "https://source.fixture.test", kinds: "both", searchPath: "/search", fetchPath: "/fetch" });
  await assign(chat, source);
  const id = await job();
  const site = qualifyingSite({ domain: `accounting-${crypto.randomUUID()}.example.com`, businessName: "Synthetic Accounting Signals", email: "desk@accounting-fixture.example.com" });
  const { provider: fake } = createFakeProvider({ sites: [site] });
  const db = await getDb();
  if (stage === "draft") await db.query("INSERT INTO ai_task_settings(task,provider_id) VALUES('first_email',$1)", [chat]);
  let injected = false;
  const network = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const operation = url.endsWith("/search") ? "search" : url.endsWith("/fetch") ? "fetch" : body.max_tokens === 700 ? "draft" : "chat";
    const response = operation === "search" ? await fake.search({ query: body.query, count: body.count })
      : operation === "fetch" ? await fake.fetch({ url: body.url })
      : { model: body.model, choices: [{ message: { content: JSON.stringify((await fake.chatJson({ system: body.messages[0].content, user: body.messages[1].content })).data) } }] };
    if (!injected && (stage === operation || stage === "robots" && operation === "fetch" && body.url.endsWith("/robots.txt"))) {
      vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("Synthetic accounting failure"));
      injected = true;
    }
    return Response.json(response);
  });
  vi.stubGlobal("fetch", network);
  await updateResearchJobStatus(id, "active");
  const tick = await runResearchTick(id, { maxCandidatesPerTick: 2 });
  expect(injected).toBe(true);
  expect(tick.status).toBe("paused");
  expect((await getResearchJob(id))?.status).toBe("paused");
  expect(tick.failed).toBe(0);
  const candidates = await db.query<{ status: string; attempts: number; claim_id: string | null }>("SELECT status,attempts,claim_id FROM research_candidates WHERE job_id=$1", [id]);
  expect(candidates.rows.every(row => row.claim_id === null && (row.status === "pending" && row.attempts === 0 || stage === "draft" && row.status === "qualified"))).toBe(true);
  if (stage !== "search") expect(candidates.rows.length).toBeGreaterThan(0);
  if (stage === "draft") expect((await getResearchJob(id))?.verifiedCount).toBeGreaterThan(0);
  expect((await db.query("SELECT claim_id FROM candidate_claims WHERE job_id=$1", [id])).rows).toHaveLength(0);
  const attempts = network.mock.calls.length;
  await runResearchTick(id);
  expect(network).toHaveBeenCalledTimes(attempts);
});

it.each(["valid", "invalid_json", "short", "failover"])("full research accounts %s Settings draft attempts before parsing, saves lead/draft and sends nothing", async draftCase => {
  const chat = await provider("custom", { baseUrl: "https://chat.fixture.test" });
  const source = await provider("custom", { baseUrl: "https://source.fixture.test", kinds: "both", searchPath: "/search", fetchPath: "/fetch" });
  await assign(chat, source);
  const id = await job();
  const unique = crypto.randomUUID();
  const site = qualifyingSite({ domain: `draft-${unique}.example.com`, businessName: `Synthetic Draft ${unique}`, email: `desk-${unique}@draft-fixture.example.com` });
  const { provider: fake } = createFakeProvider({ sites: [site] });
  const db = await getDb();
  await db.query("INSERT INTO ai_task_settings(task,provider_id) VALUES('first_email',$1)", [chat]);
  if (draftCase === "failover") {
    const fallback = await provider("custom", { baseUrl: "https://draft-fallback.fixture.test" });
    await db.query("INSERT INTO ai_task_fallbacks(task,provider_id,priority) VALUES('first_email',$1,1)", [fallback]);
  }
  const before = (await db.query("SELECT count(*)::int AS n FROM outbound_sends")).rows;
  let modelRequests = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/search")) return Response.json(await fake.search({ query: body.query, count: body.count }));
    if (url.endsWith("/fetch")) return Response.json(await fake.fetch({ url: body.url }));
    modelRequests += 1;
    if (body.max_tokens === 700) {
      if (draftCase === "failover" && url.includes("chat.fixture")) return Response.json({}, { status: 401 });
      const text = draftCase === "invalid_json" ? "Not JSON" : JSON.stringify({ subject: "Synthetic draft", body: draftCase === "short" ? "Too short." : "Hello, I saw your paid forex signal subscription on the official website. Would you be open to a short written demo of Nomeriq for your business?" });
      return Response.json({ model: body.model, choices: [{ message: { content: text } }] });
    }
    return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify((await fake.chatJson({ system: body.messages[0].content, user: body.messages[1].content })).data) } }] });
  }));
  await updateResearchJobStatus(id, "active");
  const tick = await runResearchTick(id, { maxCandidatesPerTick: 1 });
  expect(tick.saved).toBe(1);
  const saved = (await db.query<{ id: string }>("SELECT id FROM prospects WHERE research_job_id=$1", [id])).rows;
  expect(saved).toHaveLength(1);
  expect((await listDraftsForProspect(saved[0].id)).filter(draft => draft.kind === "first_contact")).toHaveLength(1);
  const usage = await getResearchUsage(id);
  expect(usage.costUsd).toBeNull();
  expect(usage.modelCalls).toBe(modelRequests);
  expect(usage.unknownTokenCalls).toBe(modelRequests);
  expect(usage.recent.filter(row => row.operation === "draft").length).toBeGreaterThan(0);
  expect((await db.query("SELECT count(*)::int AS n FROM outbound_sends")).rows).toEqual(before);
});

it("MCP job JSON and activity API expose unknown total and known subtotal rather than a free job", async () => {
  const id = await job();
  await recordResearchUsage({ jobId: id, operation: "chat", provider: "synthetic custom", costUsd: null });
  const result = await runAgentAction({ id: `oauth:synthetic-${crypto.randomUUID()}`, name: "Synthetic read-only audit", assistant: "hermes", scopes: ["research:read"] }, "list_research_jobs");
  expect((result.data.jobs as Array<{ id: string }>).find(row => row.id === id)).toMatchObject({ costUsd: null, spentUsd: 0, knownCostUsd: 0, unknownCostCalls: 1 });
  vi.spyOn(sessions, "requireEditor").mockResolvedValue({ id: founder.id, email: "synthetic@fixture.test", name: "Synthetic", role: "founder" });
  const response = await GET(new Request(`http://localhost/api/research/${id}/activity`), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
  expect((await response.json()).data.job).toMatchObject({ costUsd: null, spentUsd: 0, knownCostUsd: 0, unknownCostCalls: 1 });
});

it("Gemini includes reported thinking tokens without inventing counters", () => {
  expect(extractChatUsage("gemini", JSON.stringify({ usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, thoughtsTokenCount: 5 } }))).toMatchObject({ inputTokens: 8, outputTokens: 8 });
});

it.each(["openrouter", "openai", "anthropic", "gemini"])("%s both-kind chat Test never probes invented DeepSeek tools or invalidates chat task fallbacks", async vendor => {
  // In particular, OpenRouter's real catalog default is both; do not neutralize the regression with chat-only.
  const id = await createResearchProvider({ name: `Both-kind ${crypto.randomUUID()}`, provider: vendor,
    model: "fixture-model", apiKey: crypto.randomUUID(), ...(vendor === "openrouter" ? {} : { kinds: "both" }) });
  const db = await getDb();
  expect((await db.query<{ kinds: string }>("SELECT kinds FROM research_providers WHERE id=$1", [id])).rows[0].kinds).toBe("both");
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    urls.push(url);
    if (/tools\/search|tools\/fetch|\/scrape|\/search/.test(url)) throw new Error("Unexpected invented tool probe");
    if (!init.body) return vendor === "gemini" ? Response.json({ models: [{ name: "models/fixture-model" }] }) : Response.json({ data: [{ id: "fixture-model" }] });
    if (vendor === "anthropic") return Response.json({ content: [{ type: "text", text: '{"ok":true}' }] });
    if (vendor === "gemini") return Response.json({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] });
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  }));
  expect((await testResearchProvider(id)).ok).toBe(true);
  expect(urls.some(url => /tools\/search|tools\/fetch|\/scrape|\/search/.test(url))).toBe(false);
  expect((await db.query<{ last_test_ok: boolean }>("SELECT last_test_ok FROM research_providers WHERE id=$1", [id])).rows[0].last_test_ok).toBe(true);
  for (const task of ["first_email", "follow_up", "suggest_reply"] as const) {
    await db.query("INSERT INTO ai_task_settings(task,provider_id) VALUES($1,$2)", [task, id]);
    expect((await resolveAiTask(task)).fallbackChain.some(row => row.id === id)).toBe(true);
  }
});

it.each([429, 503, "network"])("official research retries temporary %s before saving one known-cost success", async failure => {
  const id = await provider("deepseek", { model: "deepseek-flash", kinds: "both" });
  await assign(id, id);
  const jobId = await job();
  let attempt = 0;
  const network = vi.fn(async (_url: string, init: RequestInit) => {
    expect(JSON.parse(String(init.body))).toMatchObject({ stream: false, thinking: { type: "disabled" }, max_tokens: 123 });
    if (attempt++ === 0) {
      if (failure === "network") throw new Error("Synthetic transient connection loss");
      return Response.json({ error: { code: "temporarily_unavailable" } }, { status: failure as number, headers: { "Retry-After": "0" } });
    }
    return Response.json({ model: "official-served-alias", choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 80, completion_tokens: 30 } });
  });
  vi.stubGlobal("fetch", network);
  const result = await (await resolveLeadResearch({ jobId })).provider!.chatJson({ system: "Synthetic", user: "Synthetic", maxTokens: 123 });
  expect(result.data).toEqual({ ok: true });
  expect(network).toHaveBeenCalledTimes(2);
  expect(result.usage.costUsd).toBeGreaterThan(0);
  const usage = await getResearchUsage(jobId);
  expect(usage).toMatchObject({ modelCalls: 1, unknownCostCalls: 0 });
  expect(usage.recent).toHaveLength(1);
});

it.each([429, 401])("official research bounds persistent HTTP %s retries and never retries auth failures", async status => {
  const id = await provider("deepseek", { model: "deepseek-flash", kinds: "both" });
  await assign(id, id);
  const jobId = await job();
  const network = vi.fn(async () => Response.json({ error: { code: status === 401 ? "invalid_api_key" : "rate_limit" } }, { status, headers: { "Retry-After": "0" } }));
  vi.stubGlobal("fetch", network);
  await expect((await resolveLeadResearch({ jobId })).provider!.chatJson({ system: "Synthetic", user: "Synthetic", maxTokens: 123 })).rejects.toThrow();
  expect(network).toHaveBeenCalledTimes(status === 401 ? 1 : 3);
  expect((await getResearchUsage(jobId)).recent).toHaveLength(1);
});
