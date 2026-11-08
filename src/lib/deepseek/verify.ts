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

/**
 * Reduces a URL to a comparison key that ignores inconsequential formatting
 * differences (a trailing slash on the bare origin, a `www.` prefix, case),
 * so a model that accurately echoes a fetched page's URL back with one of
 * these harmless variations is not treated as having invented a source.
 * Returns null for anything unparsable, which never matches anything.
 */
function canonicalUrlKey(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/$/, "");
    return `${url.protocol}//${host}${path}${url.search}`;
  } catch {
    return null;
  }
}

/**
 * Builds a lookup from every acceptable spelling of a fetched URL back to the
 * exact string it was fetched as, so a normalizer can both validate a model's
 * cited source and substitute the canonical form the rest of the pipeline
 * (page lists, official-source checks) already uses.
 */
function buildUrlIndex(validUrls: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const url of validUrls) {
    const key = canonicalUrlKey(url);
    if (key && !index.has(key)) index.set(key, url);
  }
  return index;
}

/** Resolves a model-cited source to the exact fetched URL it refers to, or null. */
function resolveSourceUrl(raw: unknown, index: Map<string, string>): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (index.has(trimmed)) return trimmed;
  const key = canonicalUrlKey(trimmed);
  return key ? index.get(key) ?? null : null;
}

/* --------------------------- lead-model assessment verdict -------------------------- */

/**
 * The lead-model areas from `docs/lead-rules.md` / `src/lib/leads/model.ts`'s
 * `findingSchema`. Kept as a literal union here (not imported) so this module,
 * which has no database dependency, stays usable from a pure unit test.
 */
export type AssessmentArea =
  | "paid_signals"
  | "markets"
  | "email"
  | "identity"
  | "activity"
  | "delivery"
  | "membership"
  | "dashboard"
  | "publishing"
  | "performance"
  | "payments"
  | "app"
  | "gap";

export interface AssessmentFinding {
  area: AssessmentArea;
  summary: string;
  sourceUrl: string;
  verdict: "present" | "absent" | "unknown";
  /** Only meaningful for area "activity": the date the activity itself happened. */
  activityAt: string | null;
}

export interface AudienceCandidate {
  platform: "instagram" | "youtube" | "telegram";
  accountUrl: string;
  handle: string | null;
  countValue: number | null;
  countState: "verified" | "unknown";
  displayedText: string | null;
  sourceUrl: string;
}

export interface ContactRouteCandidate {
  platform: string;
  routeKind: "dm" | "group" | "channel" | "bot" | "form" | "other";
  handle: string | null;
  routeUrl: string | null;
  officialStatus: "verified" | "unknown" | "unofficial";
  notes: string;
  sourceUrl: string;
}

export interface AssessmentVerdict {
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
  findings: AssessmentFinding[];
  capabilityGaps: AssessmentFinding[];
  platformMaturity: "unknown" | "fragmented" | "partial" | "integrated";
  mobileAppStatus: "unknown" | "verified_present" | "not_found_in_checked_sources" | "verified_absent";
  productFit: "high" | "medium" | "unknown" | "low";
  fitReasoning: string;
  researchConfidence: "unknown" | "low" | "medium" | "high";
  missingInformation: string[];
  audienceCandidates: AudienceCandidate[];
  contactRouteCandidates: ContactRouteCandidate[];
}

const ASSESSMENT_AREAS: AssessmentArea[] = [
  "paid_signals", "markets", "email", "identity", "activity", "delivery",
  "membership", "dashboard", "publishing", "performance", "payments", "app", "gap",
];

/**
 * The richer prompt for Part 2: one model call that both confirms qualification
 * (as before) and supplies the lead-model's evidence-first findings, so the
 * engine can save a modern assessment instead of only a legacy verdict. The
 * founder's rules (`docs/lead-rules.md`) govern every definition used here.
 */
