import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

it("pipeline is linked, names wrap to two lines with full hover, qualification filters stay reserved", () => {
  const page = readFileSync("src/app/(app)/pipeline/page.tsx", "utf8");
  expect(page).toContain('title={card.businessName} data-card-name');
  expect(page).toContain("line-clamp-2 break-anywhere");
  expect(page).not.toContain("verified leads, each in one column");
  const analytics = readFileSync("src/app/(app)/pipeline/analytics/page.tsx", "utf8");
  for (const source of [page, analytics]) {
    expect(source).toContain('name: "tier", label: "Tier", disabled: true');
    expect(source).toContain('name: "productFit", label: "Product fit", disabled: true');
    expect(source).toContain('m === "crypto" ? "Crypto"');
  }
  expect(analytics).toContain('label="Signal market"');
  expect(analytics).toContain("Countries (optional)");
  expect(readFileSync("src/components/app-chrome.tsx", "utf8")).toContain('href: "/pipeline", label: "Pipeline"');
});

it("only the four founder columns are offered as card moves; automatic columns are not manual decisions", () => {
  const source = readFileSync("src/components/pipeline-client.tsx", "utf8");
  const moves = source.slice(source.indexOf("const MOVES"), source.indexOf("async function moveLead"));
  for (const stage of ["demo", "proposal", "won", "lost"]) expect(moves).toContain(`stage: "${stage}"`);
  expect(moves).not.toContain('stage: "interested"');
  expect(source).not.toMatch(/sendDraft|approveDraft|startCampaign/);
});
