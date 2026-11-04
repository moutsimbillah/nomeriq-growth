import { describe, expect, it } from "vitest";

import { AGENT_TAGS } from "@/lib/agent/agentTag";
import { AGENT_PILL_BASE, AGENT_PILL_CLASS, agentPillLabel } from "@/lib/agent/agentPill";

/**
 * The pill is the one place a founder reads the agent at a glance, so the mapping is pinned: every
 * agent has its own colour, the palest case still carries text, and colour is never the only signal.
 */

describe("one colour per agent", () => {
  it("gives every agent a distinct class set", () => {
    const seen = new Map<string, string>();
    for (const tag of AGENT_TAGS) {
      const classes = AGENT_PILL_CLASS[tag];
      expect(classes, tag).toBeTruthy();
      expect(seen.has(classes), `${tag} duplicates ${seen.get(classes)}`).toBe(false);
      seen.set(classes, tag);
    }
    expect(seen.size).toBe(AGENT_TAGS.length);
  });

  it("uses the colours asked for", () => {
    expect(AGENT_PILL_CLASS.claude).toContain("#fff2e8"); // warm orange
    expect(AGENT_PILL_CLASS.chatgpt).toContain("#e9f7ee"); // green
    expect(AGENT_PILL_CLASS.gemini).toContain("#e9f1fd"); // blue
    expect(AGENT_PILL_CLASS.deepseek).toContain("#edecfc"); // indigo
    expect(AGENT_PILL_CLASS.hermes).toContain("#f7ecfc"); // purple
    expect(AGENT_PILL_CLASS.founder).toContain("bg-[#1f2422]"); // dark ink
    expect(AGENT_PILL_CLASS.other).toContain("border-dashed"); // grey, dashed
    expect(AGENT_PILL_CLASS.unknown).toContain("#fafaf7"); // light grey
  });

  it("outlines an unconfirmed connector instead of merely recolouring it", () => {
    expect(AGENT_PILL_CLASS.other).toContain("border-dashed");
    expect(AGENT_PILL_CLASS.other).toContain("#9b9b94");
    // every other agent has a solid border, so the dashed one reads as "not confirmed"
    for (const tag of AGENT_TAGS.filter((t) => t !== "other")) {
      expect(AGENT_PILL_CLASS[tag], tag).not.toContain("dashed");
    }
  });

  it("is larger and bolder than the domain text beside it", () => {
    const size = Number(AGENT_PILL_BASE.match(/text-\[([\d.]+)px\]/)?.[1]);
    expect(size).toBeGreaterThan(11); // the domain line is 11px
    expect(AGENT_PILL_BASE).toContain("font-bold");
    expect(AGENT_PILL_BASE).toContain("shrink-0");
  });

  it("never relies on colour alone: the name is text, in every case", () => {
    for (const tag of AGENT_TAGS) {
      const label = agentPillLabel(tag, null);
      expect(label.length, tag).toBeGreaterThan(2);
      expect(label, tag).not.toBe("");
    }
  });
});

describe("the label", () => {
  it("names the connector when the agent is not a known one", () => {
    expect(agentPillLabel("other", "Claude Pro")).toBe("Other · Claude Pro");
    expect(agentPillLabel("other", "  Claude Pro  ")).toBe("Other · Claude Pro");
  });

  it("stays short when the agent is known, so the pill cannot bloat the row", () => {
    expect(agentPillLabel("claude", "Claude")).toBe("Claude");
    expect(agentPillLabel("deepseek", null)).toBe("DeepSeek engine");
    expect(agentPillLabel("founder", "anything")).toBe("Founder");
  });

  it("falls back to Unknown for a row with nothing recorded", () => {
    expect(agentPillLabel(null, null)).toBe("Unknown");
    expect(agentPillLabel("other", null)).toBe("Other");
    expect(agentPillLabel("other", "   ")).toBe("Other");
  });
});