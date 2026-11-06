import type { ProductTruth } from "@/lib/types";

/**
 * Product Truth as every AI action receives it — one block, always in full, so Suggest with AI,
 * Simulate a test reply, first emails and follow-ups (and any future AI action) see the same facts.
 *
 * Browser-safe: the Product Truth page uses `productTruthGaps` to tell the founder what is missing.
 */

/** Seed placeholders that mean "the founder has not written this yet". */
const PLACEHOLDER = /\bfounder input needed\b|\bnot yet approved\b|\bhas not yet approved\b/i;

function field(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  return text ? text : "(empty)";
}

function list(values: readonly string[] | null | undefined, empty: string): string {
  const items = (values ?? []).map((value) => value.trim()).filter(Boolean);
  return items.length ? "\n- " + items.join("\n- ") : ` ${empty}`;
}

/** The section heading, with the version and status the founder checks in "Context used". */
export function productTruthHeading(truth: Pick<ProductTruth, "version" | "status">): string {
  const status = truth.status === "approved" ? "APPROVED" : "NEEDS REVIEW (not approved by the founder)";
  return `=== PRODUCT TRUTH · version ${truth.version} · ${status} — the only source for claims about Nomeriq ===`;
}

/** The full block: what Nomeriq is and offers, what may and may not be claimed, the questions to ask. */
export function productTruthBlock(truth: ProductTruth): string {
  const approved = truth.status === "approved";
  return [
    productTruthHeading(truth),
    approved
      ? "Rule: everything below is founder-approved. State it plainly, without hedging."
      : "Rule: this version is NOT approved. Only the one-liner and the approved claims may be stated as fact. The other fields are background; any sentence that relies on them, or on anything not written here, must be listed for the founder to confirm.",
    `What Nomeriq is (one-liner): ${field(truth.oneLiner)}`,
    `What Nomeriq offers: ${field(truth.offerSummary)}`,
    `How it works: ${field(truth.howItWorks)}`,
    `Pricing and commercial terms: ${field(truth.pricingNotes)}`,
    `Integrations: ${field(truth.integrations)}`,
    `Limitations: ${field(truth.limitations)}`,
    `May be claimed (approved claims):${list(truth.approvedClaims, "none")}`,
    `Must never be claimed:${list(truth.prohibitedClaims, "none listed")}`,
    `Questions to ask prospects (discovery):${list(truth.discoveryQuestions, "none written yet — ask one open question about how they run their signal business today")}`,
  ].join("\n");
}

export interface ProductTruthGap {
  field: string;
  problem: string;
}

/**
 * What is missing or unfinished, in the founder's terms. Empty when Product Truth is approved and
 * every section has real content.
 */
export function productTruthGaps(truth: ProductTruth): ProductTruthGap[] {
  const gaps: ProductTruthGap[] = [];
  if (truth.status !== "approved") {
    gaps.push({ field: "Approval", problem: `Version ${truth.version} is not approved, so AI may state only the one-liner and the approved claims as fact.` });
  }
  const sections: [string, string][] = [
    ["What Nomeriq offers", truth.offerSummary],
    ["How it works", truth.howItWorks],
    ["Approved pricing and commercial terms", truth.pricingNotes],
    ["Approved integrations", truth.integrations],
    ["Limitations and things not to claim", truth.limitations],
  ];
  for (const [name, value] of sections) {
    if (!value?.trim()) gaps.push({ field: name, problem: "Empty." });
    else if (PLACEHOLDER.test(value)) gaps.push({ field: name, problem: "Still the starting placeholder (\"founder input needed\")." });
  }
  const claims = (truth.approvedClaims ?? []).filter((claim) => claim.trim());
  if (claims.length <= 1) {
    gaps.push({
      field: "Approved claims",
      problem: claims.length
        ? "Only the one-liner is approved. Anything more specific — for example what white-label includes (your brand, domain, app, payments, onboarding time) — is not, so drafts flag it for your confirmation."
        : "None. AI has no product fact it may state.",
    });
  }
  if (!(truth.discoveryQuestions ?? []).some((question) => question.trim())) {
    gaps.push({ field: "Questions to ask prospects", problem: "None written yet." });
  }
  return gaps;
}
