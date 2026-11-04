import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { AGENT_COLOURS, contrastRatio, PANEL } from "@/lib/agent/agentPill";
import {
  allAgentColours,
  allSenderColours,
  defaultSenderLabel,
  domainOf,
  SENDER_DOT_CLASS,
  SENDER_DEFAULT_DOT,
  SENDER_DOT_COLOURS,
  SENDER_PILL_BASE,
  SENDER_PILL_FILL,
  SENDER_PILL_INK,
  senderDotClass,
  senderDotColour,
  senderLabels,
  senderPillLabel,
  senderShortName,
} from "@/lib/email/senderPill";

/**
 * The sender pill is the third pill family. Two rules matter: it must be readable, and it must never be
 * confused with an agent pill — a prospect's mailbox is not a claim about who wrote the email.
 */

describe("sender pill", () => {
  it("keeps its text readable on its own fill", () => {
    expect(contrastRatio(SENDER_PILL_INK, SENDER_PILL_FILL)).toBeGreaterThanOrEqual(4.5);
    // and on the panel it sits on, for the outline's sake
    expect(contrastRatio(SENDER_PILL_INK, PANEL)).toBeGreaterThanOrEqual(4.5);
  });

  it("never wears an agent's colour", () => {
    const agents = new Set(allAgentColours());
    for (const colour of allSenderColours()) {
      expect(agents.has(colour), `${colour} is also an agent colour`).toBe(false);
    }
    // and the two palettes agree on nothing, even after the agent fills are baked
    for (const agent of Object.values(AGENT_COLOURS)) {
      expect(SENDER_DOT_COLOURS).not.toContain(agent.accent);
      expect(SENDER_DEFAULT_DOT).not.toBe(agent.accent);
    }
  });

  it("gives every dot at least 3:1 against the panel it sits on", () => {
    // the dot is decoration next to spelled-out text, so it is held to the non-text threshold
    for (const colour of [...SENDER_DOT_COLOURS, SENDER_DEFAULT_DOT]) {
      expect(contrastRatio(colour, PANEL), colour).toBeGreaterThanOrEqual(3);
    }
  });

  it("always carries a spelled-out label, never colour alone", () => {
    expect(senderPillLabel({ id: "abc", label: "nomeriq.com" })).toBe("nomeriq.com");
    // a lead with no profile yet still names the mailbox that would send, composed by the caller
    expect(senderPillLabel({ id: null, label: "nomeriq.info · default" })).toBe("nomeriq.info · default");
    expect(senderPillLabel(null)).toBe("default");
    // a profile with no usable name still renders text rather than an empty pill
    expect(senderPillLabel({ id: "abc", label: "  " })).toBe("unknown");
  });

  it("names a profile by its domain, and falls back to its name only with no address", () => {
    // the domain is what the prospect sees, so it wins over an internal account name
    expect(senderShortName({ name: "Old portal", emailAddress: "moutsim@nomeriq.com" })).toBe("nomeriq.com");
    expect(senderShortName({ emailAddress: "a@nomeriq.info" })).toBe("nomeriq.info");
    expect(senderShortName({ name: "Sandbox test mailbox" })).toBe("Sandbox test mailbox");
    expect(senderShortName({})).toBe("unknown");
    expect(domainOf("moutsim@nomeriq.com")).toBe("nomeriq.com");
    expect(domainOf("no-at-sign")).toBe("no-at-sign");
    expect(domainOf("")).toBe("unknown");
  });

  it("shows the local part only when two profiles share a domain", () => {
    const labels = senderLabels([
      { id: "a", emailAddress: "moutsim@nomeriq.com" },
      { id: "b", emailAddress: "outreach@nomeriq.info" },
      { id: "c", emailAddress: "team@nomeriq.info" },
    ]);
    // the domain alone is unambiguous
    expect(labels.get("a")).toBe("nomeriq.com");
    // two mailboxes on one domain would read the same, so both are shown in full
    expect(labels.get("b")).toBe("outreach@nomeriq.info");
    expect(labels.get("c")).toBe("team@nomeriq.info");
  });

  it("names the default profile rather than saying 'default'", () => {
    expect(defaultSenderLabel({ emailAddress: "outreach@nomeriq.info" })).toBe("nomeriq.info · default");
    // no mailbox at all: there is nothing honest to name
    expect(defaultSenderLabel(null)).toBe("default");
    expect(defaultSenderLabel({ emailAddress: "" })).toBe("default");
  });

  it("keeps a profile's colour stable, and stays inside the palette", () => {
    expect(senderDotColour("f8602ca5-bf39-402b-84cd-21212da236fd")).toBe(
      senderDotColour("f8602ca5-bf39-402b-84cd-21212da236fd"),
    );
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "moutsim", "nomeriq.info"];
    for (const id of ids) expect(SENDER_DOT_COLOURS).toContain(senderDotColour(id) as never);
    // a lead with no profile gets the neutral dot, not a palette colour
    expect(senderDotColour(null)).toBe(SENDER_DEFAULT_DOT);
  });

  it("never builds a class name at runtime", () => {
    // Tailwind scans source text: a class assembled from a variable is never emitted, so the pill would
    // render with no colour at all. Every class must be a literal in the file.
    const source = readFileSync("src/lib/email/senderPill.ts", "utf8");
    const dynamic = source.match(/(bg|border|text)-\[\$\{/g) ?? [];
    expect(dynamic).toEqual([]);
    for (const colour of [...SENDER_DOT_COLOURS, SENDER_DEFAULT_DOT]) {
      expect(SENDER_DOT_CLASS[colour], colour).toBeTruthy();
    }
    // every id resolves to a real, literal class, including one with no profile at all
    expect(senderDotClass(null)).toMatch(/^bg-\[#/);
    expect(senderDotClass("f8602ca5-bf39-402b-84cd-21212da236fd")).toMatch(/^bg-\[#/);
  });

  it("is built to coexist with the agent pill's shape without being it", () => {
    // same truncation discipline as the agent pill, so a long mailbox name cannot widen a row
    expect(SENDER_PILL_BASE).toContain("max-w-full");
    expect(SENDER_PILL_BASE).toContain("text-ellipsis");
    expect(SENDER_PILL_BASE).toContain("whitespace-nowrap");
    expect(SENDER_PILL_BASE).toContain("font-sans");
    expect(SENDER_PILL_BASE).not.toContain("serif");
  });
});
