/**
 * A mechanical, deterministic draft check — no AI call, and it never edits a draft.
 *
 * It exists because the founder approves a whole batch of prepared drafts in one action, so the cheap
 * failure classes must be caught before that action, not one email at a time afterwards. It is a
 * *mechanical* gate: it refuses on patterns, not on judgement.
 *
 * BE HONEST ABOUT ITS LIMITS. This function cannot prove any claim in a draft is TRUE, useful, kind or
 * on-brand; it cannot tell a good sentence from a bad one. It catches mechanical failure classes only —
 * an unresolved merge placeholder, a stray price or percentage, an empty subject, a draft that never
 * names the recipient's own business, and a message that would carry no unsubscribe footer. Draft
 * bodies intentionally omit sign-off; Growth appends it when rendering and sending. Everything about
 * truthfulness, relevance and quality stays with the founder's eye and the AI claim validator (`@/lib/ai/claims`).
 */

export type DraftCheckRule =
  | "unresolved_placeholder"
  | "currency_or_percentage"
  | "empty_subject"
  | "no_recipient_mention"
  | "no_unsubscribe_footer";

export interface DraftCheckRefusal {
  draftId: string;
  rule: DraftCheckRule;
  message: string;
}

export interface DraftMechanicsInput {
  id: string;
  subject: string;
  body: string;
  /** The recipient's own business name, when known. Used for the "must name them" rule. */
  companyName?: string | null;
  /** The recipient's name, when known. A draft naming either them or their business passes. */
  recipientName?: string | null;
  /**
   * The compliance footer Growth will append to this message at send (legal lines + unsubscribe).
   * Drafts never store the footer by design, so "lacks the unsubscribe footer" can only mean "the
   * send path would attach none" — this is that footer, resolved by the caller.
   */
  complianceFooter?: string | null;
}

/**
 * An unresolved placeholder. Deliberately small and explicit: mustaches, the bracketed tokens the
 * outreach vocabulary uses, and the two literal markers writers leave behind.
 */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\{\{[^{}]*\}\}/,
  /\[(?:first\s?name|last\s?name|name|full\s?name|company|business|company\s?name|city|country|product|insert[^\]]*)\]/i,
  /\bTODO\b/,
  /\bXXX\b/,
];

/** A currency amount or a percentage claim. Outreach must never quote prices or results. */
const CURRENCY_PATTERN =
  /(?:[$€£₨₹]\s?\d|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|eur|gbp|pkr|inr|dollars?)\b|\b(?:usd|eur|gbp|pkr|inr|dollars?)\s?\d)/i;
const PERCENT_PATTERN = /\b\d+(?:\.\d+)?\s?(?:%|percent\b)/i;

/** Words too generic to count as "naming" the recipient's own business. */
const NAME_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "ltd",
  "llc",
  "inc",
  "co",
  "corp",
  "company",
  "group",
  "holdings",
  "trading",
  "limited",
]);

/** True when the text names the given business or contact by a distinctive word of it. */
function mentions(text: string, name: string | null | undefined): boolean {
  if (!name || !name.trim()) return false;
  const haystack = text.toLowerCase();
  const normalised = name.trim().toLowerCase();
  if (haystack.includes(normalised)) return true;
  return normalised
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4 && !NAME_STOPWORDS.has(word))
    .some((word) => haystack.includes(word));
}

/**
 * The compliance footer Growth will attach for a message: the legal lines plus the unsubscribe line.
 * Deterministic and token-free — the real send creates the per-recipient token; this only proves the
 * send path carries an unsubscribe footer at all.
 */
export function complianceFooterPreview(settings: {
  legalBusinessName?: string | null;
  postalAddress?: string | null;
  postalAddressEnabled?: boolean;
  footerNote?: string | null;
}): string {
  const lines = [
    settings.legalBusinessName?.trim(),
    settings.postalAddressEnabled ? settings.postalAddress?.trim() : "",
    settings.footerNote?.trim(),
  ].filter((line): line is string => Boolean(line));
  return [...lines, "Unsubscribe: <generated per recipient at send>"].join("\n");
}

/**
 * Every mechanical reason this draft should not go out in a batch, each naming the rule and the
 * draft id. An empty array means the draft passed the mechanical gate — not that it is good.
 */
export function checkDraftMechanics(input: DraftMechanicsInput): DraftCheckRefusal[] {
  const refusals: DraftCheckRefusal[] = [];
  const add = (rule: DraftCheckRule, message: string) =>
    refusals.push({ draftId: input.id, rule, message });

  const subject = input.subject ?? "";
  const body = input.body ?? "";

  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(body) || pattern.test(subject))) {
    add(
      "unresolved_placeholder",
      "It still contains an unresolved placeholder ({{...}}, [name], [company], TODO or XXX).",
    );
  }
  if (CURRENCY_PATTERN.test(body) || CURRENCY_PATTERN.test(subject)) {
    add("currency_or_percentage", "It contains a currency amount, which outreach must never quote.");
  }
  if (PERCENT_PATTERN.test(body) || PERCENT_PATTERN.test(subject)) {
    add("currency_or_percentage", "It contains a percentage claim, which outreach must never make.");
  }
  if (!subject.trim()) {
    add("empty_subject", "It has an empty subject line.");
  }
  // Only judgeable when the recipient is known: with no name we cannot prove a failure, so we do not
  // invent one. The batch always passes the prospect's own business name, so it is always judged there.
  if (input.companyName || input.recipientName) {
    if (!mentions(`${subject}\n${body}`, input.companyName) && !mentions(`${subject}\n${body}`, input.recipientName)) {
      add(
        "no_recipient_mention",
        "It never names the recipient's own business or its contact person.",
      );
    }
  }
  const footer = input.complianceFooter;
  if (!footer || !/unsubscribe/i.test(footer)) {
    add(
      "no_unsubscribe_footer",
      "No unsubscribe footer would be attached to this message.",
    );
  }

  return refusals;
}
