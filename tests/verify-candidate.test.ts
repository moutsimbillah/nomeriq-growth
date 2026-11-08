import { describe, expect, it } from "vitest";
import {
  discoverOfficialProfileLinks,
  isAllowedByRobots,
  isSameSiteOrigin,
  officialEvidenceUrls,
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
