import {
  assessSignalEvidence,
  assessmentVerdictSystemPrompt,
  buildAssessmentVerdictPrompt,
  extractEmailsFromPage,
  normalizeAssessmentVerdict,
  resolveContactEmail,
  type AssessmentVerdict,
  type ExtractedEmail,
  type ModelVerdict,
} from "./verify";
import type { ResearchProvider } from "./research-provider";
import { domainFromUrl, normalizeHandle } from "@/lib/utils";
import type { Category } from "@/lib/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FetchedPage {
  url: string;
  title: string;
  content: string;
}

/** A page longer than this is truncated before it is stored or shown to the model. */
export const MAX_PAGE_CHARS = 200_000;
/** How many official profile/app-store pages may be fetched on top of same-domain pages. */
export const MAX_OFFICIAL_PROFILE_PAGES = 2;

/**
 * The user agent the engine identifies itself as when reading robots.txt. It is
 * deliberately honest: a site owner who blocks this token means it, and we obey.
 */
export const RESEARCH_USER_AGENT = "NomeriqResearchBot";

/**
 * Decides whether robots.txt permits a path for a user agent.
 *
 * Absent, empty or unparsable content means allowed: a robots.txt we could not
 * read is not a prohibition, and treating a failed lookup as a ban would
 * silently shrink the search space. Only an explicit matching Disallow blocks.
 * Mirrors the widely used rule that the longest matching path wins, with Allow
 * breaking a tie.
 */
export function isAllowedByRobots(input: {
  robots: string | null | undefined;
  path: string;
  userAgent?: string;
}): boolean {
  const text = input.robots;
  if (!text?.trim()) return true;
  const agent = (input.userAgent ?? RESEARCH_USER_AGENT).toLowerCase();
  const path = input.path || "/";

  interface Group { agents: string[]; rules: { allow: boolean; path: string }[] }
  const groups: Group[] = [];
  let current: Group | null = null;
  let expectingAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      // A user-agent line after rules starts a new group.
      if (!expectingAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      expectingAgent = true;
      continue;
    }
    if (!current) continue;
    if (field === "disallow" || field === "allow") {
      expectingAgent = false;
      current.rules.push({ allow: field === "allow", path: value });
    }
  }

  const specific = groups.filter((group) =>
    group.agents.some((candidate) => candidate !== "*" && agent.includes(candidate)),
  );
  const wildcard = groups.filter((group) => group.agents.includes("*"));
  const applicable = specific.length ? specific : wildcard;
  if (!applicable.length) return true;

  let best: { allow: boolean; length: number } | null = null;
  for (const group of applicable) {
    for (const rule of group.rules) {
      // An empty Disallow value means "allow everything".
      if (!rule.path) continue;
      if (!path.startsWith(rule.path)) continue;
      if (!best || rule.path.length > best.length || (rule.path.length === best.length && rule.allow && !best.allow)) {
        best = { allow: rule.allow, length: rule.path.length };
      }
    }
  }
  return best ? best.allow : true;
}

const OFFICIAL_PROFILE_HOSTS: { platform: string; pattern: RegExp }[] = [
  { platform: "instagram", pattern: /(^|\.)instagram\.com$/i },
  { platform: "youtube", pattern: /(^|\.)(youtube\.com|youtu\.be)$/i },
  { platform: "telegram", pattern: /(^|\.)(t\.me|telegram\.me)$/i },
  { platform: "x", pattern: /(^|\.)(x\.com|twitter\.com)$/i },
  { platform: "linkedin", pattern: /(^|\.)linkedin\.com$/i },
  { platform: "linktree", pattern: /(^|\.)linktr\.ee$/i },
  { platform: "app_store", pattern: /(^|\.)apps\.apple\.com$/i },
  { platform: "play_store", pattern: /(^|\.)play\.google\.com$/i },
];

