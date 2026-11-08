import { describe, expect, it } from "vitest";

import { firstContactNeed } from "@/lib/ai/first-contact-need";
import { emptyLeadModel, type LeadModel } from "@/lib/leads/model";

/**
 * The rule the plan states, made checkable: a draft may raise a need only when
 * the research evidenced one. Each case below is a way a draft could otherwise
 * claim something the founder cannot stand behind on the call.
 */
function model(overrides: Partial<LeadModel>): LeadModel {
  return { ...emptyLeadModel(), ...overrides };
}

const evidencedGap = {
  area: "gap" as const,
  summary: "No branded subscriber platform or web dashboard was evidenced.",
  verdict: "present" as const,
  sourceUrl: "https://senales.example.test/vip",
  observedAt: "2026-11-02T09:00:00Z",
};

describe("what a first email may claim about their setup", () => {
  it("names the evidenced gap for a High fit, and nothing more", () => {
    const need = firstContactNeed(
      model({
        assessmentId: "a1",
        productFit: "high",
        platformMaturity: "fragmented",
        capabilityGaps: [evidencedGap],
      }),
    );
    expect(need.kind).toBe("evidenced_gap");
    expect(need.gap).toBe(evidencedGap.summary);
    expect(need.directive).toContain(evidencedGap.summary);
    // One gap only: the directive must not invite a feature list.
    expect(need.directive).toContain("Do not add a second gap");
  });

  it("refuses to pitch a replacement to a mature platform", () => {
    const need = firstContactNeed(model({ assessmentId: "a1", productFit: "low", platformMaturity: "integrated" }));
    expect(need.kind).toBe("mature_platform");
    expect(need.gap).toBeNull();
    expect(need.directive).toContain("Do NOT pitch replacing it");
  });

  it("still allows an evidenced gap on a mature platform", () => {
    // The plan says "no replacement pitch without an evidenced gap" — with one,
    // the gap is the message, and the model must not be told to stay silent.
    const need = firstContactNeed(
      model({ assessmentId: "a1", productFit: "medium", capabilityGaps: [evidencedGap] }),
    );
    expect(need.kind).toBe("evidenced_gap");
  });

  it("says nothing about the setup when the lead was never assessed", () => {
    // No assessment id: this is the case the whole change exists for. The old
    // prompt let the model infer absence from an empty research block.
    const need = firstContactNeed(model({ productFit: "unknown" }));
    expect(need.kind).toBe("insufficient_evidence");
    expect(need.directive).toContain("not enough evidence");
    expect(need.directive).toContain("Do NOT say or imply");
    expect(need.directive).toContain("Ask one open question");
  });

  it("ignores a gap that was only recorded as absent", () => {
    // A finding with verdict "absent" is the model's own note that it did not
    // find the thing; it is not evidence of a gap and must not become a claim.
    const need = firstContactNeed(
      model({
        assessmentId: "a1",
        productFit: "high",
        capabilityGaps: [{ ...evidencedGap, verdict: "absent" }],
      }),
    );
    expect(need.kind).toBe("insufficient_evidence");
  });

  it("never invents a gap from an unrelated finding area", () => {
    const need = firstContactNeed(
      model({
        assessmentId: "a1",
        productFit: "high",
        findings: [{ ...evidencedGap, area: "delivery" }],
      }),
    );
    expect(need.kind).toBe("insufficient_evidence");
  });
});
