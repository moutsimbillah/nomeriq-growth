import {
  assessSignalEvidence,
  buildVerdictPrompt,
  extractEmailsFromPage,
  normalizeModelVerdict,
  resolveContactEmail,
  verdictSystemPrompt,
  type ExtractedEmail,
  type ModelVerdict,
} from "./verify";
import type { ResearchProvider } from "./research-provider";
import { domainFromUrl } from "@/lib/utils";
import type { Category } from "@/lib/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FetchedPage {
  url: string;
  title: string;
  content: string;
}

export interface VerifiedCandidate {
  qualified: boolean;
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
  verdict: ModelVerdict | null;
  extractedEmails: ExtractedEmail[];
  /** Sum of Fetch API costs incurred, so the caller can record real spend. */
  fetchCostUsd: number;
  /** Model usage for the verdict call, when it ran. */
  usage: { model: string; inputTokens: number; outputTokens: number; costUsd: number } | null;
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
}

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
  let fetchCostUsd = 0;
  let usage: VerifiedCandidate["usage"] = null;

  const fetchInto = async (url: string) => {
    if (visited.has(url) || pages.length >= maxPages) return;
    visited.add(url);
    const fetched = await input.provider.fetch({ url });
    fetchCostUsd += fetched.costUsd;
    if (!fetched.content?.trim()) return;
    pages.push({ url, title: fetched.title, content: fetched.content });
    extracted.push(
      ...extractEmailsFromPage({
        content: fetched.content,
        pageUrl: url,
        siteDomain,
      }),
    );
  };

  await fetchInto(input.entryUrl ?? input.websiteUrl);

  // Follow same-domain contact/pricing links found in the first page.
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

  if (!pages.length) {
    return {
      qualified: false,
      reason: "The official website could not be retrieved.",
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
      fetchCostUsd,
      usage: null,
    };
  }

  const combined = pages.map((page) => page.content).join("\n\n");
  const assessment = assessSignalEvidence(combined);

  let verdict: ModelVerdict | null = null;
  try {
    const response = await input.provider.chatJson<any>({
      system: verdictSystemPrompt(),
      user: buildVerdictPrompt({
        businessName: input.businessName,
        websiteUrl: input.websiteUrl,
        requirements: input.requirements,
        pages,
        candidateEmails: extracted.map((entry) => entry.email),
      }),
      maxTokens: 1200,
    });
    verdict = normalizeModelVerdict(response.data);
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

  return {
    qualified: finalQualified,
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

