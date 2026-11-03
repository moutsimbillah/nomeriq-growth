import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanBaseUrl,
  isValidModelName,
  testDeepSeekConnection,
  type DeepSeekConfig,
} from "@/lib/deepseek/provider";

/**
 * Custom DeepSeek-compatible endpoints.
 *
 * Two problems were reported while setting up a custom provider:
 *
 *   1. "it should support custom model" — the model-name validator only allowed
 *      [a-z0-9._-], which rejects every vendor-prefixed identifier used by
 *      OpenAI-compatible relays: `deepseek/deepseek-chat`, `openai/gpt-4o`,
 *      `meta-llama/Llama-3.3-70B-Instruct`.
 *
 *   2. A custom host that serves /models and /chat/completions but not
 *      DeepSeek's proprietary /v1/tools/search was told "the base URL is wrong —
 *      it should be https://api.deepseek.com". That is misleading: the founder
 *      deliberately chose a custom endpoint, and the endpoint is reachable. What
 *      is actually missing is DeepSeek's Search/Fetch tools.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("custom model names", () => {
  it("accepts vendor-prefixed identifiers used by OpenAI-compatible relays", () => {
    const models = [
      "deepseek-flash",
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-v4-pro",
      "deepseek/deepseek-chat",
      "deepseek-ai/DeepSeek-V3",
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
      "anthropic/claude-3.5-sonnet",
      "google/gemini-2.0-flash",
      "meta-llama/Llama-3.3-70B-Instruct",
      "qwen/qwen-2.5-72b-instruct",
      "mistralai/mistral-large",
      "gpt-4o-mini",
      "claude-sonnet-4-5",
    ];
    for (const model of models) {
      expect(isValidModelName(model), `should accept ${model}`).toBe(true);
    }
  });

  it("still rejects names that would break the request body", () => {
    // Whitespace, quotes, braces and control characters must never reach the API.
    for (const bad of [
      "",
      " ",
      "a",
      "deepseek chat",
      'gpt"4',
      "model}",
      "model\ninjection",
      "x".repeat(200),
      "<script>",
      "model;drop",
    ]) {
      expect(isValidModelName(bad), `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe("custom endpoint diagnostics", () => {
  function config(baseUrl: string, model = "deepseek/deepseek-chat"): DeepSeekConfig {
    return { apiKey: "sk-test", baseUrl: cleanBaseUrl(baseUrl), model, source: "database" };
  }

  /** A generic OpenAI-compatible relay: models + chat exist, DeepSeek tools do not. */
  function stubRelay() {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const href = String(url);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (href.endsWith("/models")) {
        return json(200, { data: [{ id: "deepseek/deepseek-chat" }] });
      }
      if (href.includes("/chat/completions")) {
        return json(200, { choices: [{ message: { content: "{}" } }], usage: {} });
      }
      // /v1/tools/search and /v1/tools/fetch are not implemented by the relay.
      return json(404, { error: { message: "Not found", type: "not_found" } });
    });
  }

  it("does not tell a founder their custom base URL is 'wrong' when the host is reachable", async () => {
    stubRelay();
    let message = "";
    try {
      await testDeepSeekConnection(config("https://vyceai.com"));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // It must name the step and the URL.
    expect(message).toMatch(/Search/);
    expect(message).toContain("https://vyceai.com/v1/tools/search");
    // It must NOT claim the base URL should be the official DeepSeek host.
    expect(message).not.toMatch(/it should be https:\/\/api\.deepseek\.com/);
    // It MUST explain that this host lacks DeepSeek's Search/Fetch tools.
    expect(message).toMatch(/tools\/search|Search and Fetch|DeepSeek's Search/i);
  });

  it("still suggests the official base URL when the official host itself 404s", async () => {
    // A genuine misconfiguration against the real DeepSeek host should keep the
    // original, correct hint — the fix must not remove it.
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ error: { message: "not found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    let message = "";
    try {
      await testDeepSeekConnection(config("https://api.deepseek.com"));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/it should be https:\/\/api\.deepseek\.com/);
  });

  it("reports which capabilities a custom endpoint supports", async () => {
    // Create a relay that DOES implement DeepSeek's tools, to prove the test
    // reports success rather than assuming a custom host cannot work.
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const href = String(url);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (href.endsWith("/models")) return json(200, { data: [{ id: "deepseek/flash" }] });
      if (href.includes("/v1/tools/search")) {
        return json(200, {
          results: [{ url: "https://publisher.example.com/", title: "Publisher" }],
        });
      }
      if (href.includes("/v1/tools/fetch")) return json(200, { content: "page text" });
      return json(404, { error: { message: "Not found" } });
    });

    const result = await testDeepSeekConnection(config("https://proxy.example.com"));
    expect(result.ok).toBe(true);
    expect(result.searchOk).toBe(true);
    expect(result.fetchOk).toBe(true);
    expect(result.message).toMatch(/Search/);
  });

  it("passes the custom model through to the chat request unchanged", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (body.model) seen.push(body.model);
      const href = String(url);
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (href.endsWith("/models")) return json(200, { data: [{ id: "deepseek/flash" }] });
      if (href.includes("/v1/tools/search")) {
        return json(200, { results: [{ url: "https://p.example.com/", title: "P" }] });
      }
      if (href.includes("/v1/tools/fetch")) return json(200, { content: "text" });
      // A valid completion: the adapter requires non-empty JSON content.
      return json(200, {
        model: body.model,
        choices: [{ message: { role: "assistant", content: "{}" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    });

    const { deepseekChatJson } = await import("@/lib/deepseek/provider");
    const result = await deepseekChatJson(
      config("https://proxy.example.com", "deepseek/deepseek-chat"),
      { system: "Return JSON.", user: "Return {}" },
    );
    // The vendor-prefixed name must survive verbatim into the request body.
    expect(seen).toContain("deepseek/deepseek-chat");
    expect(result.data).toEqual({});
  });

  it("explains an insufficient balance as a billing problem, not a config problem", async () => {
    // Reproduced from a real report: Search failed with "Insufficient Balance".
    // The key and URL were correct, so the message must not suggest changing them.
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const href = String(url);
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (href.endsWith("/models")) return json(200, { data: [{ id: "deepseek-flash" }] });
      return json(402, {
        error: { message: "Insufficient Balance", type: "insufficient_balance" },
      });
    });

    let message = "";
    try {
      await testDeepSeekConnection(config("https://api.deepseek.com"));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/Insufficient Balance/);
    expect(message).toMatch(/balance/i);
    // The base URL and key are fine; do not send the founder chasing them.
    expect(message).not.toMatch(/it should be https:\/\/api\.deepseek\.com/);
    expect(message).toMatch(/billed per successful request/i);
  });

  it("tells a founder to check the key on 401, without blaming the URL", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ error: { message: "Authentication Fails" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    let message = "";
    try {
      await testDeepSeekConnection(config("https://api.deepseek.com"));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/Authentication Fails/);
    expect(message).toMatch(/API key is correct/i);
    expect(message).not.toMatch(/it should be https:\/\/api\.deepseek\.com/);
  });
});