export function assessmentVerdictSystemPrompt(): string {
  return [
    verdictSystemPrompt(),
    "In addition, support the lead-model assessment used to prioritise this business for Nomeriq's",
    "white-label platform. Every finding must cite one of the official page URLs you were given as",
    "its sourceUrl, and must be based only on what that page actually states — never invent a source",
    "or a fact the text does not support.",
    "findings: an array of {area, summary, sourceUrl, verdict, activityAt}. area is one of",
    `${JSON.stringify(ASSESSMENT_AREAS)}. verdict is "present", "absent" or "unknown". Only set verdict`,
    '"absent" when the page affirmatively shows the opposite (e.g. states no signals offered), never',
    "merely because a feature was not mentioned. activityAt is an ISO date, only for area \"activity\",",
    "and must be the date of the activity itself (a published result, a recent post), never today's date.",
    "capabilityGaps: findings with area \"gap\" describing an evidenced capability the business lacks",
    "that Nomeriq's platform could fill (e.g. no branded app, manual Telegram-only delivery, no dashboard).",
    "Never claim a gap merely because a feature was not found; say so in missingInformation instead.",
    "platformMaturity: \"fragmented\" (Telegram/Discord/WhatsApp/manual/basic site only), \"partial\" (own",
    'site with some automation but gaps), "integrated" (a complete proprietary platform with branded',
    'apps), or "unknown" when the pages do not show enough.',
    'mobileAppStatus: "verified_present" only if a branded app is actually evidenced (store listing or',
    'page reference), "verified_absent" only if the pages affirmatively show no app, otherwise',
    '"not_found_in_checked_sources" or "unknown".',
    "productFit: \"high\" when the business relies mainly on manual/basic tools with no comparable",
    "platform found; \"medium\" for partial infrastructure with an evidenced gap; \"low\" for a mature",
    "proprietary platform unless a credible gap is evidenced; \"unknown\" when evidence is insufficient.",
    "Never say a prospect has no platform or app merely because none was found — use unknown.",
    "fitReasoning: one or two sentences citing the actual evidence for the productFit you chose.",
    "researchConfidence: \"high\", \"medium\", \"low\" or \"unknown\", reflecting how much of the pages you",
    "could actually read.",
    "missingInformation: short strings naming what would need checking to firm up an unknown.",
    "audienceCandidates: official Instagram, YouTube or Telegram accounts you found linked from the",
    "official pages, each {platform, accountUrl, handle, countValue, countState, displayedText,",
    'sourceUrl}. countState is "verified" only when the page itself displays a follower/subscriber',
    'number; otherwise "unknown" and countValue null. Never estimate a count.',
    "contactRouteCandidates: non-email official contact routes you found (Telegram DM/channel, a",
    "contact form, WhatsApp), each {platform, routeKind, handle, routeUrl, officialStatus, notes,",
    'sourceUrl}. officialStatus is "verified" only when linked from the official site or profile.',
    "Add findings, audienceCandidates and capabilityGaps as empty arrays when the pages gave no",
    "evidence for them — never omit the keys.",
    "Return ONLY a JSON object with all of the base keys plus: findings, capabilityGaps,",
    "platformMaturity, mobileAppStatus, productFit, fitReasoning, researchConfidence,",
    "missingInformation, audienceCandidates, contactRouteCandidates.",
  ].join(" ");
}

export function buildAssessmentVerdictPrompt(input: {
  businessName: string | null;
  websiteUrl: string | null;
  requirements: string;
  pages: { url: string; title: string; content: string }[];
  candidateEmails: string[];
}): string {
  return buildVerdictPrompt(input);
}