/**
 * Pulls officially linked profile and app-store pages out of a fetched page.
 *
 * These are the only off-domain pages Part 2 is allowed to follow, because a
 * link published on the business's own site is what makes a social account or
 * an app listing "official". Anything else stays unfollowed — the engine never
 * wanders off to a third-party site on its own initiative.
 */
export function discoverOfficialProfileLinks(input: {
  html: string;
  pageUrl: string;
  limit?: number;
}): { platform: string; url: string }[] {
  const limit = input.limit ?? MAX_OFFICIAL_PROFILE_PAGES;
  const found = new Map<string, { platform: string; url: string }>();
  const linkPattern = /href\s*=\s*["']([^"'#]+)["']/gi;
  for (const match of input.html.matchAll(linkPattern)) {
    const href = match[1]?.trim();
    if (!href) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, input.pageUrl);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(resolved.protocol)) continue;
    if (resolved.username || resolved.password) continue;
    const entry = OFFICIAL_PROFILE_HOSTS.find((candidate) =>
      candidate.pattern.test(resolved.hostname),
    );
    if (!entry) continue;
    const host = resolved.hostname.toLowerCase().replace(/^www\./, "");
    // Link shorteners and search/interstitial URLs are not accounts.
    if (/\/search|\/explore\/tags\/|\/results\?/.test(resolved.pathname + resolved.search)) continue;
    if (entry.platform === "telegram" && !/^\/[A-Za-z0-9_]{3,}$/.test(resolved.pathname)) continue;
    if (entry.platform === "instagram" && !/^\/[A-Za-z0-9_.]{2,}\/?$/.test(resolved.pathname)) continue;
    if (entry.platform === "youtube" && resolved.pathname === "/watch") continue;
    resolved.hash = "";
    resolved.search = "";
    const key = `${entry.platform}:${host}${resolved.pathname.replace(/\/$/, "")}`;
    if (!found.has(key)) found.set(key, { platform: entry.platform, url: resolved.toString() });
    if (found.size >= limit) break;
  }
  return [...found.values()];
}

/** True when a URL's origin is the candidate's own site. */
export function isSameSiteOrigin(url: string, siteDomain: string | null): boolean {
  if (!siteDomain) return false;
  return domainFromUrl(url) === siteDomain;
}

/**
 * The platforms a discovered link can become a saved identity for. Kept in step
 * with the lead model: an `instagram`/`youtube`/`telegram` account is both an
 * identity and an audience observation, `x` is only an identity.
 */
const OFFICIAL_PROFILE_PLATFORMS = new Set([
  "instagram",
  "youtube",
  "telegram",
  "x",
]);

/** The platforms the lead model accepts as audience observations. */
const AUDIENCE_PLATFORMS = new Set(["instagram", "youtube", "telegram"] as const);

function firstOfficialUrl(
  links: Map<string, { platform: string; url: string; foundOn: string }>,
  platform: string,
): string | null {
  for (const entry of links.values()) {
    if (entry.platform === platform) return entry.url;
  }
  return null;
}


