/**
 * A deterministic in-memory DeepSeek stand-in.
 *
 * It implements the same `ResearchProvider` interface as the real adapter, so the
 * engine can be exercised end to end — discovery, fetch, verification, dedup,
 * saving, drafting, budget and resume — without an API key or network access.
 *
 * It is intentionally strict: it only ever returns pages and emails that the
 * test seeded, and it never fabricates an email. That mirrors the production
 * rule that a lead cannot exist without a published contact address.
 */
import type { ResearchProvider } from "@/lib/deepseek/research-provider";
import type { DeepSeekSearchResult, DeepSeekUsage } from "@/lib/deepseek/provider";
import type { Category } from "@/lib/types";

export interface FakeSite {
  domain: string;
  businessName: string;
  /** Pages keyed by path, e.g. "/" and "/contact". */
  pages: Record<string, string>;
  /** Emails deliberately published on the site. */
  emails: { email: string; path: string }[];
  /** Set false to model a broker/education-only business. */
  qualifies?: boolean;
  categories?: Category[];
  country?: string | null;
  pricing?: string | null;
  observation?: string | null;
  exclusionReason?: string | null;
  /** Official social accounts the site links to, with their displayed counts. */
  audiences?: {
    platform: "instagram" | "youtube" | "telegram";
    url: string;
    handle?: string;
    /** Omit entirely when the site does not display a number (Unknown, not zero). */
    countValue?: number;
  }[];
  /** Official non-email contact routes the site links to. */
  contactRoutes?: {
    platform: string;
    routeKind: "dm" | "group" | "channel" | "bot" | "form" | "other";
    url?: string;
    handle?: string;
    notes?: string;
  }[];
}

export interface FakeProviderOptions {
  sites: FakeSite[];
  /** Search cost per returned result set, in USD. */
  searchCostUsd?: number;
  fetchCostUsd?: number;
  chatCostUsd?: number;
  /** Fail every fetch, to model an unreachable site. */
  failFetches?: boolean;
  /**
   * Throw from every fetch instead of returning empty content. This models the
   * real DeepSeek gateway behaviour: an upstream scraper failure arrives as an
   * error, which is what made a broken Fetch look like a silent "Not found".
   */
  throwOnFetch?: boolean;
  /** Fail the model call, to prove a model outage cannot create leads. */
  failChat?: boolean;
}

export interface FakeProviderStats {
  searches: number;
  fetches: number;
  chats: number;
  fetchCostUsd: number;
  chatCostUsd: number;
  searchCostUsd: number;
  queries: string[];
}

