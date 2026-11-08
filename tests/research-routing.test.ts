import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createResearchProvider } from "@/lib/services/research-provider-admin";
import { getDb } from "@/lib/db/client";
import { getResearchConfiguration, resolveLeadResearch, testLeadResearchConnection } from "@/lib/services/research-routing";

async function clear() {
  const db = await getDb();
  await db.query("DELETE FROM ai_task_fallbacks");
  await db.query("DELETE FROM ai_task_settings");
  await db.query("DELETE FROM research_providers");
}
beforeEach(async () => { await clear(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network call"); })); });
afterEach(() => vi.unstubAllGlobals());
afterAll(clear);
async function provider(name: string, extra = {}) {
  const id = await createResearchProvider({ name, provider: "deepseek", model: "deepseek-flash", apiKey: crypto.randomUUID(), ...extra });
  await (await getDb()).query("UPDATE research_providers SET last_test_ok = true WHERE id = $1", [id]);
  return id;
}
async function assign(id: string, model: string | null = null, search: string | null = null) {
  await (await getDb()).query("INSERT INTO ai_task_settings(task, provider_id, model, search_provider_id) VALUES ('lead_research', $1, $2, $3)", [id, model, search]);
}

it("no assignment means no implicit provider pool and zero network", async () => {
  await provider("Available but not assigned");
  expect(await getResearchConfiguration()).toMatchObject({ configured: false, selected: null, chain: [], error: expect.stringContaining("No provider is assigned") });
  expect(fetch).not.toHaveBeenCalled();
});
it("disabled primary uses explicit test-passed fallback before global; disabled/failed/search-only are never fallbacks", async () => {
  const primary = await provider("Primary", { isEnabled: false });
  const global = await provider("Global", { priority: 1 });
  const preferred = await provider("Preferred", { priority: 500 });
  const failed = await provider("Failed");
  await (await getDb()).query("UPDATE research_providers SET last_test_ok = false WHERE id = $1", [failed]);
  await provider("Search only", { kinds: "search" });
  await assign(primary);
  await (await getDb()).query("INSERT INTO ai_task_fallbacks(task, provider_id, priority) VALUES ('lead_research', $1, 1)", [preferred]);
  const resolved = await resolveLeadResearch();
  expect(resolved.configuration).toMatchObject({ configured: true, assigned: { id: primary }, selected: { id: preferred } });
  expect(resolved.configuration.chain.map(row => row.id)).toEqual([preferred, global]);
  expect(fetch).not.toHaveBeenCalled();
});
it("enabled failed-Test assignment is still tried with the effective task model override", async () => {
  const id = await provider("Assigned");
  await (await getDb()).query("UPDATE research_providers SET last_test_ok = false WHERE id = $1", [id]);
  await assign(id, "deepseek-v4-pro");
  const resolved = await resolveLeadResearch();
  expect(resolved.provider?.model).toBe("deepseek-v4-pro");
  expect(resolved.configuration).toMatchObject({ configured: true, selected: { model: "deepseek-v4-pro" }, warnings: [expect.stringContaining("last Test")] });
  expect(JSON.stringify(resolved.configuration)).not.toMatch(/encrypted|apiKey|searchPath|baseUrl/);
});
it.each(["deleted", "search-only", "missing-key", "unreadable-key"])("fails visibly for an unusable %s assignment without network", async kind => {
  const id = await provider("Unusable", kind === "search-only" ? { kinds: "search" } : {});
  await assign(id);
  const db = await getDb();
  if (kind === "deleted") await db.query("UPDATE research_providers SET deleted_at = now() WHERE id = $1", [id]);
  if (kind === "missing-key") await db.query("UPDATE research_providers SET encrypted_api_key = '' WHERE id = $1", [id]);
  if (kind === "unreadable-key") await db.query("UPDATE research_providers SET encrypted_api_key = $2 WHERE id = $1", [id, crypto.randomUUID()]);
  expect(await getResearchConfiguration()).toMatchObject({ configured: false, error: expect.any(String) });
  expect(fetch).not.toHaveBeenCalled();
});
it("separates an official DeepSeek chat model from a supported separate search source", async () => {
  const chat = await provider("Chat", { kinds: "chat" });
  const search = await provider("Search", { kinds: "search" });
  await assign(chat, "deepseek-v4-pro", search);
  const resolved = await resolveLeadResearch();
  expect(resolved.configuration).toMatchObject({ configured: true, selected: { id: chat, model: "deepseek-v4-pro" }, search: { id: search } });
  const network = vi.fn(async (url: string) => {
    if (String(url).includes("chat/completions")) return Response.json({ model: "deepseek-v4-pro", choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
    if (String(url).includes("/fetch")) return Response.json({ title: "Synthetic", content: "Synthetic source" });
    return Response.json({ results: [{ title: "Synthetic", url: "https://synthetic.test", snippet: "Signals" }] });
  });
  vi.stubGlobal("fetch", network);
  await resolved.provider!.search({ query: "synthetic", count: 1 });
  expect(resolved.provider!.lastUsedProvider).toBe("Search");
  await resolved.provider!.fetch({ url: "https://synthetic.test" });
  await resolved.provider!.chatJson({ system: "Synthetic", user: "Synthetic" });
  expect(resolved.provider!.lastUsedProvider).toBe("Chat");
  expect(resolved.provider!.lastUsedProviderFor).toEqual({ search: "Search", fetch: "Search", chat: "Chat" });
});
it.each([
  { provider: "brave", kinds: "search" },
  { provider: "openai", kinds: "both" },
])("a source without supported Search/Fetch endpoints still reports a real capability error: $provider", async extra => {
  const chat = await provider("Chat");
  const search = await provider("Unsupported", extra);
  await assign(chat, null, search);
  expect(await getResearchConfiguration()).toMatchObject({ configured: false, error: expect.stringContaining("Search and Fetch endpoints") });
  expect((await testLeadResearchConnection()).ok).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
// Founder: absent pricing must mean unknown cost, never refusal of a capable API.
it.each([{ provider: "anthropic", model: "claude-model" }, { model: "unpriced-model" }, { baseUrl: "https://gateway.test" },
  { provider: "custom", kinds: "both", baseUrl: "https://synthetic.test", model: "glm-5.3-flash" },
])("unknown research prices allow the assigned model with a working separate source", async extra => {
  const id = await provider("Unpriced", extra);
  const search = await provider("Source", { kinds: "search" });
  await assign(id, null, search);
  expect(await getResearchConfiguration()).toMatchObject({ configured: true, selected: { id }, error: null,
    warnings: [expect.stringContaining("Cost unknown")] });
  expect(fetch).not.toHaveBeenCalled();
});
it("explicit full Test uses the effective override for real chat plus search/fetch, without certifying the row-default model", async () => {
  const id = await provider("Effective model");
  await provider("Fallback must not be tested by this click", { priority: 500 });
  await assign(id, "deepseek-v4-pro");
  await (await getDb()).query("UPDATE research_providers SET last_test_ok = false WHERE id = $1", [id]);
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "deepseek-v4-pro" }] });
    if (String(url).includes("chat/completions")) return Response.json({ model: "deepseek-v4-pro", choices: [{ message: { content: '{"ok":true}' } }] });
    if (String(url).includes("/search")) return Response.json({ results: [{ title: "Synthetic", url: "https://synthetic.test", snippet: "Signals" }] });
    if (String(url).includes("/fetch")) return Response.json({ title: "Synthetic", content: "Synthetic source page" });
    throw new Error("Unexpected fixture endpoint");
  }));
  const outcome = await testLeadResearchConnection();
  expect(outcome.ok).toBe(true);
  expect(outcome.results).toHaveLength(1);
  expect(calls.filter(call => call.url.includes("chat/completions")).map(call => call.body.model)).toEqual(["deepseek-v4-pro"]);
  expect(calls.some(call => call.url.includes("/search"))).toBe(true);
  expect(calls.some(call => call.url.includes("/fetch"))).toBe(true);
  const stored = await (await getDb()).query<{ last_test_ok: boolean }>("SELECT last_test_ok FROM research_providers WHERE id = $1", [id]);
  expect(stored.rows[0].last_test_ok).toBe(false);
});

