import { describe, expect, it } from "vitest";
import {
  normalizeAssessmentVerdict,
  assessmentVerdictSystemPrompt,
  type AssessmentVerdict,
} from "@/lib/deepseek/verify";

/**
 * `normalizeAssessmentVerdict` is the gate between the model's raw JSON and the
 * lead-model assessment the engine will eventually save (Part 2). Its one job
 * is to never let the model introduce a source, a count or a route that was not
 * actually fetched and shown to it — the same principle already enforced for
 * `contactEmail` by `normalizeModelVerdict`.
 */
describe("normalizeAssessmentVerdict", () => {
  const PAGE_A = "https://example.com/";
  const PAGE_B = "https://example.com/contact";
  const validUrls = [PAGE_A, PAGE_B];

  const baseRaw = {
    isSignalProvider: true,
    sellsPaidSignals: true,
    categories: ["forex"],
    businessName: "Acme Signals",
    country: null,
    signalDescription: "VIP signals",
    pricingDetails: "$49/mo",
    evidenceSummary: "Paid plan evidenced.",
    contactEmail: "hello@example.com",
    emailSourceUrl: PAGE_B,
    exclusionReason: null,
    confidence: 0.9,
    observation: "They publish live results.",
  };

  it("keeps a finding whose sourceUrl was actually fetched", () => {
    const verdict = normalizeAssessmentVerdict(
      {
        ...baseRaw,
        findings: [
          { area: "paid_signals", summary: "Pricing page lists a $49/mo VIP plan.", sourceUrl: PAGE_B, verdict: "present" },
        ],
      },
      validUrls,
    );
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0].area).toBe("paid_signals");
    expect(verdict.findings[0].sourceUrl).toBe(PAGE_B);
  });

  it("drops a finding whose sourceUrl was never fetched", () => {
    const verdict = normalizeAssessmentVerdict(
      {
        ...baseRaw,
        findings: [
          { area: "paid_signals", summary: "Invented.", sourceUrl: "https://other-site.example/pricing", verdict: "present" },
        ],
      },
      validUrls,
    );
    expect(verdict.findings).toHaveLength(0);
  });

  it("drops a finding with an unrecognised area, and clamps verdict to a known value", () => {
    const verdict = normalizeAssessmentVerdict(
      {
        ...baseRaw,
        findings: [
          { area: "not_a_real_area", summary: "x".repeat(10), sourceUrl: PAGE_A, verdict: "present" },
          { area: "markets", summary: "Forex pairs listed.", sourceUrl: PAGE_A, verdict: "maybe" },
        ],
      },
      validUrls,
    );
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0].verdict).toBe("present");
  });

  it("keeps activityAt only for area activity, and drops an unparsable date", () => {
    const verdict = normalizeAssessmentVerdict(
      {
        ...baseRaw,
        findings: [
          { area: "activity", summary: "Posted results on 1 Nov.", sourceUrl: PAGE_A, verdict: "present", activityAt: "2026-11-01T00:00:00.000Z" },
          { area: "markets", summary: "Forex pairs listed.", sourceUrl: PAGE_A, verdict: "present", activityAt: "2026-11-01T00:00:00.000Z" },
        ],
      },
      validUrls,
    );
    const activity = verdict.findings.find((f) => f.area === "activity");
    const markets = verdict.findings.find((f) => f.area === "markets");
    expect(activity?.activityAt).toBe("2026-11-01T00:00:00.000Z");
    expect(markets?.activityAt).toBeNull();
  });

  it("restricts capabilityGaps to area \"gap\" even if the model mislabels one", () => {
    const verdict = normalizeAssessmentVerdict(
      {
        ...baseRaw,
        capabilityGaps: [
          { area: "gap", summary: "No branded app found.", sourceUrl: PAGE_A, verdict: "present" },
          { area: "paid_signals", summary: "Wrong area for a gap.", sourceUrl: PAGE_A, verdict: "present" },
        ],
      },
      validUrls,
    );
    expect(verdict.capabilityGaps).toHaveLength(1);
    expect(verdict.capabilityGaps[0].area).toBe("gap");
  });

  it("keeps a verified audience candidate with a real count and a fetched sourceUrl", () => {
    const verdict = normalizeAssessmentVerdict(
      {
        ...baseRaw,
        audienceCandidates: [
          {
            platform: "instagram",
            accountUrl: "https://instagram.com/acmesignals",
            handle: "@acmesignals",
            countValue: 12500,
            countState: "verified",
            displayedText: "12.5K followers",
            sourceUrl: PAGE_A,
          },
        ],
      },
      validUrls,
    );
    expect(verdict.audienceCandidates).toHaveLength(1);
    expect(verdict.audienceCandidates[0].countValue).toBe(12500);
  });

  it("drops an audience candidate claiming verified with no numeric count", () => {
    const verdict = normalizeAssessmentVerdict(
      {
        ...baseRaw,
        audienceCandidates: [
          {
            platform: "instagram",
            accountUrl: "https://instagram.com/acmesignals",
            handle: "@acmesignals",
            countValue: null,
            countState: "verified",
            displayedText: null,
            sourceUrl: PAGE_A,
          },
        ],
      },
      validUrls,
    );
    expect(verdict.audienceCandidates).toHaveLength(0);
  });

  it("never invents a count: unknown countState always clears countValue", () => {
    const verdict = normalizeAssessmentVerdict(
      {
        ...baseRaw,
        audienceCandidates: [
          {
            platform: "youtube",
            accountUrl: "https://youtube.com/@acmesignals",
            handle: null,
            countValue: 999999,
            countState: "unknown",
            displayedText: null,
            sourceUrl: PAGE_A,
          },
        ],
      },
      validUrls,
    );
    expect(verdict.audienceCandidates[0].countValue).toBeNull();
    expect(verdict.audienceCandidates[0].countState).toBe("unknown");
  });

  it("drops an audience candidate on an unsupported platform", () => {
    const verdict = normalizeAssessmentVerdict(
      {
        ...baseRaw,
        audienceCandidates: [
          { platform: "tiktok", accountUrl: "https://tiktok.com/@acme", handle: null, countValue: null, countState: "unknown", displayedText: null, sourceUrl: PAGE_A },
        ],
      },
      validUrls,
    );
    expect(verdict.audienceCandidates).toHaveLength(0);
  });

  it("keeps a contact route with a handle or URL and a fetched sourceUrl", () => {
    const verdict = normalizeAssessmentVerdict(
      {
        ...baseRaw,
        contactRouteCandidates: [
          { platform: "telegram", routeKind: "channel", handle: "@acmesignals", routeUrl: null, officialStatus: "verified", notes: "Linked from homepage footer.", sourceUrl: PAGE_A },
        ],
      },
      validUrls,
    );
    expect(verdict.contactRouteCandidates).toHaveLength(1);
    expect(verdict.contactRouteCandidates[0].platform).toBe("telegram");
  });

  it("drops a contact route with neither handle nor URL", () => {
    const verdict = normalizeAssessmentVerdict(
      {
        ...baseRaw,
        contactRouteCandidates: [
          { platform: "telegram", routeKind: "channel", handle: null, routeUrl: null, officialStatus: "verified", notes: "", sourceUrl: PAGE_A },
        ],
      },
      validUrls,
    );
    expect(verdict.contactRouteCandidates).toHaveLength(0);
  });

  it("drops a contact route whose sourceUrl was never fetched", () => {
    const verdict = normalizeAssessmentVerdict(
      {
        ...baseRaw,
        contactRouteCandidates: [
          { platform: "telegram", routeKind: "channel", handle: "@acme", routeUrl: null, officialStatus: "verified", notes: "", sourceUrl: "https://not-fetched.example/" },
        ],
      },
      validUrls,
    );
    expect(verdict.contactRouteCandidates).toHaveLength(0);
  });

  it("falls back every enum to unknown rather than guessing", () => {
    const verdict: AssessmentVerdict = normalizeAssessmentVerdict(baseRaw, validUrls);
    expect(verdict.platformMaturity).toBe("unknown");
    expect(verdict.mobileAppStatus).toBe("unknown");
    expect(verdict.productFit).toBe("unknown");
    expect(verdict.researchConfidence).toBe("unknown");
    expect(verdict.findings).toEqual([]);
    expect(verdict.capabilityGaps).toEqual([]);
    expect(verdict.audienceCandidates).toEqual([]);
    expect(verdict.contactRouteCandidates).toEqual([]);
    expect(verdict.missingInformation).toEqual([]);
  });

  it("accepts a well-formed productFit/platformMaturity/mobileAppStatus set", () => {
    const verdict = normalizeAssessmentVerdict(
      {
        ...baseRaw,
        platformMaturity: "fragmented",
        mobileAppStatus: "verified_absent",
        productFit: "high",
        researchConfidence: "medium",
        fitReasoning: "Relies entirely on manual Telegram posting with no subscriber platform.",
        missingInformation: ["Could not check payment processor."],
      },
      validUrls,
    );
    expect(verdict.platformMaturity).toBe("fragmented");
    expect(verdict.mobileAppStatus).toBe("verified_absent");
    expect(verdict.productFit).toBe("high");
    expect(verdict.researchConfidence).toBe("medium");
    expect(verdict.fitReasoning).toContain("manual Telegram");
    expect(verdict.missingInformation).toEqual(["Could not check payment processor."]);
  });

  it("rejects an invalid enum value rather than passing it through", () => {
    const verdict = normalizeAssessmentVerdict(
      { ...baseRaw, platformMaturity: "super-advanced", productFit: "extremely-high" },
      validUrls,
    );
    expect(verdict.platformMaturity).toBe("unknown");
    expect(verdict.productFit).toBe("unknown");
  });

  it("caps findings, capabilityGaps and candidate arrays so one reply cannot flood the assessment", () => {
    const manyFindings = Array.from({ length: 30 }, (_, i) => ({
      area: "markets",
      summary: `Finding ${i}`,
      sourceUrl: PAGE_A,
      verdict: "present",
    }));
    const verdict = normalizeAssessmentVerdict({ ...baseRaw, findings: manyFindings }, validUrls);
    expect(verdict.findings.length).toBeLessThanOrEqual(20);
  });

  it("still exposes the base legacy verdict fields unchanged", () => {
    const verdict = normalizeAssessmentVerdict(baseRaw, validUrls);
    expect(verdict.isSignalProvider).toBe(true);
    expect(verdict.contactEmail).toBe("hello@example.com");
    expect(verdict.categories).toEqual(["forex"]);
  });
});

describe("assessmentVerdictSystemPrompt", () => {
  it("names every lead-model area and the new result keys the normalizer expects", () => {
    const prompt = assessmentVerdictSystemPrompt();
    for (const area of [
      "paid_signals", "markets", "email", "identity", "activity", "delivery",
      "membership", "dashboard", "publishing", "performance", "payments", "app", "gap",
    ]) {
      expect(prompt).toContain(area);
    }
    for (const key of [
      "findings", "capabilityGaps", "platformMaturity", "mobileAppStatus",
      "productFit", "fitReasoning", "researchConfidence", "missingInformation",
      "audienceCandidates", "contactRouteCandidates",
    ]) {
      expect(prompt).toContain(key);
    }
  });

  it("instructs the model never to invent a source or a count", () => {
    const prompt = assessmentVerdictSystemPrompt();
    expect(prompt.toLowerCase()).toContain("never invent a source");
    expect(prompt.toLowerCase()).toContain("never estimate a count");
  });
});