export function createFakeProvider(options: FakeProviderOptions): {
  provider: ResearchProvider;
  stats: FakeProviderStats;
} {
  const stats: FakeProviderStats = {
    searches: 0,
    fetches: 0,
    chats: 0,
    fetchCostUsd: 0,
    chatCostUsd: 0,
    searchCostUsd: 0,
    queries: [],
  };
  const searchCost = options.searchCostUsd ?? 0.001;
  const fetchCost = options.fetchCostUsd ?? 0.001;
  const chatCost = options.chatCostUsd ?? 0.002;

  const siteForUrl = (url: string): FakeSite | null => {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return null;
    }
    return options.sites.find((site) => site.domain === host) ?? null;
  };

  const usage = (): DeepSeekUsage => ({
    model: "deepseek-flash-fake",
    inputTokens: 100,
    cachedInputTokens: 0,
    outputTokens: 50,
    costUsd: chatCost,
  });

  const provider: ResearchProvider = {
    model: "deepseek-flash-fake",

    async search(input: { query: string; count: number }) {
      stats.searches += 1;
      stats.queries.push(input.query);
      // Return every seeded site whose name or markets loosely match the query,
      // so different queries surface overlapping-but-distinct candidates.
      const lower = input.query.toLowerCase();
      const results: DeepSeekSearchResult[] = options.sites
        .filter((site) => {
          const haystack = `${site.businessName} ${site.domain} ${(site.categories ?? []).join(" ")}`.toLowerCase();
          const tokens = lower
            .replace(/["()]/g, " ")
            .split(/\s+/)
            .filter((token) => token.length > 3);
          return tokens.some((token) => haystack.includes(token));
        })
        .slice(0, input.count)
        .map((site) => ({
          title: site.businessName,
          url: `https://${site.domain}/`,
          snippet: `${site.businessName} trading signals`,
          summary: `${site.businessName} offers trading signals.`,
          content: "",
          siteName: site.businessName,
          date: null,
          authority: 2,
          rerankScore: 1.8,
        }));
      stats.searchCostUsd += results.length ? searchCost : 0;
      return {
        results,
        costUsd: results.length ? searchCost : 0,
      };
    },

    async fetch(input: { url: string }) {
      stats.fetches += 1;
      if (options.throwOnFetch) {
        throw new Error("Failed to scrape page with Firecrawl");
      }
      if (options.failFetches) {
        stats.fetchCostUsd += fetchCost;
        return { title: "", content: "", costUsd: fetchCost };
      }
      const site = siteForUrl(input.url);
      if (!site) return { title: "", content: "", costUsd: 0 };
      let path: string;
      try {
        path = new URL(input.url).pathname || "/";
      } catch {
        path = "/";
      }
      const body = site.pages[path] ?? site.pages["/"] ?? "";
      // The fake provider mirrors reality: the email is only present when the
      // site actually publishes it on the fetched page.
      const emailHere = site.emails.filter((entry) => entry.path === path);
      const emails = emailHere.map((entry) => entry.email);
      const content = [body, emails.length ? `Contact us at ${emails.join(" or ")}` : ""]
        .filter(Boolean)
        .join("\n\n");
      stats.fetchCostUsd += fetchCost;
      return {
        title: `${site.businessName} — official site`,
        content,
        costUsd: fetchCost,
      };
    },

    async chatJson<T>(input: { system: string; user: string }) {
      stats.chats += 1;
      if (options.failChat) {
        throw new Error("Simulated model outage.");
      }
      // Identify which candidate the prompt concerns from its website line.
      const urlMatch = input.user.match(/Official website:\s*(\S+)/);
      const site = urlMatch ? siteForUrl(urlMatch[1]) : null;
      if (!site) {
        return {
          data: {
            isSignalProvider: false,
            sellsPaidSignals: false,
            categories: [],
            businessName: null,
            country: null,
            signalDescription: null,
            pricingDetails: null,
            evidenceSummary: null,
            contactEmail: null,
            emailSourceUrl: null,
            exclusionReason: "Unknown business.",
            confidence: 0,
            observation: null,
          } as T,
          usage: usage(),
        };
      }
      const qualifies = site.qualifies !== false;
      const email = site.emails[0]?.email ?? null;
      const emailPath = site.emails[0]?.path ?? "/contact";
      // The engine now asks for the lead-model assessment in the same call, so
      // the fake must answer in that shape — including the per-area findings and
      // the audience/contact-route candidates whose sourceUrl the engine only
      // accepts when it is a page that was actually fetched.
      const on = (path: string) => `https://${site.domain}${path}`;
      const findings = qualifies
        ? [
            { area: "paid_signals", summary: "Pricing page lists a paid subscription plan.", sourceUrl: on("/pricing"), verdict: "present" },
            { area: "markets", summary: `Markets listed by ${site.businessName}.`, sourceUrl: on("/"), verdict: "present" },
            // Only the model's email finding, not the saved address itself, depends
            // on a real published email — Category B businesses publish none.
            ...(email
              ? [{ area: "email", summary: "A business contact address is published.", sourceUrl: on(emailPath), verdict: "present" }]
              : []),
            { area: "identity", summary: "The business publishes its own site.", sourceUrl: on("/"), verdict: "present" },
            { area: "activity", summary: "Recent results are published publicly.", sourceUrl: on("/"), verdict: "present" },
            { area: "delivery", summary: "Signals are delivered through a manual channel.", sourceUrl: on("/"), verdict: "present" },
          ]
        : [
            { area: "identity", summary: "Site describes a brokerage service.", sourceUrl: on("/"), verdict: "present" },
          ];
      const data = {
        isSignalProvider: qualifies,
        sellsPaidSignals: qualifies,
        categories: site.categories ?? ["forex"],
        businessName: site.businessName,
        country: site.country ?? null,
        signalDescription: qualifies
          ? "Sells monthly trading-signal subscriptions with entry, stop and target levels."
          : null,
        pricingDetails: qualifies
          ? (site.pricing ?? "$49 per month published on the pricing page.")
          : null,
        evidenceSummary: qualifies
          ? `Official pages show a paid signals subscription for ${site.businessName}.`
          : null,
        contactEmail: email,
        emailSourceUrl: email ? on("/contact") : null,
        exclusionReason: qualifies ? null : (site.exclusionReason ?? "Excluded business type."),
        confidence: 0.9,
        observation: qualifies
          ? (site.observation ?? `They publish performance results for their signal service.`)
          : null,
        findings,
        capabilityGaps: qualifies
          ? [
              {
                area: "gap",
                summary: "No branded subscriber platform is evidenced.",
                sourceUrl: on("/"),
                verdict: "present",
              },
            ]
          : [],
        platformMaturity: qualifies ? "fragmented" : "unknown",
        mobileAppStatus: qualifies ? "not_found_in_checked_sources" : "unknown",
        productFit: qualifies ? "high" : "unknown",
        fitReasoning: qualifies
          ? "Manual channel delivery with no subscriber platform found."
          : "",
        researchConfidence: qualifies ? "medium" : "low",
        missingInformation: [],
        audienceCandidates: (site.audiences ?? []).map((audience) => ({
          platform: audience.platform,
          accountUrl: audience.url,
          handle: audience.handle ?? null,
          countValue: audience.countValue ?? null,
          countState: audience.countValue === undefined ? "unknown" : "verified",
          displayedText:
            audience.countValue === undefined ? null : `${audience.countValue} followers`,
          sourceUrl: on("/"),
        })),
        contactRouteCandidates: (site.contactRoutes ?? []).map((route) => ({
          platform: route.platform,
          routeKind: route.routeKind,
          handle: route.handle ?? null,
          routeUrl: route.url ?? null,
          officialStatus: "verified",
          notes: route.notes ?? "",
          sourceUrl: on("/"),
        })),
      };
      return { data: data as T, usage: usage() };
    },
  };

  return { provider, stats };
}

/** Builds a site that should qualify, with a published contact email. */
export function qualifyingSite(input: {
  domain: string;
  businessName: string;
  email?: string;
  categories?: Category[];
}): FakeSite {
  const email = input.email ?? `hello@${input.domain}`;
  const signals = `Paid trading signals with VIP access. Subscribe monthly for $49 per month. Join now.`;
  return {
    domain: input.domain,
    businessName: input.businessName,
    categories: input.categories ?? ["forex"],
    pages: {
      "/": `<html><body><h1>${input.businessName}</h1><p>${signals}</p>
        <a href="/pricing">Pricing</a> <a href="/contact">Contact</a></body></html>`,
      "/pricing": `<html><body><h1>Pricing</h1><p>${signals}</p>
        Subscription plans and membership pricing.</body></html>`,
      "/contact": `<html><body><h1>Contact</h1><p>Email our team for support.</p></body></html>`,
    },
    emails: [{ email, path: "/contact" }],
    pricing: "$49 per month.",
    observation: "They publish a monthly subscription price and VIP signal access.",
  };
}

/** Builds a broker site that must never qualify. */
export function brokerSite(input: {
  domain: string;
  businessName: string;
}): FakeSite {
  return {
    domain: input.domain,
    businessName: input.businessName,
    qualifies: false,
    exclusionReason: "broker or brokerage services",
    categories: ["forex"],
    pages: {
      "/": `<html><body><h1>${input.businessName}</h1>
        <p>We are a broker. Open an account with us, leverage up to 1:500.</p>
        <a href="/contact">Contact</a></body></html>`,
      "/contact": `<html><body>Contact us at support@${input.domain}</body></html>`,
    },
    emails: [{ email: `support@${input.domain}`, path: "/contact" }],
  };
}

/**
 * Builds a paid-signals business that publishes no email at all and reaches
 * buyers only through Telegram — the founder's Category B case, which used to
 * be discarded outright.
 */
export function telegramOnlySite(input: {
  domain: string;
  businessName: string;
  handle?: string;
  members?: number;
}): FakeSite {
  // Real Telegram usernames allow only letters, digits and underscore — never a
  // hyphen — so a handle must not be blindly derived from a hyphenated domain.
  const handle = input.handle ?? input.domain.replace(/\..*$/, "").replace(/[^A-Za-z0-9_]/g, "");
  const channel = `https://t.me/${handle}`;
  const signals = `Paid trading signals with VIP access. Subscribe monthly for $49 per month. Join our Telegram channel.`;
  return {
    domain: input.domain,
    businessName: input.businessName,
    categories: ["forex"],
    pages: {
      "/": `<html><body><h1>${input.businessName}</h1><p>${signals}</p>
        <a href="/pricing">Pricing</a>
        <a href="${channel}">Join our Telegram channel</a></body></html>`,
      "/pricing": `<html><body><h1>Pricing</h1><p>${signals}</p>
        Subscription plans and membership pricing.</body></html>`,
    },
    emails: [],
    contactRoutes: [
      {
        platform: "telegram",
        routeKind: "channel",
        url: channel,
        handle: `@${handle}`,
        notes: "Linked from the homepage as the signup channel.",
      },
    ],
    audiences: [
      {
        platform: "telegram",
        url: channel,
        handle: `@${handle}`,
        ...(input.members === undefined ? {} : { countValue: input.members }),
      },
    ],
  };
}

/** Adds official social accounts, with the counts the site displays. */
export function withAudiences(
  site: FakeSite,
  accounts: {
    platform: "instagram" | "youtube" | "telegram";
    url: string;
    handle?: string;
    countValue?: number;
  }[],
): FakeSite {
  const links = accounts
    .map((account) => `<a href="${account.url}">${account.platform}</a>`)
    .join(" ");
  return {
    ...site,
    audiences: [...(site.audiences ?? []), ...accounts],
    pages: {
      ...site.pages,
      "/": `${site.pages["/"] ?? ""}\n<div>${links}</div>`,
    },
  };
}

/** Makes a site answer every path with a Disallow for this research bot. */
export function withRobots(
  site: FakeSite,
  robots: string,
): FakeSite {
  return {
    ...site,
    pages: { ...site.pages, "/robots.txt": robots },
  };
}
