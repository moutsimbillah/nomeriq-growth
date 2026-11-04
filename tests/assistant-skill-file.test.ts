import { describe, expect, it } from "vitest";

import { ASSISTANT_SKILL } from "@/lib/agent/instructions";
import {
  fullSkillFile,
  loaderSkillFile,
  SKILL_DESCRIPTION,
  SKILL_NAME,
  SKILL_VERSION,
} from "@/lib/agent/skillFile";

/**
 * Both downloads must be a valid Claude skill file: YAML frontmatter first, a well-formed name, and
 * a description within the loader's limits. The loader must stay free of research rules so it can
 * never go stale; the full copy is the dated snapshot.
 */

function parseSkill(file: string) {
  const end = file.indexOf("\n---", 4);
  expect(end).toBeGreaterThan(0);
  const block = file.slice(4, end).trim();
  const fields: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const colon = line.indexOf(":");
    expect(colon).toBeGreaterThan(0);
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { fields, body: file.slice(end + 4).trimStart() };
}

const downloads = [
  ["loader", loaderSkillFile()],
  ["full", fullSkillFile(new Date("2026-11-04T10:00:00Z"))],
] as const;

describe.each(downloads)("the %s download", (_name, file) => {
  it("starts with frontmatter and nothing before it", () => {
    expect(file.startsWith("---\n")).toBe(true);
    expect(parseSkill(file).body.length).toBeGreaterThan(200);
  });

  it("parses, with a name Claude accepts", () => {
    const { fields } = parseSkill(file);
    expect(fields.name).toBe(SKILL_NAME);
    expect(fields.name).toMatch(/^[a-z0-9-]+$/);
    expect(fields.name.length).toBeLessThanOrEqual(64);
  });

  it("has a description within the limits and no angle brackets", () => {
    const { fields } = parseSkill(file);
    expect(fields.description).toBe(SKILL_DESCRIPTION);
    expect(fields.description.length).toBeGreaterThan(20);
    expect(fields.description.length).toBeLessThan(1024);
    expect(fields.description).not.toMatch(/[<>]/);
  });
});

describe("the loader", () => {
  const { body } = parseSkill(loaderSkillFile());

  it("points at the connector, get_instructions and Product Truth", () => {
    expect(body).toContain("leads-nomeriq");
    expect(body).toContain("get_instructions");
    expect(body).toContain("read_product_truth");
    expect(body.toLowerCase()).toContain("product truth");
  });

  it("tells the assistant to stop when the connector is missing", () => {
    expect(body.toLowerCase()).toContain("connector is not available");
    expect(body.toLowerCase()).toContain("stop");
  });

  it("contains no research rules", () => {
    const ruleShaped = [
      "save_prospect",
      "save_draft",
      "check_duplicate",
      "search_prospects",
      "record_search_query",
      "list_research_jobs",
      "forex",
      "crypto",
      "metals",
      "publicly published",
      "email source",
      "duplicate check",
      "qualified provider",
    ];
    for (const token of ruleShaped) {
      expect(body.toLowerCase()).not.toContain(token.toLowerCase());
    }
  });
});

describe("the full copy", () => {
  it("carries the version and a date so staleness is visible", () => {
    const file = fullSkillFile(new Date("2026-11-04T10:00:00Z"));
    const { body } = parseSkill(file);
    expect(body).toContain(SKILL_VERSION);
    expect(body).toContain("2026-11-04");
  });

  it("contains the complete current skill text", () => {
    const { body } = parseSkill(fullSkillFile());
    expect(body).toContain(ASSISTANT_SKILL.trimStart().slice(0, 60));
    expect(body.length).toBeGreaterThan(ASSISTANT_SKILL.length);
  });
});

describe("the tool surfaces stay plain", () => {
  it("serves get_instructions and the MCP resource without frontmatter", () => {
    expect(ASSISTANT_SKILL.startsWith("---")).toBe(false);
    expect(ASSISTANT_SKILL).not.toContain("name: nomeriq-growth-portal");
  });
});