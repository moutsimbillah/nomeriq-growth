import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestProviderChat, safeProviderError, type ChatInput } from "@/lib/ai/chat-transport";
import { runChatTask } from "@/lib/ai/registry";
import { encryptSecret } from "@/lib/auth/crypto";
import type { DbClient } from "@/lib/db/client";

const config = { provider: "custom", baseUrl: "https://synthetic.example.test", model: "synthetic-model" };
const placeholder = "synthetic-transport-placeholder";
const input: ChatInput = { system: "Synthetic system", user: "Synthetic context", timeoutMs: 120_000, transientRetries: 2 };
const json = (payload: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), { status, headers });
const success = () => json({ choices: [{ message: { content: "Synthetic answer" } }] });
const errorResponse = (status: number, code = "invalid_request", headers: Record<string, string> = {}) =>
  json({ error: { code, message: "Private synthetic response text" } }, status, headers);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function settle<T>(pending: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return pending;
}

describe("suggestion transient retries are opt-in, bounded and independent of compatibility", () => {
  it("retries temporary rate-limit once after one second, then succeeds", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(errorResponse(429, "rate_limit_exceeded")).mockImplementationOnce(success);
    vi.stubGlobal("fetch", fetcher);
    const pending = requestProviderChat(config, placeholder, input);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ ok: true, text: "Synthetic answer" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not add transient retries or diagnostics to existing callers", async () => {
    const logger = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetcher = vi.fn(async () => errorResponse(429, "rate_limit_exceeded"));
    vi.stubGlobal("fetch", fetcher);
    expect(await requestProviderChat(config, placeholder, { system: "s", user: "u" })).toMatchObject({ ok: false, code: "rate_limit" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(logger).not.toHaveBeenCalled();
  });

  it("allows the suggestion's longer deadline and gives a fresh controller to its retry", async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn((_url: unknown, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return signals.length === 1 ? new Promise<Response>(() => undefined) : Promise.resolve(success());
    });
    vi.stubGlobal("fetch", fetcher);
    const pending = requestProviderChat(config, placeholder, input);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signals[0].aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ ok: true });
    expect(signals[1]).not.toBe(signals[0]);
    expect(signals[1].aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["AbortError", "TimeoutError", "TypeError"])("retries a temporary %s without logging exception text", async name => {
    const error = new Error("Private synthetic exception"); error.name = name;
    const fetcher = vi.fn().mockRejectedValueOnce(error).mockImplementationOnce(success);
    vi.stubGlobal("fetch", fetcher);
    expect(await settle(requestProviderChat(config, placeholder, input))).toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([408, 500, 503])("retries temporary HTTP %s", async status => {
    const fetcher = vi.fn().mockResolvedValueOnce(errorResponse(status)).mockImplementationOnce(success);
    vi.stubGlobal("fetch", fetcher);
    expect(await settle(requestProviderChat(config, placeholder, input))).toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("classifies a provider rate code even without HTTP 429", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(errorResponse(400, "rate_limit_error")).mockImplementationOnce(success);
    vi.stubGlobal("fetch", fetcher);
    expect(await settle(requestProviderChat(config, placeholder, input))).toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves all attempts on exhaustion and clamps requested retries to two", async () => {
    const fetcher = vi.fn(async () => errorResponse(503, "server_error"));
    vi.stubGlobal("fetch", fetcher);
    const started = Date.now();
    const result = await settle(requestProviderChat(config, placeholder, { ...input, transientRetries: 99 }));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(Date.now() - started).toBe(3000);
    expect(result).toMatchObject({ ok: false, code: "provider_error", status: 503, providerCode: "server_error",
      failures: [1, 2, 3].map(attempt => ({ code: "provider_error", provider: "custom", attempt, status: 503, elapsedMs: 0, providerCode: "server_error" })) });
    expect(JSON.stringify(result)).not.toContain("Private synthetic");
  });

  it.each([
    ["4", 4000], ["9999", 10_000], ["invalid", 1000],
    ["Thu, 01 Jan 2026 00:00:05 GMT", 5000],
  ] as const)("respects bounded Retry-After %s", async (header, delay) => {
    const fetcher = vi.fn().mockResolvedValueOnce(errorResponse(429, "rate_limit_exceeded", { "Retry-After": header })).mockImplementationOnce(success);
    vi.stubGlobal("fetch", fetcher);
    const started = Date.now();
    expect(await settle(requestProviderChat(config, placeholder, input))).toMatchObject({ ok: true });
    expect(Date.now() - started).toBe(delay);
  });

  it("keeps the optional-field retry separate from the two transient retries", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) return errorResponse(429, "rate_limit_exceeded");
      if (bodies.length === 2) return json({ error: { code: "unsupported_parameter", param: "response_format" } }, 400);
      if (bodies.length === 3) return errorResponse(503, "server_error");
      return success();
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await settle(requestProviderChat(config, placeholder, { ...input, json: true }))).toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(bodies[1].response_format).toBeDefined();
    expect(bodies[2].response_format).toBeUndefined();
    expect(bodies[3].messages).toEqual(bodies[0].messages);
  });
});

