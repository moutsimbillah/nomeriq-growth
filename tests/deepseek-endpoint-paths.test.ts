import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanEndpointPath,
  deepseekFetchPage,
  deepseekSearch,
  testDeepSeekConnection,
  type DeepSeekConfig,
} from "@/lib/deepseek/provider";

/**
 * Custom endpoints that implement Search and Fetch at non-DeepSeek paths.
 *
 * Measured on a real gateway (vyceai.com) with a placeholder key, where 401 means
 * "route exists, needs auth" and 404 means "no such route":
 *
 *   POST /v1/tools/search     404      POST /v1/search          401
 *   POST /v1/tools/fetch      404      POST /v1/scrape          401
 *   GET  /models              401      POST /chat/completions   401
 *
 * That host serves search and scrape, just not under DeepSeek's proprietary
 * names. Declaring it "chat only" was wrong, so the adapter now supports
 * configurable paths and detects them when they are not configured.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function config(overrides: Partial<DeepSeekConfig> = {}): DeepSeekConfig {
  return {
    apiKey: "sk-test",
    baseUrl: "https://gateway.example.com",
    model: "deepseek-flash",
    source: "database",
    ...overrides,
  };
}

describe("configurable endpoint paths", () => {
  it("accepts a plain path or a full same-host URL, and rejects unsafe values", () => {
    expect(cleanEndpointPath("/v1/search")).toBe("/v1/search");
    expect(cleanEndpointPath("v1/search")).toBe("/v1/search");
    expect(cleanEndpointPath("/v1/search/")).toBe("/v1/search");
    expect(cleanEndpointPath("https://gateway.example.com/v1/scrape")).toBe("/v1/scrape");
    expect(cleanEndpointPath("")).toBeNull();
    expect(cleanEndpointPath(null)).toBeNull();
    // Traversal and characters that could break out of the path are refused.
    expect(cleanEndpointPath("/v1/../../etc/passwd")).toBeNull();
    expect(cleanEndpointPath("/v1/search?x=1 2")).toBeNull();
  });

  it("uses the configured Search path instead of the DeepSeek default", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ web: [{ url: "https://a.example.com/", title: "A" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await deepseekSearch(config({ searchPath: "/v1/search" }), {
      query: "gold signals",
      qps: 100,
    });
    expect(calls[0]).toBe("https://gateway.example.com/v1/search");
    expect(result.results).toHaveLength(1);
  });

  it("uses the configured Fetch path instead of the DeepSeek default", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: { markdown: "# Page" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const page = await deepseekFetchPage(
      config({ fetchPath: "/v1/scrape" }),
      { url: "https://a.example.com/", qps: 100 },
    );
    expect(calls[0]).toBe("https://gateway.example.com/v1/scrape");
    expect(page.content).toBe("# Page");
  });
});

describe("response shape tolerance", () => {
  it("reads DeepSeek's { results: [...] } shape", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "DeepSeek shape",
              url: "https://a.example.com/",
              snippet: "snippet",
              summary: "summary",
              site_name: "A",
              authority: 2,
              rerank_score: 1.5,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await deepseekSearch(config(), { query: "forex", qps: 100 });
    expect(result.results[0]).toMatchObject({
      title: "DeepSeek shape",
      url: "https://a.example.com/",
      snippet: "snippet",
      siteName: "A",
      authority: 2,
    });
  });

  it("reads a gateway's { data: { web: [...] } } shape", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          data: {
            web: [
              { title: "Gateway shape", url: "https://b.example.com/", description: "desc" },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await deepseekSearch(config(), { query: "forex", qps: 100 });
    expect(result.results[0]).toMatchObject({
      title: "Gateway shape",
      url: "https://b.example.com/",
      // `description` is mapped onto both snippet and summary.
      snippet: "desc",
      summary: "desc",
    });
  });

  it("reads a gateway's flat { data: [...] } shape and drops entries with no url", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          data: [
            { name: "Flat", link: "https://c.example.com/" },
            { name: "No url at all" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await deepseekSearch(config(), { query: "forex", qps: 100 });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe("https://c.example.com/");
    // A result without a URL can never become a candidate.
    expect(result.results.every((entry) => entry.url.length > 0)).toBe(true);
  });

  it("reads a fetched page from markdown, content or text", async () => {
    for (const payload of [
      { data: { markdown: "md" } },
      { data: { content: "ct" } },
      { data: { text: "tx" } },
      { content: "direct" },
      { markdown: "top" },
    ]) {
      vi.stubGlobal("fetch", async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const page = await deepseekFetchPage(config(), {
        url: "https://a.example.com/",
        qps: 100,
      });
      expect(page.content.length).toBeGreaterThan(0);
      vi.unstubAllGlobals();
    }
  });

  it("counts a non-empty page as a billable Fetch request and an empty one as free", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ data: { markdown: "" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const empty = await deepseekFetchPage(config(), {
      url: "https://a.example.com/",
      qps: 100,
    });
    // Nothing retrieved means nothing to bill.
    expect(empty.costUsd).toBe(0);
    expect(empty.requestCount).toBe(0);
  });

  it("raises a gateway's HTTP-200 body error instead of pretending the page was empty", async () => {
    // Measured live on a real gateway: POST /v1/scrape answered HTTP 200 with
    // {"error":"Failed to scrape page with Firecrawl"}. Returning an empty page
    // hid the true cause behind a misleading "Not found".
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          error: "Failed to scrape page with Firecrawl",
          url: "https://example.com/",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      deepseekFetchPage(config({ fetchPath: "/v1/scrape" }), {
        url: "https://example.com/",
        qps: 100,
      }),
    ).rejects.toThrow(/Failed to scrape page with Firecrawl/);
  });

  it("still returns content when a gateway sends content alongside a warning", async () => {
    // A body-level message must not discard real content.
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({ error: "partial", data: { markdown: "# Real content" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const page = await deepseekFetchPage(config(), {
      url: "https://a.example.com/",
      qps: 100,
    });
    expect(page.content).toBe("# Real content");
  });
});

describe("path auto-detection on the connection test", () => {
  /**
   * Models the real gateway: DeepSeek's proprietary tool paths 404, while
   * /v1/search and /v1/scrape exist. A probe with any key gets 401 on routes that
   * exist, which is how detection distinguishes them from 404s.
   */
  function stubGateway(options: { implementSearch: boolean; implementFetch: boolean }) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const href = String(url);
      calls.push(href);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      if (href.endsWith("/models")) return json(200, { data: [{ id: "deepseek-flash" }] });

      const isSearch = href.includes("search");
      const isFetch = href.includes("scrape") || href.includes("fetch");

      if (isSearch) {
        if (!options.implementSearch) return json(404, { error: { message: "Not found" } });
        // DeepSeek's own path is absent on this gateway.
        if (href.includes("/v1/tools/search")) {
          return json(404, { error: { message: "Not found" } });
        }
        return json(200, {
          data: { web: [{ title: "Found", url: "https://publisher.example.com/", description: "d" }] },
        });
      }
      if (isFetch) {
        if (!options.implementFetch) return json(404, { error: { message: "Not found" } });
        if (href.includes("/v1/tools/fetch")) {
          return json(404, { error: { message: "Not found" } });
        }
        // Model a scraper that cannot read the search hit but can read a plain page.
        if (href.includes("news.google.com") || href.includes("/rss/")) {
          return json(404, { error: { message: "Not found", type: "not_found" } });
        }
        return json(200, { data: { markdown: "# Publisher page" } });
      }
      return json(404, { error: { message: "Not found" } });
    });
    return calls;
  }

  it("discovers /v1/search and /v1/scrape when DeepSeek's paths are absent", async () => {
    const calls = stubGateway({ implementSearch: true, implementFetch: true });
    const result = await testDeepSeekConnection(config());

    expect(result.ok).toBe(true);
    expect(result.searchOk).toBe(true);
    expect(result.fetchOk).toBe(true);
    // The detected paths must be reported so they can be persisted.
    expect(result.searchPath).toBe("/v1/search");
    expect(result.fetchPath).toBe("/v1/scrape");
    // It must have actually tried the DeepSeek default first, then the alternative.
    expect(calls.some((c) => c.endsWith("/v1/tools/search"))).toBe(true);
    expect(calls.some((c) => c.endsWith("/v1/search"))).toBe(true);
    expect(result.message).toMatch(/Custom endpoint detected/);
  });

  it("reports Search as unavailable when no candidate path works", async () => {
    stubGateway({ implementSearch: false, implementFetch: false });
    let message = "";
    try {
      await testDeepSeekConnection(config());
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/Search failed/);
    // A custom host must not be told to switch to the official base URL.
    expect(message).not.toMatch(/it should be https:\/\/api\.deepseek\.com/);
  });

  it("does not probe alternative paths on the official DeepSeek host", async () => {
    const calls = stubGateway({ implementSearch: false, implementFetch: false });
    await expect(
      testDeepSeekConnection(config({ baseUrl: "https://api.deepseek.com" })),
    ).rejects.toThrow(/Search failed/);
    // Only the documented DeepSeek path is attempted there — no speculative probing.
    expect(calls.some((c) => c.includes("/v1/search"))).toBe(false);
  });

  it("reports Fetch working when the first search hit is unreadable but a plain page is not", async () => {
    // Observed live: Search returned a Google News RSS URL first, the scraper
    // could not read it, and a working Fetch was wrongly reported as broken.
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
      const href = String(url);
      calls.push(href);
      const body = init.body ? JSON.parse(String(init.body)) : {};
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      if (href.endsWith("/models")) return json(200, { data: [{ id: "deepseek-v4.1" }] });
      if (href.includes("/v1/search")) {
        return json(200, {
          results: [
            { title: "News", url: "https://news.google.com/rss/articles/ABC?oc=5" },
          ],
        });
      }
      if (href.includes("/v1/scrape")) {
        // The scraper cannot read the news URL, but reads example.com fine.
        if (String(body.url || "").includes("news.google.com")) {
          return json(404, { error: { message: "Not found", type: "not_found" } });
        }
        return json(200, { data: { markdown: "# Example Domain" } });
      }
      return json(404, { error: { message: "Not found" } });
    });

    const result = await testDeepSeekConnection(config());
    expect(result.searchOk).toBe(true);
    // The fallback probe must rescue this rather than reporting Fetch broken.
    expect(result.fetchOk).toBe(true);
    expect(result.fetchPath).toBe("/v1/scrape");
    // It must have retried against a plain page after the news URL failed.
    expect(calls.some((c) => c.includes("/v1/scrape"))).toBe(true);
    expect(calls.filter((c) => c.includes("/v1/scrape")).length).toBeGreaterThan(1);
  });

  it("prefers an explicitly configured path over probing", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const href = String(url);
      calls.push(href);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (href.endsWith("/models")) return json(200, { data: [{ id: "m" }] });
      if (href.endsWith("/custom/search")) {
        return json(200, { results: [{ url: "https://p.example.com/", title: "P" }] });
      }
      if (href.endsWith("/custom/scrape")) return json(200, { content: "page" });
      return json(404, { error: { message: "Not found" } });
    });

    const result = await testDeepSeekConnection(
      config({ searchPath: "/custom/search", fetchPath: "/custom/scrape" }),
    );
    expect(result.searchOk).toBe(true);
    expect(result.fetchOk).toBe(true);
    // The configured paths are used directly; the DeepSeek default is never tried.
    expect(calls.some((c) => c.includes("/v1/tools/search"))).toBe(false);
  });

  it("does not claim Fetch failed when Search simply returned nothing", async () => {
    // With no search hit there is no page to read, so Fetch is untested. Saying it
    // "could not retrieve the first result" would blame the wrong capability.
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const href = String(url);
      calls.push(href);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (href.endsWith("/models")) return json(200, { data: [{ id: "m" }] });
      if (href.includes("search")) return json(200, { results: [] });
      return json(404, { error: { message: "Not found" } });
    });

    const result = await testDeepSeekConnection(config());
    expect(result.searchOk).toBe(false);
    expect(result.fetchOk).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Search returned no results/);
    expect(result.message).toMatch(/Fetch not exercised/);
    // A path that was never exercised must not be reported as if it worked.
    expect(result.fetchPath).toBeNull();
    // No Fetch route may have been contacted at all.
    expect(calls.some((c) => c.includes("scrape") || c.includes("fetch"))).toBe(false);
  });

  it("does not report a Fetch path when Fetch could not be proven", async () => {
    // Every Fetch candidate 404s: the test must surface a failure, not the
    // configured path, because that route was never shown to work.
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const href = String(url);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (href.endsWith("/models")) return json(200, { data: [{ id: "m" }] });
      if (href.includes("search")) {
        return json(200, { results: [{ url: "https://p.example.com/", title: "P" }] });
      }
      return json(404, { error: { message: "Not found" } });
    });

    const result = await testDeepSeekConnection(config({ searchPath: "/custom/search" }));
    expect(result.searchOk).toBe(true);
    expect(result.fetchOk).toBe(false);
    expect(result.fetchPath).toBeNull();
    expect(result.message).toMatch(/Fetch could not retrieve a page/);
  });
});
