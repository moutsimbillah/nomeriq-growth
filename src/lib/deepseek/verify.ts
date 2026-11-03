import { domainFromUrl, isEmail, normalizeEmail } from "@/lib/utils";
import type { Category } from "@/lib/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Evidence extraction and qualification.
 *
 * Everything here is derived from content actually fetched from an official
 * source. Nothing is invented: if the page does not publish an email, no email
 * is produced, and if the page does not evidence a paid signal product, the
 * candidate fails qualification.
 */

export interface ExtractedEmail {
  email: string;
  /** Where on the checked pages the address was published. */
  sourceUrl: string;
  /** mailto: link, or plain text on the page. */
  method: "mailto" | "text";
  /** Whether the address is on the business's own domain. */
  sameDomain: boolean;
}

const EMAIL_PATTERN =
  /[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/gi;

/** Addresses that are never a business contact. */
const BLOCKED_EMAIL_LOCALS = new Set([
  "example",
  "test",
  "noreply",
  "no-reply",
  "donotreply",
  "postmaster",
  "abuse",
  "webmaster@localhost",
]);

const BLOCKED_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "sentry.io",
  "wixpress.com",
  "godaddy.com",
  "cloudflare.com",
  "sentry-next.wixpress.com",
  "domain.com",
  "email.com",
  "yourdomain.com",
  "yourcompany.com",
  "sentry.wixpress.com",
]);

const IMAGE_OR_ASSET_HINT = /\.(png|jpe?g|gif|webp|svg|css|js|woff2?|ttf|ico)$/i;

/** Strips common obfuscations such as "name (at) domain (dot) com". */
function deobfuscate(text: string): string {
  return text
    .replace(/\s*\(at\)\s*/gi, "@")
    .replace(/\s*\[at\]\s*/gi, "@")
    .replace(/\s*\{at\}\s*/gi, "@")
    .replace(/\s+at\s+(?=[a-z0-9-]+\s*(?:\(dot\)|\[dot\]|\{dot\}|\.)\s*[a-z]{2,})/gi, "@")
    .replace(/\s*\(dot\)\s*/gi, ".")
    .replace(/\s*\[dot\]\s*/gi, ".")
    .replace(/\s*\{dot\}\s*/gi, ".");
}

function isBlockedEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  const [local, domain] = normalized.split("@");
  if (!local || !domain) return true;
  if (BLOCKED_EMAIL_LOCALS.has(local)) return true;
  if (BLOCKED_EMAIL_DOMAINS.has(domain)) return true;
  // Guard against asset filenames that merely look like addresses.
  if (IMAGE_OR_ASSET_HINT.test(normalized)) return true;
  if (domain.endsWith(".local") || domain.endsWith(".invalid")) return true;
  return false;
}

/**
 * Extracts published email addresses from one fetched page. `maito:` links are
 * treated as stronger evidence than body text, but both are accepted because
 * many small providers publish only text.
 */
