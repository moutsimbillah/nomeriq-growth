import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { PROVIDER_CATALOG, PROVIDER_SLUGS } from "@/lib/ai/provider-catalog";
import { PROVIDER_DEFAULTS } from "@/lib/ai/registry";
import { listProviderModels, requestProviderChat } from "@/lib/ai/chat-transport";
import { testProviderChat } from "@/lib/ai/provider-test";

const baseUrl = "https://api.z.ai/api/paas/v4";
afterEach(() => vi.unstubAllGlobals());
describe("Z.ai GLM documented choices and standard chat protocol", () => {
  it("keeps catalog and registry defaults aligned, chat-only with both exact documented IDs", () => {
    expect(PROVIDER_CATALOG.zai.documentedModels).toEqual(["glm-5.3", "glm-5.3-flash"]);
    expect(PROVIDER_CATALOG.zai).toMatchObject(PROVIDER_DEFAULTS.zai);
    expect(PROVIDER_DEFAULTS.zai).toMatchObject({ baseUrl, kinds: "chat", model: "glm-5.3-flash" });
  });
  it("lists documented IDs with zero network calls, without claiming credential validation", async () => {
    const network = vi.fn(() => { throw new Error("Z.ai has no model-list endpoint"); });
    vi.stubGlobal("fetch", network);
    expect(await listProviderModels({ provider: "zai", baseUrl, model: "" }, crypto.randomUUID())).toEqual(["glm-5.3", "glm-5.3-flash"]);
    expect(network).not.toHaveBeenCalled();
  });
  it.each(["glm-5.3", "glm-5.3-flash"])("uses the exact standard API endpoint/ID for %s and excludes reasoning", async model => {
    const key = crypto.randomUUID();
    const network = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${baseUrl}/chat/completions`);
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`);
      expect(JSON.parse(String(init.body))).toMatchObject({ model, stream: true, max_tokens: 700,
        response_format: { type: "json_object" }, thinking: { type: "enabled" }, reasoning_effort: "low" });
      return Response.json({ model, choices: [{ message: { content: '{"ok":true}', reasoning_content: "Synthetic private reasoning" } }] });
    });
    vi.stubGlobal("fetch", network);
    const outcome = await requestProviderChat({ provider: "zai", baseUrl: `${baseUrl}/`, model }, key,
      { system: "Synthetic", user: "Synthetic", json: true, maxTokens: 700 });
    expect(outcome).toEqual({ ok: true, text: '{"ok":true}', model });
    expect(JSON.stringify(outcome)).not.toContain("Synthetic private reasoning");
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("ignores streamed reasoning and refuses reasoning-only responses", async () => {
    const config = { provider: "zai", baseUrl, model: "glm-5.3" };
    const packet = (content?: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Synthetic private reasoning" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n`, { headers: { "Content-Type": "text/event-stream" } });
    vi.stubGlobal("fetch", vi.fn(async () => packet('{"ok":true}')));
    expect(await requestProviderChat(config, crypto.randomUUID(), { system: "S", user: "U" })).toMatchObject({ ok: true, text: '{"ok":true}' });
    vi.stubGlobal("fetch", vi.fn(async () => packet()));
    expect(await requestProviderChat(config, crypto.randomUUID(), { system: "S", user: "U" })).toMatchObject({ ok: false, code: "empty_response" });
  });
  it("Test requires a genuine completion and never labels the documented list as API-reachable", async () => {
    const config = { provider: "zai", baseUrl, model: "glm-5.3-flash" };
    const network = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).max_tokens).toBe(4096);
      return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
    });
    vi.stubGlobal("fetch", network);
    const result = await testProviderChat(config, crypto.randomUUID());
    expect(result.ok).toBe(true);
    expect(result.message).toContain("documented IDs");
    expect(result.message).not.toContain("Model API reachable");
    expect(network).toHaveBeenCalledTimes(1);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "invalid_api_key" } }, { status: 401 })));
    expect(await testProviderChat(config, crypto.randomUUID())).toMatchObject({ ok: false, chatOk: false });
  });
  it.each([false, true])("does not retry Z.ai balance/key-type refusals, including flat payload=%s", async flat => {
    for (const [code, expected] of [["1113", "quota_exceeded"], ["1315", "http_error"]]) {
      const error = { code, message: "Synthetic private rejection" };
      const network = vi.fn(async () => Response.json(flat ? error : { error }, { status: 429 }));
      vi.stubGlobal("fetch", network);
      const result = await requestProviderChat({ provider: "zai", baseUrl, model: "glm-5.3" }, crypto.randomUUID(), { system: "S", user: "U", transientRetries: 2 });
      expect(result).toMatchObject({ ok: false, code: expected, providerCode: code });
      expect(JSON.stringify(result)).not.toContain(error.message);
      expect(network).toHaveBeenCalledTimes(1);
    }
  });
  it("never repairs or substitutes an invalid model identifier", async () => {
    const network = vi.fn(() => { throw new Error("Invalid model must not reach network"); });
    vi.stubGlobal("fetch", network);
    expect(await testProviderChat({ provider: "zai", baseUrl, model: "GLM 5.3" }, crypto.randomUUID())).toMatchObject({ ok: false, code: "model_not_listed" });
    expect(network).not.toHaveBeenCalled();
  });
});

it("032 widens the CHECK additively, preserves all rows and safely reruns while enforcing chat-only Z.ai", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE research_providers (
      id text PRIMARY KEY, provider text NOT NULL CHECK(provider IN('deepseek','openai','anthropic','gemini','openrouter','brave','custom')),
      kinds text NOT NULL, model text NOT NULL, name text NOT NULL);
      INSERT INTO research_providers VALUES('old','deepseek','both','deepseek-flash','Fixture provider');`);
    const before = (await db.query("SELECT * FROM research_providers")).rows;
    const sql = readFileSync("src/db/migrations/032_zai_chat_provider.sql", "utf8");
    await db.exec(sql);
    expect((await db.query("SELECT * FROM research_providers")).rows).toEqual(before);
    await db.exec("INSERT INTO research_providers VALUES('zai','zai','chat','glm-5.3-flash','Fixture GLM')");
    const expanded = (await db.query("SELECT * FROM research_providers ORDER BY id")).rows;
    await db.exec(sql);
    expect((await db.query("SELECT * FROM research_providers ORDER BY id")).rows).toEqual(expanded);
    await expect(db.exec("UPDATE research_providers SET provider='unknown' WHERE id='zai'")).rejects.toThrow();
    await expect(db.exec("UPDATE research_providers SET kinds='both' WHERE id='zai'")).rejects.toThrow();
    const check = (await db.query<{def:string}>("SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conname='research_providers_provider_check'")).rows[0].def;
    const allowed = [...check.matchAll(/'([^']+)'::text/g)].map(match => match[1]);
    expect(allowed.sort()).toEqual([...PROVIDER_SLUGS].sort());
  } finally { await db.close(); }
});
