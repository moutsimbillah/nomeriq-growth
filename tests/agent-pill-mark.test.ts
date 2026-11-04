import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

import { AGENT_TAGS } from "@/lib/agent/agentTag";
import { agentInitial, agentPillLabel } from "@/lib/agent/agentPill";

/**
 * The mark on an agent pill is the agent's own initial, not a plain dot. That is deliberate: the stage
 * pill uses a plain dot on a soft pastel, so an initial is the non-colour signal that keeps an agent
 * pill from ever being read as a status.
 */

describe("the agent mark", () => {
  it("is the agent's initial", () => {
    expect(agentInitial("claude")).toBe("C");
    expect(agentInitial("chatgpt")).toBe("C");
    expect(agentInitial("gemini")).toBe("G");
    expect(agentInitial("deepseek")).toBe("D");
    expect(agentInitial("hermes")).toBe("H");
    expect(agentInitial("founder")).toBe("F");
    expect(agentInitial("other")).toBe("O");
    expect(agentInitial("unknown")).toBe("U");
    expect(agentInitial(null)).toBe("U");
  });

  it("renders a letter for every agent, so the mark is never empty", () => {
    for (const tag of AGENT_TAGS) {
      expect(agentInitial(tag), tag).toMatch(/^[A-Z]$/);
    }
  });

  it("is drawn as a disc, at the minimum type size, in white on the agent's full colour", () => {
    const ui = readFileSync("src/components/ui.tsx", "utf8");
    const block = ui.slice(ui.indexOf("agentInitial(tag)") - 700, ui.indexOf("agentInitial(tag)") + 40);
    expect(block).toContain("rounded-full");
    expect(block).toContain("text-12");           // never below the 12px floor, even in a badge
    expect(block).toContain("text-white");
    expect(block).toContain("AGENT_PILL_A_MARK"); // the full-strength agent colour
    // and the stage pill keeps its plain dot, which is what makes them distinguishable
    const status = ui.slice(ui.indexOf("export function StatusBadge"), ui.indexOf("export function CategoryPill"));
    expect(status).toContain("badge-dot");
    expect(status).not.toContain("agentInitial");
  });

  it("keeps the words beside the mark", () => {
    expect(agentPillLabel("other", "Claude Pro")).toBe("Other · Claude Pro");
    expect(agentPillLabel("claude", null)).toBe("Claude");
  });
});