function normalizeFinding(
  raw: any,
  urlIndex: Map<string, string>,
  requiredArea?: AssessmentArea,
): AssessmentFinding | null {
  if (!raw || typeof raw !== "object") return null;
  const area = String(raw.area ?? "").trim() as AssessmentArea;
  if (!ASSESSMENT_AREAS.includes(area)) return null;
  if (requiredArea && area !== requiredArea) return null;
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (summary.length < 3) return null;
  // The model can never introduce a source that was not actually fetched and
  // shown to it — the same rule already applied to the contact email. Minor
  // formatting differences (trailing slash, www.) are tolerated; anything else
  // is dropped rather than repaired.
  const sourceUrl = resolveSourceUrl(raw.sourceUrl, urlIndex);
  if (!sourceUrl) return null;
  const verdictRaw = String(raw.verdict ?? "present").trim();
  const verdict: AssessmentFinding["verdict"] =
    verdictRaw === "absent" || verdictRaw === "unknown" ? verdictRaw : "present";
  const activityAt =
    area === "activity" && typeof raw.activityAt === "string" && !Number.isNaN(Date.parse(raw.activityAt))
      ? new Date(raw.activityAt).toISOString()
      : null;
  return { area, summary: summary.slice(0, 4000), sourceUrl, verdict, activityAt };
}

function normalizeAudienceCandidate(raw: any, urlIndex: Map<string, string>): AudienceCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const platform = String(raw.platform ?? "").trim().toLowerCase();
  if (!["instagram", "youtube", "telegram"].includes(platform)) return null;
  let accountUrl: URL;
  try {
    accountUrl = new URL(String(raw.accountUrl ?? ""));
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(accountUrl.protocol)) return null;
  const sourceUrl = resolveSourceUrl(raw.sourceUrl, urlIndex);
  if (!sourceUrl) return null;
  const countState: AudienceCandidate["countState"] = raw.countState === "verified" ? "verified" : "unknown";
  // Number(null) is 0, not NaN — a null/missing countValue must never silently
  // become a real zero follower count.
  const countValue =
    countState === "verified" && typeof raw.countValue === "number" && Number.isFinite(raw.countValue) && raw.countValue >= 0
      ? Math.trunc(raw.countValue)
      : null;
  if (countState === "verified" && countValue === null) return null;
  return {
    platform: platform as AudienceCandidate["platform"],
    accountUrl: accountUrl.toString(),
    handle: typeof raw.handle === "string" && raw.handle.trim() ? raw.handle.trim() : null,
    countValue: countState === "verified" ? countValue : null,
    countState,
    displayedText:
      typeof raw.displayedText === "string" && raw.displayedText.trim() ? raw.displayedText.trim() : null,
    sourceUrl,
  };
}

function normalizeContactRouteCandidate(raw: any, urlIndex: Map<string, string>): ContactRouteCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const platform = typeof raw.platform === "string" ? raw.platform.trim() : "";
  if (!platform) return null;
  const routeKindRaw = String(raw.routeKind ?? "other").trim();
  const routeKind: ContactRouteCandidate["routeKind"] = (
    ["dm", "group", "channel", "bot", "form", "other"] as const
  ).includes(routeKindRaw as any)
    ? (routeKindRaw as ContactRouteCandidate["routeKind"])
    : "other";
  const sourceUrl = resolveSourceUrl(raw.sourceUrl, urlIndex);
  if (!sourceUrl) return null;
  const handle = typeof raw.handle === "string" && raw.handle.trim() ? raw.handle.trim() : null;
  let routeUrl: string | null = null;
  if (typeof raw.routeUrl === "string" && raw.routeUrl.trim()) {
    try {
      const url = new URL(raw.routeUrl.trim());
      if (["http:", "https:"].includes(url.protocol)) routeUrl = url.toString();
    } catch {
      routeUrl = null;
    }
  }
  if (!handle && !routeUrl) return null;
  const officialStatusRaw = String(raw.officialStatus ?? "unknown").trim();
  const officialStatus: ContactRouteCandidate["officialStatus"] =
    officialStatusRaw === "verified" || officialStatusRaw === "unofficial" ? officialStatusRaw : "unknown";
  return {
    platform,
    routeKind,
    handle,
    routeUrl,
    officialStatus,
    notes: typeof raw.notes === "string" ? raw.notes.slice(0, 2000) : "",
    sourceUrl,
  };
}

