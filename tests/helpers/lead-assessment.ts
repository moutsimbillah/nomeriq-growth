import type { LeadFinding } from "@/lib/leads/model";

/**
 * A minimal MODERN assessment that genuinely describes a paid signal seller on its own official
 * website, for tests whose subject is something else (audit logging, connector names, drafts).
 *
 * The backend still checks it: every finding points at the lead's own site, the required areas are
 * present, and no unknown/absent verdict is upgraded. It derives the lead's tier from the evidence
 * exactly like a research caller would, so a fixture using it is verified for the right reason
 * rather than through a legacy `qualificationStatus: "verified"` label, which now saves a candidate.
 */
export function assessmentFor(website: string, options: { email?: boolean } = {}) {
  const site = website.replace(/\/$/, "");
  const observedAt = new Date().toISOString();
  const fact = (area: LeadFinding["area"]): LeadFinding => ({
    area,
    summary: `Synthetic official ${area} evidence observed on the provider's own site`,
    sourceUrl: `${site}/signals`,
    observedAt,
    verdict: "present",
  });
  const areas: LeadFinding["area"][] = ["paid_signals", "markets", "identity", "activity"];
  if (options.email !== false) areas.push("email");
  return { assessedAt: observedAt, eligibility: "eligible" as const, findings: areas.map(fact) };
}