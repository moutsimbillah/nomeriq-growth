import { describe, expect, it } from "vitest";
import {
  discoverOfficialProfileLinks,
  isAllowedByRobots,
  isPublicHttpUrl,
  isSameSiteOrigin,
  MAX_FETCHES_PER_ORIGIN,
  MAX_FETCH_BACKOFF_MS,
  officialEvidenceUrls,
  publicUrlRefusal,
  reserveOriginFetch,
  type OriginFetchState,
} from "@/lib/deepseek/verify-candidate";

describe("isAllowedByRobots", () => {
  it("allows everything when robots.txt is absent, empty or unparsable", () => {
    expect(isAllowedByRobots({ robots: null, path: "/contact" })).toBe(true);
    expect(isAllowedByRobots({ robots: "", path: "/contact" })).toBe(true);
    expect(isAllowedByRobots({ robots: "not robots syntax at all", path: "/contact" })).toBe(true);
  });

  it("blocks a path an explicit wildcard Disallow covers", () => {
    const robots = "User-agent: *\nDisallow: /contact\n";
    expect(isAllowedByRobots({ robots, path: "/contact" })).toBe(false);
    expect(isAllowedByRobots({ robots, path: "/contact/form" })).toBe(false);
    expect(isAllowedByRobots({ robots, path: "/pricing" })).toBe(true);
  });

  it("an empty Disallow value means allow everything", () => {
    const robots = "User-agent: *\nDisallow:\n";
    expect(isAllowedByRobots({ robots, path: "/anything" })).toBe(true);
  });

  it("prefers the longest matching rule, Allow breaking a tie", () => {
    const robots = "User-agent: *\nDisallow: /pricing\nAllow: /pricing/public\n";
    expect(isAllowedByRobots({ robots, path: "/pricing/secret" })).toBe(false);
    expect(isAllowedByRobots({ robots, path: "/pricing/public" })).toBe(true);
  });

  it("prefers a group naming this bot by name over the wildcard group", () => {
    const robots = [
      "User-agent: *",
      "Disallow: /",
      "",
      "User-agent: NomeriqResearchBot",
      "Disallow:",
    ].join("\n");
    expect(isAllowedByRobots({ robots, path: "/contact" })).toBe(true);
  });

  it("a named group that disallows everything blocks even when the wildcard allows it", () => {
    const robots = [
      "User-agent: *",
      "Disallow:",
      "",
      "User-agent: NomeriqResearchBot",
      "Disallow: /",
    ].join("\n");
    expect(isAllowedByRobots({ robots, path: "/anything" })).toBe(false);
  });
});

describe("discoverOfficialProfileLinks", () => {
  const PAGE = "https://example.com/";

  it("finds an official Instagram, YouTube and Telegram link", () => {
    const links = discoverOfficialProfileLinks({
      html: `
        <a href="https://instagram.com/examplesignals">IG</a>
        <a href="https://youtube.com/@examplesignals">YT</a>
        <a href="https://t.me/examplesignals">TG</a>
      `,
      pageUrl: PAGE,
      limit: 10,
    });
    const platforms = links.map((l) => l.platform).sort();
    expect(platforms).toEqual(["instagram", "telegram", "youtube"]);
  });

  it("ignores a search/interstitial URL and a bare watch link", () => {
    const links = discoverOfficialProfileLinks({
      html: `
        <a href="https://instagram.com/explore/tags/forex">tag</a>
        <a href="https://youtube.com/watch?v=abc123">video</a>
        <a href="https://youtube.com/results?search_query=forex">search</a>
      `,
      pageUrl: PAGE,
      limit: 10,
    });
    expect(links).toHaveLength(0);
  });

  it("respects the limit", () => {
    const links = discoverOfficialProfileLinks({
      html: `
        <a href="https://instagram.com/a">a</a>
        <a href="https://youtube.com/@b">b</a>
        <a href="https://t.me/c">c</a>
      `,
      pageUrl: PAGE,
      limit: 1,
    });
    expect(links).toHaveLength(1);
  });

  it("never follows a plain off-domain link that is not a known profile host", () => {
    const links = discoverOfficialProfileLinks({
      html: `<a href="https://evil.example.net/">not a profile</a>`,
      pageUrl: PAGE,
      limit: 10,
    });
    expect(links).toHaveLength(0);
  });
});