/**
 * Normalizes the model's raw JSON into an `AssessmentVerdict`, dropping (never
 * repairing) any finding, audience candidate or contact route whose sourceUrl
 * was not one of the pages actually fetched for this candidate. `validUrls`
 * must be exactly the URLs the model was shown.
 */
export function normalizeAssessmentVerdict(raw: any, validUrls: string[]): AssessmentVerdict {
  const base = normalizeModelVerdict(raw);
  const urls = buildUrlIndex(validUrls);
  const findings = Array.isArray(raw?.findings)
    ? raw.findings
        .map((entry: any) => normalizeFinding(entry, urls))
        .filter((entry: AssessmentFinding | null): entry is AssessmentFinding => entry !== null)
        .slice(0, 20)
    : [];
  const capabilityGaps = Array.isArray(raw?.capabilityGaps)
    ? raw.capabilityGaps
        .map((entry: any) => normalizeFinding(entry, urls, "gap"))
        .filter((entry: AssessmentFinding | null): entry is AssessmentFinding => entry !== null)
        .slice(0, 10)
    : [];
  const audienceCandidates = Array.isArray(raw?.audienceCandidates)
    ? raw.audienceCandidates
        .map((entry: any) => normalizeAudienceCandidate(entry, urls))
        .filter((entry: AudienceCandidate | null): entry is AudienceCandidate => entry !== null)
        .slice(0, 10)
    : [];
  const contactRouteCandidates = Array.isArray(raw?.contactRouteCandidates)
    ? raw.contactRouteCandidates
        .map((entry: any) => normalizeContactRouteCandidate(entry, urls))
        .filter((entry: ContactRouteCandidate | null): entry is ContactRouteCandidate => entry !== null)
        .slice(0, 10)
    : [];
  const maturityRaw = String(raw?.platformMaturity ?? "unknown").trim();
  const platformMaturity: AssessmentVerdict["platformMaturity"] = (
    ["fragmented", "partial", "integrated"] as const
  ).includes(maturityRaw as any)
    ? (maturityRaw as AssessmentVerdict["platformMaturity"])
    : "unknown";
  const appRaw = String(raw?.mobileAppStatus ?? "unknown").trim();
  const mobileAppStatus: AssessmentVerdict["mobileAppStatus"] = (
    ["verified_present", "not_found_in_checked_sources", "verified_absent"] as const
  ).includes(appRaw as any)
    ? (appRaw as AssessmentVerdict["mobileAppStatus"])
    : "unknown";
  const fitRaw = String(raw?.productFit ?? "unknown").trim();
  const productFit: AssessmentVerdict["productFit"] = (["high", "medium", "low"] as const).includes(
    fitRaw as any,
  )
    ? (fitRaw as AssessmentVerdict["productFit"])
    : "unknown";
  const confidenceRaw = String(raw?.researchConfidence ?? "unknown").trim();
  const researchConfidence: AssessmentVerdict["researchConfidence"] = (
    ["low", "medium", "high"] as const
  ).includes(confidenceRaw as any)
    ? (confidenceRaw as AssessmentVerdict["researchConfidence"])
    : "unknown";
  const missingInformation = Array.isArray(raw?.missingInformation)
    ? raw.missingInformation
        .map((entry: unknown) => String(entry).trim())
        .filter((entry: string) => entry.length > 0)
        .slice(0, 10)
    : [];
  return {
    ...base,
    findings,
    capabilityGaps,
    platformMaturity,
    mobileAppStatus,
    productFit,
    // Unknown fit with no supporting reasoning is still honest; never fabricate one.
    fitReasoning: typeof raw?.fitReasoning === "string" ? raw.fitReasoning.trim().slice(0, 2000) : "",
    researchConfidence,
    missingInformation,
    audienceCandidates,
    contactRouteCandidates,
  };
}