describe("permanent, auth, quota, context and invalid responses never retry", () => {
  it.each([
    [400, "invalid_request", "http_error"],
    [401, "invalid_api_key", "http_error"],
    [403, "permission_error", "http_error"],
    [402, "invalid_request", "quota_exceeded"],
    [413, "invalid_request", "context_size"],
    [400, "context_length_exceeded", "context_size"],
    [500, "context_window_exceeded", "context_size"],
    [429, "insufficient_quota", "quota_exceeded"],
    [500, "authentication_error", "http_error"],
  ])("does not retry HTTP %s / %s", async (status, providerCode, code) => {
    const fetcher = vi.fn(async () => errorResponse(Number(status), String(providerCode)));
    vi.stubGlobal("fetch", fetcher);
    expect(await settle(requestProviderChat(config, placeholder, input))).toMatchObject({ ok: false, code, status, providerCode });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not mistake quota message on a generic 429 for a temporary rate limit", async () => {
    const fetcher = vi.fn(async () => json({ error: { code: "rate_limit_exceeded", message: "Synthetic quota exhausted" } }, 429));
    vi.stubGlobal("fetch", fetcher);
    expect(await settle(requestProviderChat(config, placeholder, input))).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["not JSON", "null", '{"choices":[]}', '{"choices":[{"message":{"content":4}}]}'])("does not retry invalid response %s", async raw => {
    const fetcher = vi.fn(async () => new Response(raw));
    vi.stubGlobal("fetch", fetcher);
    const result = await settle(requestProviderChat(config, placeholder, input));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["invalid_response_json", "invalid_response", "empty_response"]).toContain(result.code);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not expose an arbitrary string masquerading as a provider code", async () => {
    const fetcher = vi.fn(async () => errorResponse(400, placeholder));
    vi.stubGlobal("fetch", fetcher);
    const result = await requestProviderChat(config, placeholder, input);
    expect(JSON.stringify(result)).not.toContain(placeholder);
    expect(safeProviderError({ error: { code: "private_synthetic_identifier" } }).code).toBeNull();
  });
});

