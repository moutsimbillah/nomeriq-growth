import type { Category } from "@/lib/types";

/**
 * Search query planning.
 *
 * The engine must not hammer the same handful of English phrases. Queries are
 * generated from a market/language/intent matrix so a 100-lead target keeps
 * producing genuinely different searches, and every query is derived from the
 * job's real categories and regions rather than invented results.
 */

export interface PlannedQuery {
  query: string;
  market: Category | "general";
  language: string;
  /** Higher runs earlier. Purely a scheduling preference. */
  priority: number;
}

const MARKET_TERMS: Record<Category, string[]> = {
  forex: [
    '"forex signals"',
    '"FX signals"',
    '"forex signal provider"',
    '"forex VIP signals"',
    '"forex trading signals subscription"',
  ],
  metals: [
    '"gold signals"',
    '"XAUUSD signals"',
    '"silver signals"',
    '"gold trading signals"',
    '"XAU/USD VIP signals"',
  ],
  crypto: [
    '"crypto signals"',
    '"bitcoin signals"',
    '"crypto trading signals"',
    '"altcoin signals"',
    '"crypto VIP signals"',
  ],
  indices: [
    '"indices signals"',
    '"index trading signals"',
    '"US30 signals"',
    '"NAS100 signals"',
    '"DAX signals"',
  ],
  commodities: [
    '"commodities signals"',
    '"oil signals"',
    '"commodity trading signals"',
    '"natural gas signals"',
  ],
};

/** Commercial-intent qualifiers that keep results close to paid products. */
const COMMERCIAL_TERMS = [
  '"VIP"',
  '"subscription"',
  '"monthly"',
  '"premium"',
  '"membership"',
];

/** Optional surface hints. These widen discovery beyond official websites. */
const SURFACE_TERMS = [
  "site:instagram.com",
  "site:t.me",
  "site:youtube.com",
  "site:discord.com",
  "",
];

export const SUPPORTED_LANGUAGES: { code: string; label: string; terms: string[] }[] = [
  { code: "en", label: "English", terms: ['"signals"', '"trading signals"'] },
  { code: "es", label: "Spanish", terms: ['"señales"', '"señales de trading"'] },
  { code: "pt", label: "Portuguese", terms: ['"sinais"', '"sinais de trading"'] },
  { code: "ar", label: "Arabic", terms: ['"توصيات"', '"اشارات"'] },
  { code: "tr", label: "Turkish", terms: ['"sinyal"', '"forex sinyalleri"'] },
  { code: "id", label: "Indonesian", terms: ['"sinyal"', '"sinyal trading"'] },
  { code: "de", label: "German", terms: ['"Signale"', '"Trading Signale"'] },
  { code: "fr", label: "French", terms: ['"signaux"', '"signaux de trading"'] },
  { code: "it", label: "Italian", terms: ['"segnali"', '"segnali di trading"'] },
  { code: "pl", label: "Polish", terms: ['"sygnały"', '"sygnały tradingowe"'] },
  { code: "ja", label: "Japanese", terms: ['"シグナル"', '"為替 シグナル"'] },
  { code: "ko", label: "Korean", terms: ['"신호"', '"FX 신호"'] },
];

const REGION_HINTS: { match: RegExp; language: string; term: string }[] = [
  { match: /spanish|latam|latin|spain|mexic|argentin|colombi/i, language: "es", term: '"señales"' },
  { match: /portugu|brazil|brasil/i, language: "pt", term: '"sinais"' },
  { match: /arab|middle east|gulf|uae|saudi|egypt/i, language: "ar", term: '"توصيات"' },
  { match: /turk|türk/i, language: "tr", term: '"sinyal"' },
  { match: /indonesi/i, language: "id", term: '"sinyal"' },
  { match: /german|deutsch|germany|austria|swiss/i, language: "de", term: '"Signale"' },
  { match: /french|france|franc/i, language: "fr", term: '"signaux"' },
  { match: /ital/i, language: "it", term: '"segnali"' },
  { match: /polish|poland/i, language: "pl", term: '"sygnały"' },
  { match: /japan/i, language: "ja", term: '"シグナル"' },
  { match: /korea/i, language: "ko", term: '"신호"' },
];

function termsForCategory(category: Category, language: string): string[] {
  const base = MARKET_TERMS[category];
  if (language === "en") return base;
  const localized = SUPPORTED_LANGUAGES.find((entry) => entry.code === language);
  if (!localized) return base;
  // Pair one English market term with one localized signal term so a
  // non-English query is still anchored to the market.
  return base.slice(0, 3).map((term) => `${term} ${localized.terms[0]}`);
}

/**
 * Builds a deterministic-but-diverse, deduplicated query plan for a job.
 * `offset` lets a resumed worker continue deeper into the plan rather than
 * restarting the same first queries.
 */
export function planResearchQueries(input: {
  categories: Category[];
  regions?: string | null;
  offset?: number;
  limit?: number;
}): PlannedQuery[] {
  const categories = input.categories.length
    ? input.categories
    : (["forex", "metals", "crypto", "indices", "commodities"] as Category[]);
  const regions = input.regions ?? "";
  const preferredLanguages = new Set<string>(["en"]);
  for (const hint of REGION_HINTS) {
    if (hint.match.test(regions)) preferredLanguages.add(hint.language);
  }

  const seen = new Set<string>();
  const planned: PlannedQuery[] = [];

  const push = (
    query: string,
    market: Category | "general",
    language: string,
    priority: number,
  ) => {
    const normalized = query.replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length > 128) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    planned.push({ query: normalized, market, language, priority });
  };

  // Highest priority: the founder's actual markets, in English, with commercial
  // intent. These are the most likely to surface real paid providers.
  for (const category of categories) {
    for (const term of MARKET_TERMS[category]) {
      for (const commercial of COMMERCIAL_TERMS) {
        push(`${term} ${commercial} "signals"`, category, "en", 0);
      }
    }
  }

  // Then the same markets across region-implied languages.
  for (const category of categories) {
    for (const language of preferredLanguages) {
      if (language === "en") continue;
      for (const term of termsForCategory(category, language)) {
        push(term, category, language, 1);
      }
    }
  }

  // Then non-English languages broadly, so worldwide coverage is real even when
  // the founder did not name a region.
  for (const category of categories) {
    for (const language of SUPPORTED_LANGUAGES) {
      if (preferredLanguages.has(language.code)) continue;
      for (const term of language.terms) {
        push(`${MARKET_TERMS[category][0]} ${term}`, category, language.code, 2);
      }
    }
  }

  // Finally, surface hints for channels where signal businesses actually sell.
  for (const category of categories) {
    for (const surface of SURFACE_TERMS) {
      if (!surface) continue;
      push(
        `${MARKET_TERMS[category][0]} "VIP" ${surface}`,
        category,
        "en",
        3,
      );
    }
  }

  planned.sort((a, b) => a.priority - b.priority);
  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.min(Math.max(input.limit ?? planned.length, 1), 500);
  return planned.slice(offset, offset + limit);
}

export function totalPlannedQueries(categories: Category[]): number {
  return planResearchQueries({ categories, limit: 500 }).length;
}