it("runtime chat failure follows the same ordered fallback chain and preserves real token usage/cost", async () => {
  const first = await provider("First");
  await provider("Fallback", { model: "deepseek-v4-pro" });
  await assign(first);
  const models: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const model = JSON.parse(String(init?.body)).model; models.push(model);
    if (model === "deepseek-flash") return Response.json({ error: { message: "Synthetic denial" } }, { status: 401 });
    return Response.json({ model, choices: [{ message: { content: '{"verified":true}' } }], usage: { prompt_tokens: 200, completion_tokens: 50, prompt_cache_hit_tokens: 25 } });
  }));
  const resolved = await resolveLeadResearch();
  const outcome = await resolved.provider!.chatJson({ system: "Synthetic", user: "Synthetic" });
  expect(models).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
  expect(outcome.usage).toMatchObject({ model: "deepseek-v4-pro", inputTokens: 200, outputTokens: 50, cachedInputTokens: 25 });
  expect(outcome.usage.costUsd).toBeGreaterThan(0);
  expect(resolved.provider!.lastUsedProvider).toBe("Fallback");
});

it("separate source full Test requires chat AND search AND fetch, surfacing a fetch failure", async () => {
  const chat = await provider("Chat", { kinds: "chat" });
  const search = await provider("Search", { kinds: "search" });
  await assign(chat, null, search);
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(String(url));
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "deepseek-flash" }] });
    if (String(url).includes("chat/completions")) return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
    if (String(url).includes("/search")) return Response.json({ results: [{ title: "Synthetic", url: "https://synthetic.test", snippet: "Synthetic" }] });
    return Response.json({ error: "Synthetic fetch failure" }, { status: 400 });
  }));
  const outcome = await testLeadResearchConnection();
  expect(outcome.ok).toBe(false);
  expect(outcome.results).toMatchObject([{ provider: "Chat", ok: true }, { provider: "Search", ok: false }]);
  expect(calls.some(url => url.includes("chat/completions"))).toBe(true);
  expect(calls.some(url => url.includes("/search"))).toBe(true);
  expect(calls.some(url => url.includes("/fetch"))).toBe(true);
});