export interface VerifiedCandidate {
  /** True only when a real published contact email was also found. */
  qualified: boolean;
  /**
   * True when the business itself qualifies (deterministic evidence plus model
   * confirmation), independent of whether a contact email was published. This is
   * what lets a Telegram-only seller be saved as Category B instead of discarded.
   */
  businessQualified: boolean;
  reason: string;
  pages: FetchedPage[];
  businessName: string | null;
  websiteUrl: string | null;
  categories: Category[];
  country: string | null;
  signalDescription: string | null;
  pricingDetails: string | null;
  evidenceSummary: string | null;
  contactEmail: string | null;
  emailSourceUrl: string | null;
  observation: string | null;
  verdict: AssessmentVerdict | null;
  extractedEmails: ExtractedEmail[];
  /**
   * Official profile URLs published on the business's own site, already
   * filtered to the platforms the lead model accepts as identities.
   */
  identity: {
    instagramUrl: string | null;
    youtubeUrl: string | null;
    telegramUrl: string | null;
    xUrl: string | null;
  };
  /** Audience observations that are ready to save, in lead-model shape. */
  audiences: {
    platform: "instagram" | "youtube" | "telegram";
    accountKey: string;
    handle: string | null;
    accountUrl: string;
    countValue: number | null;
    countState: "verified" | "unknown";
    displayedText: string | null;
    sourceUrl: string;
    officialLinkSourceUrl: string;
  }[];
  /** Official contact routes that are ready to save, in lead-model shape. */
  contactRoutes: {
    platform: string;
    routeKind: "dm" | "group" | "channel" | "bot" | "form" | "other";
    handle: string | null;
    routeUrl: string | null;
    officialStatus: "verified" | "unknown" | "unofficial";
    notes: string;
    sourceUrl: string;
  }[];
  /** URLs skipped because robots.txt forbade them — reported, never treated as absence. */
  robotsBlocked: string[];
  /** Sum of Fetch API costs incurred, so the caller can record real spend. */
  fetchCostUsd: number;
  /** Model usage for the verdict call, when it ran. */
  usage: { model: string; inputTokens: number; outputTokens: number; costUsd: number } | null;
}

/**
 * The URLs the lead model will accept as evidence for this business: its own
 * site, plus any social profile it actually links to. `saveLeadAssessment`
 * rejects a finding from anywhere else, so the engine filters findings to this
 * set before saving rather than letting the save fail.
 */
export function officialEvidenceUrls(input: {
  siteDomain: string | null;
  pages: FetchedPage[];
  identity: VerifiedCandidate["identity"];
}): string[] {
  const profiles = [
    input.identity.instagramUrl,
    input.identity.youtubeUrl,
    input.identity.telegramUrl,
    input.identity.xUrl,
  ].filter((value): value is string => Boolean(value));
  const profileKeys = new Set(profiles.map(profileKey));
  return input.pages
    .map((page) => page.url)
    .filter((url) => isSameSiteOrigin(url, input.siteDomain) || profileKeys.has(profileKey(url)));
}

function profileKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.toLowerCase().replace(/^www\./, "")}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}

const PAGE_HINTS = [
  { label: "contact", pattern: /\b(contact|contact-us|contactus|get-in-touch|about-us|about)\b/i },
  { label: "pricing", pattern: /\b(pricing|prices|plans|packages|subscribe|subscription|membership|vip|join)\b/i },
  { label: "signals", pattern: /\b(signals?|services?|products?|performance|results)\b/i },
];

/**
 * Pulls candidate follow-up links out of a homepage, restricted to the same
 * registrable domain. Following a same-domain contact or pricing page is what
 * makes the published email and the paid offering verifiable from official
 * sources rather than inferred.
 */
export function discoverFollowUpLinks(input: {
  html: string;
  pageUrl: string;
  siteDomain: string | null;
  limit?: number;
}): string[] {
  const limit = input.limit ?? 3;
  const found = new Map<string, number>();
  const linkPattern = /href\s*=\s*["']([^"'#]+)["']/gi;
  for (const match of input.html.matchAll(linkPattern)) {
    const href = match[1]?.trim();
    if (!href) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, input.pageUrl);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(resolved.protocol)) continue;
    if (resolved.username || resolved.password) continue;
    const domain = domainFromUrl(resolved.toString());
    if (input.siteDomain && domain !== input.siteDomain) continue;
    if (!input.siteDomain) continue;
    const haystack = `${resolved.pathname}${resolved.search}`;
    const priority = PAGE_HINTS.findIndex((hint) => hint.pattern.test(haystack));
    if (priority === -1) continue;
    resolved.hash = "";
    const key = resolved.toString();
    const existing = found.get(key);
    if (existing === undefined || priority < existing) found.set(key, priority);
  }
  return [...found.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, limit)
    .map(([url]) => url);
}

