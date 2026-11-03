import type { DraftWarning, ProductTruth } from "@/lib/types";
import { isEmail, wordCount } from "@/lib/utils";

const PERFORMANCE_TERMS = [
  /\bguarantee(?:d|s)?\b/i,
  /\brisk[- ]free\b/i,
  /\b100%\b/i,
  /\bwin rate\b/i,
  /\bproven results?\b/i,
  /\bdoubled?\b/i,
  /\bpassive income\b/i,
  /\bfinancial freedom\b/i,
  /\bnever lose\b/i,
];

const GENERIC_TERMS = [
  /i hope this (?:email )?finds you well/i,
  /game[- ]changer/i,
  /revolutionary/i,
  /cutting[- ]edge/i,
  /synerg(?:y|ies)/i,
  /circle back/i,
];

const FEATURE_TERMS = [
  "dashboard",
  "crm",
  "automation",
  "automate",
  "integration",
  "api",
  "analytics",
  "portal",
  "subscription management",
  "payment processing",
  "affiliate system",
  "ai assistant",
];

export function validateDraft(input: {
  subject: string;
  body: string;
  recipientEmail: string;
  truth: ProductTruth;
  aiGenerated: boolean;
}): DraftWarning[] {
  const warnings: DraftWarning[] = [];
  const body = input.body.trim();
  const subject = input.subject.trim();
  const normalizedCorpus = [
    input.truth.oneLiner,
    input.truth.offerSummary,
    input.truth.howItWorks,
    input.truth.pricingNotes,
    input.truth.integrations,
    input.truth.limitations,
    ...input.truth.approvedClaims,
  ]
    .join(" ")
    .toLowerCase();

  if (!isEmail(input.recipientEmail)) {
    warnings.push({
      code: "recipient_invalid",
      message: "The recipient is not a valid email address.",
      severity: "warning",
    });
  }
  if (subject.length < 4) {
    warnings.push({
      code: "subject_short",
      message: "Add a clear, relevant subject line.",
      severity: "warning",
    });
  }
  const words = wordCount(body);
  if (words < 40 || words > 100) {
    warnings.push({
      code: "length",
      message: `The email is ${words} words. First-contact emails normally run 40–100 words.`,
      severity: "info",
    });
  }
  if (!body.includes("?")) {
    warnings.push({
      code: "no_question",
      message: "There is no clear question. The first email should invite a real conversation.",
      severity: "warning",
    });
  }

  for (const pattern of PERFORMANCE_TERMS) {
    if (pattern.test(body) || pattern.test(subject)) {
      warnings.push({
        code: "unsupported_claim",
        message: `Potential unsupported commercial or performance claim: “${(body.match(pattern)?.[0] ?? subject.match(pattern)?.[0] ?? "").trim()}”.`,
        severity: "warning",
      });
      break;
    }
  }

  const pricingIsApproved =
    input.truth.status === "approved" &&
    /\d/.test(input.truth.pricingNotes) &&
    !/no pricing|not approved|do not quote/i.test(input.truth.pricingNotes);
  const moneyPattern = /(?:[$€£]\s?\d|\b(?:price|pricing|cost|discount|per month)\b)/i;
  const productPricingClaim =
    /(?:\bNomeriq\b|\bour\b)[^.!?\n]{0,120}(?:[$€£]\s?\d|\b(?:price|pricing|cost|discount)\b)/i.test(
      body,
    ) ||
    /(?:[$€£]\s?\d|\b(?:price|pricing|cost|discount)\b)[^.!?\n]{0,120}(?:\bNomeriq\b|\bour\b)/i.test(
      body,
    );
  if (productPricingClaim && moneyPattern.test(body) && !pricingIsApproved) {
    warnings.push({
      code: "pricing_not_approved",
      message:
        "This mentions pricing or commercial terms, but Product Truth has no founder-approved pricing for outreach.",
      severity: "warning",
    });
  }

  for (const term of FEATURE_TERMS) {
    if (
      new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(body) &&
      !normalizedCorpus.includes(term)
    ) {
      warnings.push({
        code: "feature_not_approved",
        message: `“${term}” is not in approved Product Truth. Confirm this claim before sending.`,
        severity: "warning",
      });
      break;
    }
  }

  for (const pattern of GENERIC_TERMS) {
    if (pattern.test(body)) {
      warnings.push({
        code: "generic_language",
        message: "The draft contains generic sales language. A specific, human note usually performs better.",
        severity: "info",
      });
      break;
    }
  }

  if (!input.aiGenerated && !body.includes("Nomeriq")) {
    warnings.push({
      code: "no_product_mention",
      message: "Nomeriq is not mentioned. That is allowed for a personal note, but check that it is intentional.",
      severity: "info",
    });
  }

  const seen = new Set<string>();
  return warnings.filter((warning) => {
    if (seen.has(warning.code)) return false;
    seen.add(warning.code);
    return true;
  });
}