describe("the per-attempt deadline covers response bodies, not just headers", () => {
  it.each([200, 429, 401])("times out a stalled HTTP %s body and cancels the reader", async status => {
    const cancel = vi.fn();
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":')); }, cancel,
      }), { status });
    });
    vi.stubGlobal("fetch", fetcher);
    const pending = requestProviderChat(config, placeholder, { ...input, transientRetries: 0 });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ ok: false, code: "request_timeout", status, elapsedMs: 120_000 });
    expect(signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers from a stalled SSE body using a fresh attempt", async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn().mockImplementationOnce(async () => new Response(new ReadableStream({ cancel })))
      .mockImplementationOnce(success);
    vi.stubGlobal("fetch", fetcher);
    expect(await settle(requestProviderChat(config, placeholder, input))).toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not retry auth even when its error body times out", async () => {
    const fetcher = vi.fn(async () => new Response(new ReadableStream({}), { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await settle(requestProviderChat(config, placeholder, input))).toMatchObject({ ok: false, code: "request_timeout", status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("classifies SSE rate errors and rejects partial output before retrying", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(
      'data: {"choices":[{"delta":{"content":"Discard this partial output"}}]}\n\ndata: {"error":{"code":"rate_limit_exceeded"}}\n\n'))
      .mockImplementationOnce(success);
    vi.stubGlobal("fetch", fetcher);
    expect(await settle(requestProviderChat(config, placeholder, input))).toMatchObject({ ok: true, text: "Synthetic answer" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

it("emits only opt-in code/timing records on failure and success", async () => {
  const logger = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const fetcher = vi.fn().mockResolvedValueOnce(errorResponse(429, "rate_limit_exceeded")).mockImplementationOnce(success);
  vi.stubGlobal("fetch", fetcher);
  expect(await settle(requestProviderChat(config, placeholder, { ...input, diagnosticTask: "suggest_reply" }))).toMatchObject({ ok: true });
  expect(logger.mock.calls).toEqual([
    ["ai_chat_attempt", { task: "suggest_reply", provider: "custom", attempt: 1, status: 429, code: "rate_limit", elapsed_ms: 0, context_chars: input.system.length + input.user.length }],
    ["ai_chat_attempt", { task: "suggest_reply", provider: "custom", attempt: 2, status: 200, code: "success", elapsed_ms: 0, context_chars: input.system.length + input.user.length }],
  ]);
  const logs = JSON.stringify(logger.mock.calls);
  for (const privateValue of [placeholder, input.system, input.user, config.baseUrl, config.model, "Private synthetic"]) expect(logs).not.toContain(privateValue);
});

it("keeps structured failures across registry failover behind all_providers_failed", async () => {
  const rows = ["custom", "openai"].map((provider, index) => ({
    id: `synthetic-id-${index}`, name: `Synthetic private provider ${index}`, provider, kinds: "chat", model: "synthetic-model",
    base_url: "https://synthetic.example.test", search_path: null, fetch_path: null, priority: index,
    is_enabled: true, last_test_ok: true, encrypted_api_key: encryptSecret(placeholder),
  }));
  const runner = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM ai_task_settings")) return { rows: [{ provider_id: rows[0].id, model: null, search_provider_id: null }] };
    if (sql.includes("FROM ai_task_fallbacks")) return { rows: [] };
    if (sql.includes("WHERE id = $1")) return { rows: rows.filter(row => row.id === values?.[0]) };
    return { rows };
  }) } as unknown as DbClient;
  const logger = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const fetcher = vi.fn(async () => errorResponse(503, "server_error"));
  vi.stubGlobal("fetch", fetcher);
  const result = await settle(runChatTask("suggest_reply", { ...input, diagnosticTask: "suggest_reply" }, runner));
  expect(result).toMatchObject({ ok: false, code: "all_providers_failed" });
  if (result.ok) throw new Error("Expected synthetic failure");
  expect(result.failures).toEqual(rows.flatMap(row => [1, 2, 3].map(attempt => ({
    code: "provider_error", provider: row.provider, attempt, status: 503, elapsedMs: 0, providerCode: "server_error",
  }))));
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect(logger).toHaveBeenCalledTimes(6);
  const diagnostics = JSON.stringify([result.failures, logger.mock.calls]);
  for (const row of rows) { expect(diagnostics).not.toContain(row.name); expect(diagnostics).not.toContain(row.id); }
  expect(JSON.stringify(result)).not.toContain(placeholder);
});