describe("publicUrlRefusal", () => {
  it("allows ordinary public websites", () => {
    expect(publicUrlRefusal("https://signals.example.com/")).toBeNull();
    expect(publicUrlRefusal("http://sub.example.co.uk/pricing")).toBeNull();
    expect(publicUrlRefusal("https://t.me/examplesignals")).toBeNull();
  });

  it("refuses loopback, including the disguised forms a parser normalises", () => {
    // A decimal or hex literal is the classic way to smuggle 127.0.0.1 past a
    // string check; the URL parser resolves them, so they must still be caught.
    expect(publicUrlRefusal("http://127.0.0.1/")).toMatch(/loopback/);
    expect(publicUrlRefusal("http://127.1/")).toMatch(/loopback/);
    expect(publicUrlRefusal("http://2130706433/")).toMatch(/loopback/);
    expect(publicUrlRefusal("http://0x7f.1/")).toMatch(/loopback/);
    expect(publicUrlRefusal("http://[::1]/")).toMatch(/loopback/);
    expect(publicUrlRefusal("http://[::ffff:127.0.0.1]/")).toMatch(/loopback/);
    expect(publicUrlRefusal("http://localhost/")).toMatch(/internal host/);
  });

  it("refuses cloud metadata and other private ranges", () => {
    expect(publicUrlRefusal("http://169.254.169.254/latest/meta-data/")).toMatch(/link-local/);
    expect(publicUrlRefusal("http://10.0.0.5/")).toMatch(/private/);
    expect(publicUrlRefusal("http://192.168.1.1/")).toMatch(/private/);
    expect(publicUrlRefusal("http://172.16.0.1/")).toMatch(/private/);
    expect(publicUrlRefusal("http://100.64.0.1/")).toMatch(/carrier NAT/);
    expect(publicUrlRefusal("http://0.0.0.0/")).toMatch(/this network/);
    expect(publicUrlRefusal("http://224.0.0.1/")).toMatch(/multicast/);
    expect(publicUrlRefusal("http://[fd00::1]/")).toMatch(/unique-local/);
  });

  it("refuses internal host names and non-public schemes", () => {
    expect(publicUrlRefusal("http://metadata.google.internal/")).toMatch(/internal host/);
    expect(publicUrlRefusal("http://intranet/")).toMatch(/single-label/);
    expect(publicUrlRefusal("file:///etc/passwd")).toMatch(/unsupported scheme/);
    expect(publicUrlRefusal("https://user:pass@example.com/")).toMatch(/credentials/);
    expect(publicUrlRefusal("not a url")).toMatch(/not a valid URL/);
  });

  it("is a yes/no wrapper over the same rule", () => {
    expect(isPublicHttpUrl("https://signals.example.com/")).toBe(true);
    expect(isPublicHttpUrl("http://169.254.169.254/")).toBe(false);
  });
});

describe("reserveOriginFetch", () => {
  it("paces successive reads from the same origin", async () => {
    const states = new Map<string, OriginFetchState>();
    const first = await reserveOriginFetch(states, "https://a.example.com");
    expect(first.allowed).toBe(true);
    // The state now says the next read must wait, which is the pacing promise.
    expect(states.get("https://a.example.com")?.nextAt).toBeGreaterThan(Date.now() - 5);
    expect(states.get("https://a.example.com")?.count).toBe(1);
  });

  it("stops at the per-origin ceiling instead of reading a site forever", async () => {
    const states = new Map<string, OriginFetchState>();
    const origin = "https://busy.example.com";
    for (let i = 0; i < MAX_FETCHES_PER_ORIGIN; i += 1) {
      // Pretend each prior read already happened, so no real waiting is needed.
      const state = states.get(origin) ?? { nextAt: 0, count: 0, failures: 0 };
      state.nextAt = 0;
      states.set(origin, state);
      expect((await reserveOriginFetch(states, origin)).allowed).toBe(true);
    }
    expect(states.get(origin)?.count).toBe(MAX_FETCHES_PER_ORIGIN);
    expect((await reserveOriginFetch(states, origin)).allowed).toBe(false);
  });

  it("backs off after a failure rather than retrying at full speed", async () => {
    const states = new Map<string, OriginFetchState>();
    const origin = "https://flaky.example.com";
    states.set(origin, { nextAt: 0, count: 1, failures: 1 });
    const result = await reserveOriginFetch(states, origin);
    expect(result.allowed).toBe(false);
    expect(result.waitMs).toBeGreaterThanOrEqual(2_000);
    // The gap never grows past its ceiling.
    states.set(origin, { nextAt: 0, count: 1, failures: 20 });
    expect((await reserveOriginFetch(states, origin)).waitMs).toBe(MAX_FETCH_BACKOFF_MS);
  });

  it("lets a read through when the origin is unknown", async () => {
    expect((await reserveOriginFetch(new Map(), null)).allowed).toBe(true);
  });
});

describe("isSameSiteOrigin", () => {
  it("matches only the candidate's own registrable domain", () => {
    expect(isSameSiteOrigin("https://signals.example.com/pricing", "signals.example.com")).toBe(true);
    expect(isSameSiteOrigin("https://www.signals.example.com/", "signals.example.com")).toBe(true);
    expect(isSameSiteOrigin("https://evil.example.net/", "signals.example.com")).toBe(false);
  });

  it("never matches without a known site domain", () => {
    expect(isSameSiteOrigin("https://signals.example.com/", null)).toBe(false);
  });
});

describe("officialEvidenceUrls", () => {
  it("accepts same-site pages and an explicitly linked official profile, nothing else", () => {
    const urls = officialEvidenceUrls({
      siteDomain: "signals.example.com",
      pages: [
        { url: "https://signals.example.com/", title: "", content: "" },
        { url: "https://signals.example.com/pricing", title: "", content: "" },
        { url: "https://apps.apple.com/app/example/id123", title: "", content: "" },
      ],
      identity: {
        instagramUrl: "https://instagram.com/examplesignals",
        youtubeUrl: null,
        telegramUrl: null,
        xUrl: null,
      },
    });
    expect(urls).toContain("https://signals.example.com/");
    expect(urls).toContain("https://signals.example.com/pricing");
    // An app-store page was fetched (profile discovery allows it) but is not an
    // accepted evidence source — the lead model's own official-source rule has
    // no app-store exception, so the engine must not invent one either.
    expect(urls).not.toContain("https://apps.apple.com/app/example/id123");
  });
});
