import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transformSync } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LeadQualificationView } from "@/components/lead-qualification";

// Compile the real TSX: Next preserves JSX, while this test needs executable React elements.
const compiled = transformSync(readFileSync("src/components/lead-qualification.tsx", "utf8"), {
  loader: "tsx", format: "cjs", jsx: "automatic",
}).code;
const compiledModule = { exports: {} as Record<string, (...args: any[]) => any> };
new Function("require", "module", "exports", compiled)(createRequire(import.meta.url), compiledModule, compiledModule.exports);
const components = compiledModule.exports;
const render = (name: string, props: object) => renderToStaticMarkup(createElement(components[name], props));
const model: LeadQualificationView = {
  tier: null, productFit: "unknown", platformMaturity: "unknown", mobileAppStatus: "unknown",
  fitReasoning: "", priorityScore: null, priorityProvisional: true, researchConfidence: "unknown",
  assessedAt: null, overriddenFields: [], capabilityGaps: [], findings: [], missingInformation: [],
  audiences: [], contactRoutes: [],
};

it("does not invent a tier, technology assessment, audience or score for existing unassessed leads", () => {
  expect(render("LeadQualificationPills", { model })).toContain("Unassessed");
  expect(render("LeadQualificationPills", { model })).toContain("Unknown fit");
  expect(render("PriorityLabel", { model })).toContain('data-priority-score="unknown"');
  const panel = render("ProductFitPanel", { model });
  expect(panel).toContain("has not been investigated sufficiently");
  expect(panel).toContain("No platform gap is assumed");
  expect(panel).not.toContain('data-product-fit="low"');
  expect(render("AudiencePills", { accounts: [] })).toContain("Audience unknown");
});

it("all four outreach tiers have distinct pills, with Category B's no-email tooltip", () => {
  const html = ["tier_1", "other", "email_no_website", "category_b"].map(tier => render("TierPill", { tier }));
  for (const label of ["Tier 1", "Other", "Email no website", "Category B"]) expect(html.join(" ")).toContain(label);
  expect(html[3]).toContain("never emailed");
  expect(html[0]).toContain("text-emerald-800");
  expect(html[1]).toContain("text-sky-800");
  expect(html[2]).toContain("text-violet-800");
  expect(html[3]).toContain("text-amber-800");
});

it("compact audience numbers are formatting only, and Unknown never turns into zero", () => {
  expect(components.audienceCountLabel(null)).toBe("Unknown");
  expect(components.audienceCountLabel(-1)).toBe("Unknown");
  expect(components.audienceCountLabel(Number.MAX_SAFE_INTEGER + 1)).toBe("Unknown");
  expect(components.audienceCountLabel(0)).toBe("0");
  expect(components.audienceCountLabel(10500)).toBe("~10.5K");
  expect(components.audienceCountLabel(342, true)).toBe("~342");
});

it("renders every account separately with handle, platform, date and Unknown, without any combined total", () => {
  const accounts = [
    { id: "a", platform: "instagram", accountKey: "provider", handle: "@provider", accountUrl: "https://instagram.com/provider", countValue: 10500, countState: "verified", checkedAt: "2026-11-07T00:00:00Z", sourceUrl: "https://instagram.com/provider", isApproximate: true },
    { id: "b", platform: "youtube", accountKey: "provider-video", handle: "@provider-video", accountUrl: "https://youtube.com/@provider-video", countValue: null, countState: "unknown", checkedAt: "2026-11-07T00:00:00Z", sourceUrl: "https://youtube.com/@provider-video", isApproximate: false },
    { id: "c", platform: "telegram", accountKey: "provider-updates", handle: "@provider-updates", accountUrl: "https://t.me/provider-updates", countValue: 3000, countState: "verified", checkedAt: "2026-11-07T00:00:00Z", sourceUrl: "https://t.me/provider-updates", isApproximate: false },
  ];
  const html = render("AudiencePills", { accounts });
  expect(html).toContain("@provider-video");
  expect(html).toContain("@provider-updates");
  expect(html).toContain("Unknown");
  expect(html).toContain("~10.5K");
  expect(html).toContain("Checked 7 Nov 2026");
  expect(html).not.toContain("13.5");
});

it("keeps a failed app search distinct from proof that no app exists, and marks founder overrides", () => {
  const html = render("ProductFitPanel", { model: { ...model, mobileAppStatus: "not_found_in_checked_sources", overriddenFields: ["product_fit"] } });
  expect(html).toContain("absence not proven");
  expect(html).toContain("Founder override");
  expect(html).not.toContain("Confirmed absent by official evidence");
});

it("escapes evidence and refuses executable link schemes", () => {
  const html = render("ProductFitPanel", { model: { ...model, findings: [{ summary: "<script>alert(1)</script>", sourceUrl: "javascript:alert(1)", observedAt: "2026-11-07T00:00:00Z" }] } });
  expect(html).not.toContain("<script>");
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain("&lt;script&gt;");
});

it("shows Unknown priority as provisional, not Low fit, and does not hide supporting URLs", () => {
  const value = { ...model, priorityScore: 60, assessedAt: "2026-11-07T00:00:00Z", findings: [{ summary: "Official delivery setup", sourceUrl: "https://example.test/signals", observedAt: "2026-11-07T00:00:00Z" }] };
  expect(render("PriorityLabel", { model: value })).toContain("provisional");
  const panel = render("ProductFitPanel", { model: value });
  expect(panel).toContain('href="https://example.test/signals"');
  expect(panel).toContain("Official delivery setup");
});
