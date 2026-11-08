import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ESTABLISHED_AUDIENCE,
  FIT_POINTS,
  LEAD_RULES_PATH,
  LEAD_RULES_TEXT,
  LEAD_RULES_VERSION,
  TIER_POINTS,
} from "@/lib/leads/model";

/**
 * The founder's rules live in one document. Everything else — the agent
 * instructions, the portal's AI context, the stored assessment version — must
 * follow it. These tests are the tripwire: if someone edits the document and
 * forgets to regenerate, or edits the generated copy by hand, the suite fails
 * instead of the app quietly serving two different sets of rules.
 */
describe("lead rules parity", () => {
  it("serves the rules document exactly, so a stale copy cannot ship", async () => {
    const onDisk = await fs.readFile(path.resolve(process.cwd(), LEAD_RULES_PATH), "utf8");
    // Line endings are the checkout's business, not the rules': git writes CRLF
    // on Windows and LF elsewhere, so both sides are normalised before the
    // comparison. A real edit to the rules still differs and still fails here.
    const normalise = (value: string) => value.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    expect(LEAD_RULES_TEXT).toBe(normalise(onDisk));
  });

  it("weights product fit as the approved rubric does", () => {
    // The plan is explicit: an unchecked lead (30) must never rank below one
    // with a mature platform (10). This asserts the direction, not just numbers.
    expect(FIT_POINTS.high).toBe(70);
    expect(FIT_POINTS.medium).toBe(45);
    expect(FIT_POINTS.unknown).toBe(30);
    expect(FIT_POINTS.low).toBe(10);
    expect(FIT_POINTS.unknown).toBeGreaterThan(FIT_POINTS.low);
  });

  it("keeps the approved established-audience threshold and tier weights", () => {
    expect(ESTABLISHED_AUDIENCE).toBe(1000);
    expect(TIER_POINTS.tier_1).toBe(10);
    expect(TIER_POINTS.category_b).toBe(0);
    expect(TIER_POINTS.excluded).toBe(0);
  });

  it("dates the rules so a stored assessment says which rules judged it", () => {
    expect(LEAD_RULES_VERSION).toMatch(/^lead-rules-\d{4}-\d{2}-\d{2}$/);
  });

  it("carries the founder's amendments in the same text the agents receive", () => {
    // These four decisions changed the original rules; if the canonical text
    // ever loses them, every agent silently reverts to the superseded version.
    expect(LEAD_RULES_TEXT).toContain("Founder-approved amendments — 7 Nov 2026");
    expect(LEAD_RULES_TEXT).toContain("1,000 on one official Instagram or YouTube account");
    expect(LEAD_RULES_TEXT).toContain("High 70, Medium 45, Unknown 30");
    expect(LEAD_RULES_TEXT).toContain("Growth-Chat-Search");
    // The tier model the engine relies on must be described, including the
    // Category B record that is never emailed and never counted.
    expect(LEAD_RULES_TEXT).toContain("Category B — Alternative contact");
    expect(LEAD_RULES_TEXT).toContain("Email, no website");
  });
});
