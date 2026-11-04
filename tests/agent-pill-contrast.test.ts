import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { AGENT_TAGS } from "@/lib/agent/agentTag";
import {
  AGENT_COLOURS,
  AGENT_PILL_A,
  BORDER_ALPHA,
  FILL_ALPHA,
  borderOf,
  tintOf,
  AGENT_PILL_A_MARK,
  AGENT_PILL_B,
  AGENT_PILL_B_STRIPE,
  AGENT_PILL_BASE,
  AGENT_PILL_SIZE,
  agentPillLabel,
  contrastRatio,
} from "@/lib/agent/agentPill";

/**
 * Two candidate treatments, both of which must stay legible and stay recognisably NOT a stage pill or
 * a market pill. Contrast is asserted arithmetically, not judged from a screenshot.
 */

const MIN_CONTRAST = 4.5;

/** every colour token the app already uses, straight from the theme */
function themeColours(): Record<string, string> {
  const css = readFileSync("src/app/globals.css", "utf8");
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/--color-([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2].toLowerCase();
  return out;
}

describe("option A: a half-strength fill with dark text", () => {
  it("clears 4.5:1 for every agent, on the tinted fill", () => {
    for (const tag of AGENT_TAGS) {
      const { tint, onFill } = AGENT_COLOURS[tag];
      const ratio = contrastRatio(onFill, tint);
      expect(ratio, `${tag}: ${onFill} on ${tint} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });

  it("keeps half the colour, not all of it", () => {
    // the six matched agents are filled at half strength; the two unmatched ones are outlines
    for (const tag of AGENT_TAGS.filter((t) => t !== "other" && t !== "unknown")) {
      const { accent, tint } = AGENT_COLOURS[tag];
      expect(tint, `${tag}: the fill equals the accent`).not.toBe(accent);
      expect(tint, tag).toBe(tintOf(accent));
    }
    for (const tag of ["other", "unknown"] as const) {
      expect(AGENT_COLOURS[tag].tint, tag).toBe(AGENT_COLOURS[tag].fill);
    }
    expect(FILL_ALPHA).toBeGreaterThanOrEqual(0.5);
    expect(FILL_ALPHA).toBeLessThanOrEqual(0.6);
  });

  it("keeps the accent full strength on the dot and stronger on the border", () => {
    for (const tag of AGENT_TAGS.filter((t) => t !== "other" && t !== "unknown")) {
      const { accent } = AGENT_COLOURS[tag];
      expect(AGENT_PILL_A_MARK[tag], tag).toContain(accent);
      // baked hex, not an opacity utility: the class renders the exact colour this test measures
      expect(AGENT_PILL_A[tag], tag).toContain(`bg-[${tintOf(accent)}]`);
      expect(AGENT_PILL_A[tag], tag).toContain(`border-[${borderOf(accent)}]`);
      expect(AGENT_PILL_A[tag], tag).not.toMatch(/\/(50|70)\b/);
    }
    expect(BORDER_ALPHA).toBeGreaterThan(FILL_ALPHA);
  });

  it("leaves the two unmatched cases as outlines", () => {
    expect(AGENT_PILL_A.other).toContain("border-dashed");
    expect(AGENT_COLOURS.other.dashed).toBe(true);
    expect(AGENT_PILL_A.unknown).toContain("border-");
  });

  it("gives every agent a leading mark", () => {
    for (const tag of AGENT_TAGS) expect(AGENT_PILL_A_MARK[tag], tag).toBeTruthy();
  });
});

describe("option B: white card, dark text", () => {
  it("clears 4.5:1 against its white background for every agent", () => {
    for (const tag of AGENT_TAGS) {
      const { ink } = AGENT_COLOURS[tag];
      const ratio = contrastRatio(ink, "#ffffff");
      expect(ratio, `${tag}: ${ink} on white = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });

  it("carries a stripe and a dot in the agent's own colour on every pill", () => {
    for (const tag of AGENT_TAGS) {
      expect(AGENT_PILL_B[tag], tag).toContain("bg-white");
      expect(AGENT_PILL_B_STRIPE[tag], tag).toContain(`bg-[${AGENT_COLOURS[tag].accent}]`);
      expect(AGENT_PILL_B[tag], tag).toMatch(/border-\[#/);
    }
  });
});

describe("an agent pill can never read as a stage or market pill", () => {
  it("leaves market pills neutral, so no agent colour can collide with one", () => {
    const ui = readFileSync("src/components/ui.tsx", "utf8");
    const block = ui.slice(ui.indexOf("const CATEGORY_STYLES"), ui.indexOf("export function CategoryPill"));
    expect(block).toContain("border-line-strong");
    for (const hue of ["text-blue", "text-amber", "text-rust", "text-forest", "text-[#7a5aa6]", "text-[#8d6a42]"]) {
      expect(block, `market pills still use ${hue}`).not.toContain(hue);
    }
  });

  it("marks every stage pill with a dot", () => {
    const ui = readFileSync("src/components/ui.tsx", "utf8");
    const badge = ui.slice(ui.indexOf("export function StatusBadge"), ui.indexOf("export function CategoryPill"));
    expect(badge).toContain("badge-dot");
  });

  it("keeps white text OFF the tint, because it cannot clear 4.5:1 there", () => {
    // the arithmetic that forced the dark text: white on a half-strength tint is about 2.5:1
    for (const tag of AGENT_TAGS.filter((t) => t !== "other" && t !== "unknown")) {
      expect(contrastRatio("#ffffff", AGENT_COLOURS[tag].tint), tag).toBeLessThan(MIN_CONTRAST);
      expect(AGENT_PILL_A[tag]).not.toContain("text-white");
    }
  });

  it("uses no colour from the theme as an agent accent", () => {
    const theme = themeColours();
    for (const tag of AGENT_TAGS) {
      const accent = AGENT_COLOURS[tag].accent.toLowerCase();
      for (const [name, value] of Object.entries(theme)) {
        expect(accent, `${tag} reuses --color-${name}`).not.toBe(value);
      }
    }
  });

  it("keeps the eight agents distinct from each other", () => {
    const accents = AGENT_TAGS.map((t) => AGENT_COLOURS[t].accent.toLowerCase());
    expect(new Set(accents).size).toBe(AGENT_TAGS.length);
    const fills = AGENT_TAGS.map((t) => AGENT_COLOURS[t].fill.toLowerCase());
    expect(new Set(fills).size).toBeGreaterThanOrEqual(8);
  });

  it("is one step larger than a stage or market pill, and bold", () => {
    expect(AGENT_PILL_BASE).toContain("font-bold");
    expect(AGENT_PILL_SIZE.md).toContain("text-13"); // stage and market pills are text-12
    expect(AGENT_PILL_SIZE.lg).toContain("text-14");
    expect(AGENT_PILL_BASE).toContain("font-sans");
  });

  it("caps its width so a long connector name cannot widen a row", () => {
    expect(AGENT_PILL_BASE).toContain("max-w-full");
    expect(AGENT_PILL_BASE).toContain("whitespace-nowrap");
    expect(AGENT_PILL_BASE).toContain("text-ellipsis");
  });
});

describe("the label still says which agent", () => {
  it("names the connector only when the agent could not be matched", () => {
    expect(agentPillLabel("other", "Claude Pro")).toBe("Other · Claude Pro");
    expect(agentPillLabel("claude", "Claude")).toBe("Claude");
    expect(agentPillLabel(null, null)).toBe("Unknown");
  });
});