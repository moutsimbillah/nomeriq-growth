import { afterEach, expect, it, vi } from "vitest";
import { extractChatUsage } from "@/lib/ai/chat-usage";
import { requestProviderChat } from "@/lib/ai/chat-transport";

afterEach(() => vi.unstubAllGlobals());
const config = { provider: "custom", baseUrl: "https://synthetic.test", model: "glm-fixture" };
const input = { system: "Synthetic", user: "Synthetic", maxTokens: 100, json: true, captureUsage: true };

it("retains reported OpenAI-compatible usage without estimating absent counters", () => {
  expect(extractChatUsage("custom", JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 4 } })))
    .toEqual({ inputTokens: 12, outputTokens: 4, cachedInputTokens: null });
  expect(extractChatUsage("custom", JSON.stringify({ usage: { prompt_tokens: null, completion_tokens: "4" } }))).toBeNull();
  expect(extractChatUsage("custom", JSON.stringify({ usage: { prompt_tokens: 0, completion_tokens: 0 } })))
    .toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: null });
});
it("accepts cache counters only when actually reported", () => {
  expect(extractChatUsage("openai", JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 5 } } })))
    .toEqual({ inputTokens: 12, outputTokens: 4, cachedInputTokens: 5 });
  expect(extractChatUsage("deepseek", JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 4, prompt_cache_hit_tokens: 6 } })))
    .toEqual({ inputTokens: 12, outputTokens: 4, cachedInputTokens: 6 });
});
it("retains the terminal usage-only SSE chunk", () => {
  const raw = 'data: {"choices":[{"delta":{"content":"{}"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\ndata: [DONE]\n';
  expect(extractChatUsage("custom", raw)).toEqual({ inputTokens: 7, outputTokens: 3, cachedInputTokens: null });
});
it("combines Anthropic message-start and message-delta counters without summing cumulative output", () => {
  const raw = 'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":5,"cache_creation_input_tokens":2,"output_tokens":1}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":6}}\n';
  expect(extractChatUsage("anthropic", raw)).toEqual({ inputTokens: 17, cachedInputTokens: 5, outputTokens: 6 });
});
it("reads Gemini reported usage without claiming missing reasoning-token totals", () => {
  expect(extractChatUsage("gemini", JSON.stringify({ usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, cachedContentTokenCount: 2 } })))
    .toEqual({ inputTokens: 8, outputTokens: 3, cachedInputTokens: 2 });
});
it("research requests usage but does not turn an absent report into zero tokens", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
    expect(JSON.parse(String(init.body)).stream_options).toEqual({ include_usage: true });
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  }));
  expect(await requestProviderChat(config, crypto.randomUUID(), input)).toMatchObject({ ok: true, usage: null });
});
it("an explicit stream-options rejection preserves the token limit and actual usage", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); bodies.push(body);
    return body.stream_options
      ? Response.json({ error: { code: "unsupported_parameter", param: "stream_options" } }, { status: 400 })
      : Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 8, completion_tokens: 2 } });
  }));
  expect(await requestProviderChat(config, crypto.randomUUID(), input)).toMatchObject({ ok: true, usage: { inputTokens: 8, outputTokens: 2 } });
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toMatchObject({ max_tokens: 100, stream: true });
  expect(bodies[1].stream_options).toBeUndefined();
});
it("usage in a stream containing an error never makes partial output a success", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"{}"}}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: {"error":{"code":"server_error"}}\n')));
  expect(await requestProviderChat(config, crypto.randomUUID(), input)).toMatchObject({ ok: false });
});

it("never removes the final output-token bound when a gateway rejects both standard limit fields", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); bodies.push(body);
    return Response.json({ error: { code: "unsupported_parameter", param: body.max_tokens ? "max_tokens" : "max_completion_tokens" } }, { status: 400 });
  }));
  expect(await requestProviderChat(config, crypto.randomUUID(), input)).toMatchObject({ ok: false });
  expect(bodies).toHaveLength(2);
  expect(bodies.every(body => body.max_tokens === 100 || body.max_completion_tokens === 100)).toBe(true);
});
