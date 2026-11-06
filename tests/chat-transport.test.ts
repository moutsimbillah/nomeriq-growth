import { afterEach, describe, expect, it, vi } from "vitest";
import { listProviderModels, requestProviderChat, safeProviderError } from "@/lib/ai/chat-transport";
import { testProviderChat } from "@/lib/ai/provider-test";
import { randomBytes } from "node:crypto";

const key = randomBytes(24).toString("hex");
const config = { provider: "custom", baseUrl: "https://gateway.example.test", model: "fixture-model" };
const input = { system: "Synthetic instruction", user: "Synthetic fixture", json: true, maxTokens: 100 };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const success = () => json({ model: "fixture-model", choices: [{ message: { content: '{"ok":true}' } }] });
afterEach(() => vi.unstubAllGlobals());

it.each(["https://gateway.example.test", "https://gateway.example.test/v1", "https://gateway.example.test/v1/"])("normalizes base %s to exactly one /v1", async baseUrl => {
  const fetcher = vi.fn(async (_url: unknown) => success());
  vi.stubGlobal("fetch", fetcher);
  expect((await requestProviderChat({ ...config, baseUrl }, key, input)).ok).toBe(true);
  expect(fetcher.mock.calls[0]?.[0]).toBe("https://gateway.example.test/v1/chat/completions");
});

it("uses only standard fields and supports a streaming-only gateway", async () => {
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "response_format", "stream"]);
    expect(body.stream).toBe(true);
    const raw = 'data: {"choices":[{"delta":{"reasoning_content":"not output"}}]}\r\n\r\ndata: {"model":"fixture-model","choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\ndata: {"choices":[{"delta":{"content":"true}"}}]}\n\ndata: [DONE]\n\n';
    const encoded = new TextEncoder().encode(raw);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoded.slice(0, 17)); controller.enqueue(encoded.slice(17)); controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetcher);
  const result = await requestProviderChat(config, key, input);
  expect(result).toEqual({ ok: true, text: '{"ok":true}', model: "fixture-model" });
});

it("retries a named optional-field rejection without leaking its error body", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    return body.response_format ? json({ error: { code: "unsupported_parameter", param: "response_format", message: "Private fixture text: response_format is not supported" } }, 400) : success();
  }));
  const result = await requestProviderChat(config, key, input);
  expect(result.ok).toBe(true);
  expect(bodies).toHaveLength(2);
  expect(bodies[0].response_format).toBeDefined();
  expect(bodies[1].response_format).toBeUndefined();
  expect(bodies[1].messages).toEqual(bodies[0].messages);
});

it("switches token-limit fields only after an explicit rejection", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); bodies.push(body);
    return body.max_tokens ? json({ error: { code: "unsupported_parameter", param: "max_tokens" } }, 400) : success();
  }));
  expect((await requestProviderChat(config, key, input)).ok).toBe(true);
  expect(bodies[1].max_tokens).toBeUndefined();
  expect(bodies[1].max_completion_tokens).toBe(100);
});

it("can fall back to non-stream JSON when streaming is explicitly unsupported", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return body.stream ? json({ error: { code: "unsupported_parameter", param: "stream" } }, 422) : success();
  }));
  expect((await requestProviderChat(config, key, input)).ok).toBe(true);
});

it.each([400, 401, 402, 429, 500])("does not blindly retry HTTP %s or expose raw errors", async status => {
  const fetcher = vi.fn(async () => json({ error: { code: "invalid_request", message: "Private fixture text" } }, status));
  vi.stubGlobal("fetch", fetcher);
  const result = await requestProviderChat(config, key, input);
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain("Private fixture text");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("never infers rejected fields from echoed prompts without a rejection phrase", () => {
  expect(safeProviderError({ error: { message: "The user mentioned response_format" } }).fields).toEqual([]);
});

it("fails rather than claiming success for an empty model response", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ choices: [{ message: { content: "" } }] })));
  expect(await requestProviderChat(config, key, input)).toMatchObject({ ok: false, code: "empty_response" });
});

it("fails a stream containing a provider error rather than accepting partial text", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response('data: {"error":{"message":"private"}}\n\ndata: [DONE]\n')));
  expect(await requestProviderChat(config, key, input)).toMatchObject({ ok: false, code: "request_failed" });
});

it("lists exact model IDs without repairing or aliasing them", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ data: [{ id: "fixture-model-v2" }] })));
  const result = await testProviderChat(config, key);
  expect(result).toMatchObject({ ok: false, code: "model_not_listed", models: ["fixture-model-v2"] });
});

it("loads every Gemini model-list page and strips only the documented models/ prefix", async () => {
  const fetcher = vi.fn(async (url: string) => url.includes("pageToken=")
    ? json({ models: [{ name: "models/second", supportedGenerationMethods: ["generateContent"] }] })
    : json({ models: [{ name: "models/first" }], nextPageToken: "two" }));
  vi.stubGlobal("fetch", fetcher);
  expect(await listProviderModels({ ...config, provider: "gemini" }, key)).toEqual(["first", "second"]);
});

it.each(["openai", "anthropic", "gemini", "openrouter", "deepseek", "custom"])("%s Test calls its real chat protocol after listing models", async provider => {
  const calls: { url: string; body: Record<string, unknown> | null; headers: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null, headers: init.headers as Record<string, string> });
    if (!init.body) return provider === "gemini" ? json({ models: [{ name: "models/fixture-model" }] }) : json({ data: [{ id: "fixture-model" }] });
    if (provider === "anthropic") return json({ content: [{ type: "text", text: '{"ok":true}' }] });
    if (provider === "gemini") return json({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] });
    return success();
  }));
  const tested = await testProviderChat({ ...config, provider }, key);
  expect(tested.ok).toBe(true);
  expect(tested.chatOk).toBe(true);
  expect(calls).toHaveLength(2);
  expect(calls[0].body).toBeNull();
  expect(calls[1].body).not.toBeNull();
  const expected = provider === "anthropic" ? "/v1/messages" : provider === "gemini" ? "/v1beta/models/fixture-model:generateContent" : "/v1/chat/completions";
  expect(calls[1].url).toBe(`${config.baseUrl}${expected}`);
  if (provider === "anthropic") expect(calls[1].headers["x-api-key"]).toBe(key);
  else if (provider === "gemini") expect(calls[1].headers["x-goog-api-key"]).toBe(key);
  else expect(calls[1].headers.Authorization).toBe(`Bearer ${key}`);
});

it("Test fails when model discovery works but chat returns 400", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit = {}) => init.body ? json({ error: { code: "invalid_request" } }, 400) : json({ data: [{ id: config.model }] })));
  expect(await testProviderChat(config, key)).toMatchObject({ ok: false, chatOk: false, code: "http_error" });
});