export interface VerifyCandidateInput {
  provider: ResearchProvider;
  businessName: string | null;
  websiteUrl: string;
  requirements: string;
  categories: Category[];
  /** Overrides the homepage when a better official entry point is known. */
  entryUrl?: string;
  maxPages?: number;
  /** Injected in tests; the real one fetches `/robots.txt` through the provider. */
  robotsFetcher?: (origin: string) => Promise<string | null>;
}

/**
 * A candidate's verification result before it is saved: the raw facts plus the
 * lead-model shapes the caller will persist.
 */

/**
 * Fetches official pages, extracts published emails, applies the deterministic
 * signal/paid-assessment, then asks the model for a structured verdict.
 *
 * The model can only ever *confirm* an email that was extracted from fetched
 * page content; it can never introduce one. Qualification requires both the
 * deterministic signal+paid evidence and the model's confirmation.
 */
export async function verifyCandidate(
  input: VerifyCandidateInput,
): Promise<VerifiedCandidate> {
  const maxPages = Math.min(Math.max(input.maxPages ?? 3, 1), 5);
  const siteDomain = domainFromUrl(input.websiteUrl);
  const pages: FetchedPage[] = [];
  const extracted: ExtractedEmail[] = [];
  const visited = new Set<string>();
  const robotsBlocked: string[] = [];
  /** Official profile/app-store links, with the page on this site that published each. */
  const officialLinks = new Map<string, { platform: string; url: string; foundOn: string }>();
  let fetchCostUsd = 0;
  let usage: VerifiedCandidate["usage"] = null;

  const origin = (() => {
    try {
      return new URL(input.entryUrl ?? input.websiteUrl).origin;
    } catch {
      return null;
    }
  })();

  // robots.txt is fetched at most once per origin, through the same provider as
  // every other read, so the crawl behaves the way the site owner asked.
  let robotsText: string | null | undefined;
  const robotsFor = async (): Promise<string | null> => {
    if (robotsText !== undefined) return robotsText;
    if (!origin) {
      robotsText = null;
      return robotsText;
    }
    if (input.robotsFetcher) {
      robotsText = await input.robotsFetcher(origin).catch(() => null);
      return robotsText;
    }
    try {
      const page = await input.provider.fetch({ url: `${origin}/robots.txt` });
      fetchCostUsd += page.costUsd;
      robotsText = page.content ?? null;
    } catch {
      // An unreadable robots.txt is not a prohibition; the policy check below
      // treats empty content as allowed.
      robotsText = null;
    }
    return robotsText;
  };

  const fetchInto = async (url: string) => {
    if (visited.has(url) || pages.length >= maxPages) return;
    visited.add(url);
    // A blocked path is reported, never silently counted as absence.
    const path = (() => {
      try {
        return new URL(url).pathname || "/";
      } catch {
        return "/";
      }
    })();
    if (!isAllowedByRobots({ robots: await robotsFor(), path })) {
      robotsBlocked.push(url);
      return;
    }
    const fetched = await input.provider.fetch({ url });
    fetchCostUsd += fetched.costUsd;
    if (!fetched.content?.trim()) return;
    pages.push({
      url,
      title: fetched.title,
      content: fetched.content.slice(0, MAX_PAGE_CHARS),
    });
    extracted.push(
      ...extractEmailsFromPage({
        content: fetched.content,
        pageUrl: url,
        siteDomain,
      }),
    );
  };

  await fetchInto(input.entryUrl ?? input.websiteUrl);

  // Follow same-domain contact/pricing links found in the first page, then any
  // official profile the site publishes (social accounts, an app listing).
  const first = pages[0];
  if (first && pages.length < maxPages) {
    const links = discoverFollowUpLinks({
      html: first.content,
      pageUrl: first.url,
      siteDomain,
      limit: maxPages - pages.length,
    });
    for (const link of links) await fetchInto(link);
  }

  const profileBudget = MAX_OFFICIAL_PROFILE_PAGES;
  for (const page of [...pages]) {
    for (const link of discoverOfficialProfileLinks({
      html: page.content,
      pageUrl: page.url,
      limit: profileBudget + 4,
    })) {
      if (!OFFICIAL_PROFILE_PLATFORMS.has(link.platform)) continue;
      const key = `${link.platform}:${profileKey(link.url)}`;
      if (!officialLinks.has(key)) {
        officialLinks.set(key, { platform: link.platform, url: link.url, foundOn: page.url });
      }
    }
  }
  {
    const profilePages = [...new Set([...officialLinks.values()].map((entry) => entry.url))].slice(
      0,
      profileBudget,
    );
    for (const url of profilePages) await fetchInto(url);
  }

  const identity: VerifiedCandidate["identity"] = {
    instagramUrl: firstOfficialUrl(officialLinks, "instagram"),
    youtubeUrl: firstOfficialUrl(officialLinks, "youtube"),
    telegramUrl: firstOfficialUrl(officialLinks, "telegram"),
    xUrl: firstOfficialUrl(officialLinks, "x"),
  };

  if (!pages.length) {
    return {
      qualified: false,
      businessQualified: false,
      reason: robotsBlocked.length
        ? "The official pages are disallowed by the site's robots.txt."
        : "The official website could not be retrieved.",
      pages,
      businessName: input.businessName,
      websiteUrl: input.websiteUrl,
      categories: [],
      country: null,
      signalDescription: null,
      pricingDetails: null,
      evidenceSummary: null,
      contactEmail: null,
      emailSourceUrl: null,
      observation: null,
      verdict: null,
      extractedEmails: [],
      identity,
      audiences: [],
      contactRoutes: [],
      robotsBlocked,
      fetchCostUsd,
      usage: null,
    };
  }

  const combined = pages.map((page) => page.content).join("\n\n");
  const assessment = assessSignalEvidence(combined);

  let verdict: AssessmentVerdict | null = null;
  try {
    const response = await input.provider.chatJson<any>({
      system: assessmentVerdictSystemPrompt(),
      user: buildAssessmentVerdictPrompt({
        businessName: input.businessName,
        websiteUrl: input.websiteUrl,
        requirements: input.requirements,
        pages,
        candidateEmails: extracted.map((entry) => entry.email),
      }),
      maxTokens: 2000,
    });
    verdict = normalizeAssessmentVerdict(
      response.data,
      pages.map((page) => page.url),
    );
    usage = {
      model: response.usage.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: response.usage.costUsd,
    };
  } catch (error) {
    // A model failure must not silently become a "qualified" lead.
    verdict = null;
    const reason =
      error instanceof Error ? error.message : "Model verification failed.";
    return {
      qualified: false,
      businessQualified: false,
      reason: `Verification could not be completed: ${reason}`,
      pages,
      businessName: input.businessName,
      websiteUrl: input.websiteUrl,
      categories: [],
      country: null,
      signalDescription: null,
      pricingDetails: null,
      evidenceSummary: null,
      contactEmail: null,
      emailSourceUrl: null,
      observation: null,
      verdict: null,
      extractedEmails: extracted,
      identity,
      audiences: [],
      contactRoutes: [],
      robotsBlocked,
      fetchCostUsd,
      usage: null,
    };
  }

  const modelConfirms =
    verdict.isSignalProvider && verdict.sellsPaidSignals && !verdict.exclusionReason;
  const qualified = assessment.qualified && modelConfirms;

  const contact = resolveContactEmail({
    extracted,
    modelEmail: verdict.contactEmail,
    modelSourceUrl: verdict.emailSourceUrl,
    siteDomain,
  });

  const categories = verdict.categories.length
    ? verdict.categories
    : input.categories;

  const reason = !assessment.qualified
    ? assessment.reason
    : !modelConfirms
      ? verdict.exclusionReason
        ? `Excluded: ${verdict.exclusionReason}`
        : "The model did not confirm a paid trading-signal offering."
      : !contact
        ? "No published business contact email was found on the official pages."
        : "Verified: paid trading-signal offering with a published contact email.";

  // A lead only counts when a real published email was located.
  const finalQualified = qualified && Boolean(contact);

  // Findings the lead model will accept: only sources the business actually
  // publishes (its own site, or a profile it links to). A model-cited URL that
  // is neither is dropped here rather than failing the whole save.
  const allowedSources = new Set(
    officialEvidenceUrls({ siteDomain, pages, identity }),
  );
  const sourceTime = new Date().toISOString();
  const toFinding = (finding: AssessmentVerdict["findings"][number]) => ({
    area: finding.area,
    summary: finding.summary,
    sourceUrl: finding.sourceUrl,
    observedAt: sourceTime,
    verdict: finding.verdict,
    ...(finding.activityAt ? { activityAt: finding.activityAt } : {}),
  });
  const findings = verdict.findings
    .filter((finding) => allowedSources.has(finding.sourceUrl))
    .map(toFinding);
  const capabilityGaps = verdict.capabilityGaps
    .filter((finding) => allowedSources.has(finding.sourceUrl))
    .map(toFinding);

  // The page that published a profile link is the official reference; the
  // account itself is the subject. Both are recorded, as the lead model wants.
  const linkFor = (accountUrl: string) => {
    for (const entry of [...officialLinks.values()]) {
      if (profileKey(entry.url) === profileKey(accountUrl)) return entry;
    }
    return null;
  };

  const audiences: VerifiedCandidate["audiences"] = [];
  for (const candidate of verdict.audienceCandidates) {
    if (!AUDIENCE_PLATFORMS.has(candidate.platform)) continue;
    const accountKey = normalizeHandle(candidate.accountUrl, candidate.platform);
    if (!accountKey) continue;
    // Only an account the site itself links to is official enough to save; the
    // model's word alone cannot add an identity to a business.
    const link = linkFor(candidate.accountUrl);
    if (!link) continue;
    audiences.push({
      platform: candidate.platform,
      accountKey,
      handle: candidate.handle,
      accountUrl: candidate.accountUrl,
      countValue: candidate.countValue,
      countState: candidate.countState,
      displayedText: candidate.displayedText,
      sourceUrl: link.foundOn,
      officialLinkSourceUrl: link.foundOn,
    });
  }

  const contactRoutes: VerifiedCandidate["contactRoutes"] = [];
  for (const route of verdict.contactRouteCandidates) {
    // Same rule: a route is only official when the business's own page linked it.
    const link = route.routeUrl ? linkFor(route.routeUrl) : null;
    const official = Boolean(link);
    contactRoutes.push({
      platform: route.platform,
      routeKind: route.routeKind,
      handle: route.handle,
      routeUrl: route.routeUrl,
      officialStatus: official ? "verified" : "unknown",
      notes: route.notes,
      sourceUrl: link?.foundOn ?? route.sourceUrl,
    });
  }

  return {
    qualified: finalQualified,
    businessQualified: qualified,
    reason,
    pages,
    businessName: verdict.businessName ?? input.businessName,
    websiteUrl: input.websiteUrl,
    categories,
    country: verdict.country,
    signalDescription: verdict.signalDescription,
    pricingDetails: verdict.pricingDetails,
    evidenceSummary: verdict.evidenceSummary ?? assessment.reason,
    contactEmail: contact?.email ?? null,
    emailSourceUrl: contact?.sourceUrl ?? null,
    observation: verdict.observation,
    verdict,
    extractedEmails: extracted,
    identity,
    audiences: audiences.slice(0, 10),
    contactRoutes: contactRoutes.slice(0, 10),
    robotsBlocked,
    fetchCostUsd,
    usage,
  };
}

/* --------------------------------- drafting -------------------------------- */

/*
 * Drafting deliberately lives in `src/lib/services/drafts.ts`
 * (`generateDraftForProspect`). That path already applies Product Truth,
 * claim validation warnings, deterministic fallback, founder-edit preservation,
 * usage recording and the `draft_saved` research event. The engine calls it
 * rather than keeping a second, divergent writer.
 */

