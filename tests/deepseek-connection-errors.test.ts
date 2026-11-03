import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanBaseUrl,
  testDeepSeekConnection,
  type DeepSeekConfig,
} from "@/lib/deepseek/provider";

/**
 * Reproduces the exact failure a founder reported: "after configuration test
 * saying not found, no clear error showing".
 *
 * Two separate mistakes produce it, and both must now be impossible:
 *   1. Pasting the base URL as `https://api.deepseek.com/v1`, which the docs use
 *      for OpenAI compatibility. That produced `/v1/v1/tools/search`.
 *   2. A wrong/unreachable host, where the provider answers 404 and the old code
 *      surfaced the raw body text "not found" with no context.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubAll(status: number, body: unknown) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return calls;
}

function config(baseUrl: string): DeepSeekConfig {
  return {
    apiKey: "sk-test",
    baseUrl: cleanBaseUrl(baseUrl),
    model: "deepseek-flash",
    source: "database",
  };
}

describe("the reported 'not found' failure", () => {
  it("no longer doubles /v1 when the founder pastes the documented /v1 base URL", async () => {
    const calls = stubAll(200, {
      data: [{ id: "deepseek-flash" }],
      results: [{ url: "https://example.com/", title: "Example" }],
      content: "page",
    });
    const result = await testDeepSeekConnection(
      config("https://api.deepseek.com/v1"),
    );
    // The whole point: no request may go to /v1/v1/...
    for (const url of calls) {
      expect(url).not.toContain("/v1/v1");
    }
    expect(calls).toContain("https://api.deepseek.com/models");
    expect(calls).toContain("https://api.deepseek.com/v1/tools/search");
    expect(result.ok).toBe(true);
  });

  it("explains a 404 instead of repeating the provider's bare 'not found'", async () => {
    stubAll(404, { error: { message: "not found" } });
    let message = "";
    try {
      await testDeepSeekConnection(config("https://wrong-host.example.com"));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // It must say which step failed...
    expect(message).toMatch(/Model list/);
    // ...against which URL...
    expect(message).toContain("https://wrong-host.example.com/models");
    // ...and what the base URL should be.
    expect(message).toMatch(/base url/i);
    expect(message).toContain("https://api.deepseek.com");
    // And it must remain a single readable sentence, not a raw body dump.
    expect(message).not.toBe("not found");
  });

  it("names Search as the failing step when only the Search path 404s", async () => {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: { message: "not found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });

    let message = "";
    try {
      await testDeepSeekConnection(config("https://api.deepseek.com"));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/Search failed/);
    expect(message).toContain("/v1/tools/search");
  });

  it("reports an invalid API key distinctly from a wrong URL", async () => {
    stubAll(401, { error: { message: "Authentication Fails" } });
    let message = "";
    try {
      await testDeepSeekConnection(config("https://api.deepseek.com"));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/Authentication Fails/);
    // A 401 is not a path problem, so it must not suggest changing the base URL.
    expect(message).not.toMatch(/usually means the base URL is wrong/);
  });
});
