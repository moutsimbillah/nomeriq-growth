import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deepseekSearch,
  deepseekFetchPage,
  listDeepSeekModels,
  testDeepSeekConnection,
  cleanBaseUrl,
  type DeepSeekConfig,
} from "@/lib/deepseek/provider";

/**
 * These tests pin the exact URLs the adapter calls.
 *
 * The DeepSeek documentation presents the base URL as `https://api.deepseek.com`
 * for some endpoints and `https://api.deepseek.com/v1` for the OpenAI-compatible
 * ones. Both are valid for a human to paste into Settings, so the adapter must
 * accept either without producing a doubled `/v1/v1` path — which the real API
 * answers with a bare 404 that surfaces to the founder as "not found".
 */

const config = (baseUrl: string): DeepSeekConfig => ({
  apiKey: "test-key",
  baseUrl,
  model: "deepseek-flash",
  source: "database",
});

type Captured = { url: string; method: string };

function stubFetch(
  handler: (url: string) => { status: number; body: unknown },
): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
    const href = String(url);
    calls.push({ url: href, method: String(init.method ?? "GET") });
    const { status, body } = handler(href);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DeepSeek base URL handling", () => {
  it("normalises a /v1 base URL to the canonical origin", () => {
    // A founder copying the base URL straight from the DeepSeek docs will very
    // often include /v1. It must not produce /v1/v1/... paths.
    expect(cleanBaseUrl("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com");
    expect(cleanBaseUrl("https://api.deepseek.com/v1/")).toBe("https://api.deepseek.com");
    expect(cleanBaseUrl("https://api.deepseek.com")).toBe("https://api.deepseek.com");
    expect(cleanBaseUrl("https://api.deepseek.com/")).toBe("https://api.deepseek.com");
  });

  it("calls Search at /v1/tools/search for either base URL spelling", async () => {
    for (const base of ["https://api.deepseek.com", "https://api.deepseek.com/v1"]) {
      const calls = stubFetch(() => ({ status: 200, body: { results: [] } }));
      await deepseekSearch(config(cleanBaseUrl(base)), { query: "gold signals", qps: 100 });
      expect(calls[0].url).toBe("https://api.deepseek.com/v1/tools/search");
      vi.unstubAllGlobals();
    }
  });

  it("calls Fetch at /v1/tools/fetch for either base URL spelling", async () => {
    for (const base of ["https://api.deepseek.com", "https://api.deepseek.com/v1"]) {
      const calls = stubFetch(() => ({ status: 200, body: { content: "ok" } }));
      await deepseekFetchPage(config(cleanBaseUrl(base)), {
        url: "https://example.com/",
        qps: 100,
      });
      expect(calls[0].url).toBe("https://api.deepseek.com/v1/tools/fetch");
      vi.unstubAllGlobals();
    }
  });

  it("never produces a doubled /v1 path anywhere", async () => {
    const calls = stubFetch((url) =>
      url.includes("/tools/search")
        ? { status: 200, body: { results: [{ url: "https://example.com/", title: "x" }] } }
        : url.includes("/tools/fetch")
          ? { status: 200, body: { content: "page" } }
          : { status: 200, body: { data: [{ id: "deepseek-flash" }] } },
    );
    const cfg = config(cleanBaseUrl("https://api.deepseek.com/v1"));
    await listDeepSeekModels(cfg);
    await deepseekSearch(cfg, { query: "forex signals", qps: 100 });
    await deepseekFetchPage(cfg, { url: "https://example.com/", qps: 100 });
    for (const call of calls) {
      expect(call.url).not.toMatch(/\/v1\/v1/);
    }
  });
});

describe("DeepSeek connection test errors", () => {
  it("names the failing call instead of reporting a bare 'not found'", async () => {
    // The real API answers an unknown path with a minimal 404 body. The founder
    // must be told which step failed and against which URL.
    stubFetch(() => ({ status: 404, body: { error: { message: "not found" } } }));
    const cfg = config("https://api.deepseek.com");
    await expect(testDeepSeekConnection(cfg)).rejects.toThrow(/models/i);
  });

  it("includes the URL and a base-URL hint when a step 404s", async () => {
    stubFetch(() => ({ status: 404, body: { error: { message: "not found" } } }));
    const cfg = config("https://api.deepseek.com");
    let message = "";
    try {
      await testDeepSeekConnection(cfg);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/https:\/\/api\.deepseek\.com\/models/);
    expect(message).toMatch(/base url/i);
  });
});