export function extractEmailsFromPage(input: {
  content: string;
  pageUrl: string;
  siteDomain: string | null;
}): ExtractedEmail[] {
  const found = new Map<string, ExtractedEmail>();
  const text = deobfuscate(input.content ?? "");

  const record = (raw: string, method: "mailto" | "text") => {
    const email = normalizeEmail(raw.replace(/^mailto:/i, "").split(/[?"']/)[0] ?? "");
    if (!email || !isEmail(email) || isBlockedEmail(email)) return;
    const domain = email.split("@")[1] ?? "";
    const existing = found.get(email);
    const candidate: ExtractedEmail = {
      email,
      sourceUrl: input.pageUrl,
      method,
      sameDomain: Boolean(input.siteDomain && domain === input.siteDomain),
    };
    // Prefer the stronger mailto evidence and same-domain addresses.
    if (
      !existing ||
      (existing.method === "text" && method === "mailto") ||
      (!existing.sameDomain && candidate.sameDomain)
    ) {
      found.set(email, candidate);
    }
  };

  for (const match of text.matchAll(/mailto:([^\s"'<>()]+)/gi)) {
    record(match[1], "mailto");
  }
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    record(match[0], "text");
  }

  return [...found.values()];
}

/** Ranks a discovered email so the most credible business inbox is chosen. */
export function rankContactEmails(
  emails: ExtractedEmail[],
): ExtractedEmail[] {
  return [...emails].sort((a, b) => {
    const score = (entry: ExtractedEmail) =>
      (entry.sameDomain ? 4 : 0) +
      (entry.method === "mailto" ? 2 : 0) +
      (isGenericBusinessEmailSafe(entry.email) ? 1 : 0);
    return score(b) - score(a);
  });
}

function isGenericBusinessEmailSafe(email: string): boolean {
  // Generic inboxes are perfectly valid contacts; they are simply not a
  // deduplication identity. This only nudges ordering.
  const local = email.split("@")[0] ?? "";
  return ["info", "contact", "support", "sales", "hello"].includes(local);
}

/* ------------------------------ signal evidence --------------------------- */

const PAID_SIGNAL_PATTERNS = [
  /\b(subscri\w*|membership|member plan|premium plan|vip plan)\b/i,
  /\b(per month|\/month|\/mo\b|monthly|pcm|per year|\/year|annual)\b/i,
  /\b(price|pricing|plans?|packages?|pricing table)\b/i,
  /\b(join (now|today|the)|get access|start (now|today)|sign ?up)\b/i,
  /\b(checkout|paypal|stripe|whop|hotmart|kajabi|teachable)\b/i,
];

const SIGNAL_PRODUCT_PATTERNS = [
  /\b(signal|signals|trading signals?|buy signals?|sell signals?|entries|entry and exit)\b/i,
  /\b(take ?profit|stop ?loss|tp\d?|sl\d?|entry zone|trade alert)\b/i,
  /\b(vip|premium|private)\b.{0,24}\b(group|channel|community|signals?)\b/i,
  /\b(telegram|discord|whatsapp)\b.{0,40}\b(channel|group|community|signals?)\b/i,
];

const EXCLUSION_PATTERNS: { reason: string; pattern: RegExp }[] = [
  {
    reason: "broker or brokerage services",
    pattern: /\b(regulated broker|brokerage services?|become a broker|we are a broker|broker account|spread from|leverage up to|open an account with us)\b/i,
  },
  {
    reason: "indicator-only or bot-only product",
    pattern: /\b(metatrader indicator|mt4 indicator|mt5 indicator|expert advisor|trading bot|automated bot|copy ?trading (bot|platform) only)\b/i,
  },
  {
    reason: "education-only business",
    pattern: /\b(online course|video course|academy membership|learn to trade course|education(al)? (only|platform) (with )?no signals)\b/i,
  },
  {
    reason: "stocks or options only",
    pattern: /\b(stock (market )?(signals|tips)|nifty|bank nifty|sensex|equity signals|options (tips|signals))\b/i,
  },
  {
    reason: "financial news or general community",
    pattern: /\b(financial news|market news|news portal|general trading community|forum)\b/i,
  },
];

export interface SignalAssessment {
  /** True only when a paid/commercial signal product is evidenced. */
  qualified: boolean;
  /** Signal-product language was present. */
  hasSignalProduct: boolean;
  /** Commercial/pricing language was present. */
  hasCommercialIntent: boolean;
  /** Human-readable explanation, always populated. */
  reason: string;
  /** Matched exclusion, if any. */
  exclusion: string | null;
  matchedSignals: string[];
  matchedCommercial: string[];
}

/**
 * Deterministic check for "a business that sells trading signals for money".
 * Requires BOTH signal-product language and commercial/pricing language. This is
 * deliberately conservative: a mention of "forex" alone never qualifies.
 */
export function assessSignalEvidence(content: string): SignalAssessment {
  const text = content ?? "";
  const matchedSignals = SIGNAL_PRODUCT_PATTERNS.filter((pattern) =>
    pattern.test(text),
  ).map((pattern) => pattern.source);
  const matchedCommercial = PAID_SIGNAL_PATTERNS.filter((pattern) =>
    pattern.test(text),
  ).map((pattern) => pattern.source);

  for (const exclusion of EXCLUSION_PATTERNS) {
    if (exclusion.pattern.test(text)) {
      // An explicit "we do not offer signals" style exclusion outranks hints.
      return {
        qualified: false,
        hasSignalProduct: matchedSignals.length > 0,
        hasCommercialIntent: matchedCommercial.length > 0,
        reason: `Excluded: appears to be ${exclusion.reason}.`,
        exclusion: exclusion.reason,
        matchedSignals,
        matchedCommercial,
      };
    }
  }

  const hasSignalProduct = matchedSignals.length > 0;
  const hasCommercialIntent = matchedCommercial.length > 0;

  if (!hasSignalProduct) {
    return {
      qualified: false,
      hasSignalProduct,
      hasCommercialIntent,
      reason: "No trading-signal product language found on the official pages.",
      exclusion: null,
      matchedSignals,
      matchedCommercial,
    };
  }
  if (!hasCommercialIntent) {
    return {
      qualified: false,
      hasSignalProduct,
      hasCommercialIntent,
      reason:
        "Signal language found, but no evidence of a paid or commercial offering.",
      exclusion: null,
      matchedSignals,
      matchedCommercial,
    };
  }
  return {
    qualified: true,
    hasSignalProduct,
    hasCommercialIntent,
    reason: "Paid trading-signal offering evidenced on the official source.",
    exclusion: null,
    matchedSignals,
    matchedCommercial,
  };
}

/* ------------------------------ model judgment ---------------------------- */

export interface ModelVerdict {
  isSignalProvider: boolean;
  sellsPaidSignals: boolean;
  categories: Category[];
  businessName: string | null;
  country: string | null;
  signalDescription: string | null;
  pricingDetails: string | null;
  evidenceSummary: string | null;
  contactEmail: string | null;
  emailSourceUrl: string | null;
  exclusionReason: string | null;
  confidence: number;
  observation: string | null;
}

export function verdictSystemPrompt(): string {
  return [
    "You verify whether a business genuinely sells commercial trading signals.",
    "You are given text fetched from official pages. You must not invent facts.",
    "Only use what the provided text supports. Use null when something is not stated.",
    "Set isSignalProvider only when the business actually offers trading signals.",
    "Set sellsPaidSignals only when the text evidences payment, subscription, or a paid plan.",
    "Exclude brokers, education-only, indicator-only, bot-only, stocks/options-only,",
    "copy-trading-only, news sites and general communities by setting both flags false",
    "and explaining why in exclusionReason.",
    "It is always correct to answer that the business does not qualify.",
    "Return ONLY a JSON object with these keys:",
    '{"isSignalProvider":boolean,"sellsPaidSignals":boolean,',
    '"categories":string[],"businessName":string|null,"country":string|null,',
    '"signalDescription":string|null,"pricingDetails":string|null,',
    '"evidenceSummary":string|null,"contactEmail":string|null,',
    '"emailSourceUrl":string|null,"exclusionReason":string|null,',
    '"confidence":number,"observation":string|null}',
    'categories may only contain: "forex","metals","crypto","indices","commodities".',
    "observation is one specific, factual detail suitable for the opening line of an email to them.",
  ].join(" ");
}

export function buildVerdictPrompt(input: {
  businessName: string | null;
  websiteUrl: string | null;
  requirements: string;
  pages: { url: string; title: string; content: string }[];
  candidateEmails: string[];
}): string {
  const pageText = input.pages
    .map(
      (page, index) =>
        `--- PAGE ${index + 1}: ${page.url}\nTITLE: ${page.title}\n\n${page.content.slice(0, 6000)}`,
    )
    .join("\n\n");
  return [
    `Candidate business name (may be unreliable): ${input.businessName ?? "unknown"}`,
    `Official website: ${input.websiteUrl ?? "unknown"}`,
    `Qualification brief: ${input.requirements}`,
    `Email addresses found in the page text (may include third parties): ${
      input.candidateEmails.join(", ") || "none"
    }`,
    "",
    "Official page content follows.",
    pageText,
  ].join("\n");
}

export function normalizeModelVerdict(raw: any): ModelVerdict {
  const allowed = new Set<Category>([
    "forex",
    "metals",
    "crypto",
    "indices",
    "commodities",
  ]);
  const categories: Category[] = Array.isArray(raw?.categories)
    ? raw.categories
        .map((value: unknown) => String(value).toLowerCase().trim())
        .filter((value: string): value is Category =>
          allowed.has(value as Category),
        )
    : [];
  const str = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text && text.toLowerCase() !== "unknown" && text.toLowerCase() !== "null"
      ? text
      : null;
  };
  const confidence = Number(raw?.confidence);
  return {
    isSignalProvider: raw?.isSignalProvider === true,
    sellsPaidSignals: raw?.sellsPaidSignals === true,
    categories: [...new Set(categories)],
    businessName: str(raw?.businessName),
    country: str(raw?.country),
    signalDescription: str(raw?.signalDescription),
    pricingDetails: str(raw?.pricingDetails),
    evidenceSummary: str(raw?.evidenceSummary),
    contactEmail: str(raw?.contactEmail),
    emailSourceUrl: str(raw?.emailSourceUrl),
    exclusionReason: str(raw?.exclusionReason),
    confidence: Number.isFinite(confidence)
      ? Math.min(Math.max(confidence, 0), 1)
      : 0,
    observation: str(raw?.observation),
  };
}

/**
 * Chooses the contact email to store, preferring an address the model confirmed
 * and that was actually observed on an official page. The model can never
 * introduce an address that was not extracted from fetched content.
 */
export function resolveContactEmail(input: {
  extracted: ExtractedEmail[];
  modelEmail: string | null;
  modelSourceUrl: string | null;
  siteDomain: string | null;
}): { email: string; sourceUrl: string } | null {
  const ranked = rankContactEmails(input.extracted);
  if (!ranked.length) return null;
  const modelEmail = input.modelEmail ? normalizeEmail(input.modelEmail) : null;
  if (modelEmail) {
    const match = ranked.find((entry) => entry.email === modelEmail);
    if (match) {
      return {
        email: match.email,
        sourceUrl: input.modelSourceUrl?.trim() || match.sourceUrl,
      };
    }
  }
  // Fall back to the strongest observed address, but never to a model-invented
  // one. A same-domain or mailto address is required evidence.
  const best = ranked.find((entry) => entry.sameDomain) ?? ranked[0];
  if (!best) return null;
  return { email: best.email, sourceUrl: best.sourceUrl };
}

export function domainMatchesSite(url: string, siteDomain: string | null): boolean {
  if (!siteDomain) return false;
  return domainFromUrl(url) === siteDomain;
}
