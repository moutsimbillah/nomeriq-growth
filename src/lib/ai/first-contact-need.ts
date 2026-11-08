import type { LeadModel } from "@/lib/leads/model";

/**
 * What a first-contact email is allowed to say about the prospect's setup.
 *
 * This is the rule the plan states plainly, made executable: a draft may only
 * raise a need that the research actually evidenced. Three cases, and the
 * difference between them is the whole point —
 *
 *  - High fit with an evidenced gap: name that gap, because it was seen.
 *  - A mature platform (Low fit): do not pitch a replacement. Either a specific
 *    gap was evidenced, or the email has no product claim in it at all.
 *  - Unknown, or an unassessed lead: say nothing about their setup. "We did not
 *    look" is not "you don't have it", and a draft that implies otherwise is a
 *    claim the founder cannot back up on the call.
 *
 * Every drafting path reads this — the AI prompt, the deterministic template and
 * the research engine's automatic draft — so the three cannot drift apart.
 */
export type FirstContactNeed = {
  kind: "evidenced_gap" | "mature_platform" | "insufficient_evidence";
  /** The evidenced gap, when there is one, in the research's own words. */
  gap: string | null;
  /** The line that goes into the prompt: what may and may not be claimed. */
  directive: string;
};

const GAP_AREA = "gap";

export function firstContactNeed(model: LeadModel): FirstContactNeed {
  const gaps = model.capabilityGaps.filter(
    (finding) => finding.area === GAP_AREA && finding.verdict === "present",
  );
  const gap = gaps[0]?.summary?.trim() || null;
  const assessed = Boolean(model.assessmentId);

  // An assessed High or Medium fit is exactly the case where the research found
  // something concrete; that finding, and only that finding, may be raised.
  if (assessed && (model.productFit === "high" || model.productFit === "medium") && gap) {
    return {
      kind: "evidenced_gap",
      gap,
      directive:
        `The research evidenced one gap in how they run things: "${gap}". ` +
        `Lead with the business outcome that gap costs them, in one sentence. ` +
        `State it as something you noticed, never as a criticism, and never as a full feature list. ` +
        `Do not add a second gap, and do not describe any part of their setup that was not evidenced.`,
    };
  }

  // A mature platform: the reason this lead ranks low is that they already built
  // what Nomeriq sells. Pitching a replacement here reads as not having read
  // their site at all.
  if (assessed && model.productFit === "low") {
    return {
      kind: "mature_platform",
      gap: null,
      directive:
        `The research found a mature, integrated platform. Do NOT pitch replacing it and do NOT ` +
        `suggest anything is missing from it — no gap was evidenced. Write an email that asks about ` +
        `their operation without making any product claim, or leave the product sentence out entirely.`,
    };
  }

  return {
    kind: "insufficient_evidence",
    gap: null,
    directive:
      `There is not enough evidence about their setup to assert anything. Do NOT say or imply that ` +
      `they lack a platform, an app, automation or a dashboard, and do not describe their process as ` +
      `manual. Ask one open question about how they run their signal business today instead, and make ` +
      `no claim about what would help them.`,
  };
}
