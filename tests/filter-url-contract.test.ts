import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import {
  countActiveFilters,
  leadFilterQuery,
  readLeadFilters,
  type LeadFilters,
} from "@/lib/leads/leadFilters";

/** The URL is the only store for a filtered view, so every state must survive serialize → parse. */

const JOB = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

const parse = (filters: LeadFilters) =>
  readLeadFilters(Object.fromEntries(new URLSearchParams(leadFilterQuery(filters).slice(1))));

const defined = (filters: LeadFilters) =>
  JSON.parse(JSON.stringify(filters)) as LeadFilters;

const AXES: Record<string, unknown[]> = {
  query: ["acme", "two words"],
  status: ["new", "contacted"],
  category: ["forex", "crypto"],
  qualification: ["verified", "rejected"],
  jobId: [JOB],
  agent: ["claude", "founder"],
  channel: ["mcp_oauth", "legacy_import"],
  sender: ["default", JOB],
  added: ["today"],
  hasEmail: [false],
};
const KEYS = Object.keys(AXES);

it("drops a value it does not know for a closed filter", () => {
  const { status, category, qualification, jobId } = readLeadFilters({
    status: "not-a-status",
    category: "not-a-category",
    qualification: "not-a-qualification",
    job: "not-a-job",
  });
  expect([status, category, qualification, jobId]).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

it("keeps a well-formed job id even when the job is not loaded", () => {
  expect(readLeadFilters({ job: JOB }).jobId).toBe(JOB);
});

it("round-trips an unknown channel and counts it once", () => {
  const filters = { channel: "unknown" } as LeadFilters;
  const round = defined(parse(filters));
  expect(round).toEqual(filters);
  expect(countActiveFilters(round)).toBe(1);
});

it("drops a custom range whose end precedes its start", () => {
  expect(readLeadFilters({ added: "custom", from: "2026-11-03", to: "2026-11-01" }).added).toBeUndefined();
});

it("drops an invalid date", () => {
  expect(readLeadFilters({ added: "custom", from: "2026-02-30", to: "2026-11-01" }).added).toBeUndefined();
  expect(readLeadFilters({ from: "nonsense" }).addedFrom).toBeUndefined();
});

it("round-trips a custom range that has both ends in order", () => {
  const filters = { added: "custom", addedFrom: "2026-11-01", addedTo: "2026-11-03" } as LeadFilters;
  expect(defined(parse(filters))).toEqual(filters);
});

it("survives the URL as a single state, retaining false and the active count", () => {
  for (const key of KEYS) {
    for (const value of AXES[key]) {
      const filters = { [key]: value } as LeadFilters;
      const round = defined(parse(filters));
      expect(round, `${key}=${value}`).toEqual(filters);
      expect(countActiveFilters(round), `${key}=${value}`).toBe(1);
    }
  }
});

it("survives the URL as a pair of states", () => {
  for (let i = 0; i < KEYS.length; i += 1) {
    for (let j = i + 1; j < KEYS.length; j += 1) {
      for (const a of AXES[KEYS[i]]) {
        for (const b of AXES[KEYS[j]]) {
          const filters = { [KEYS[i]]: a, [KEYS[j]]: b } as LeadFilters;
          const round = defined(parse(filters));
          expect(round, `${KEYS[i]},${KEYS[j]}`).toEqual(filters);
          expect(countActiveFilters(round), `${KEYS[i]},${KEYS[j]}`).toBe(2);
        }
      }
    }
  }
});

it("offers the Custom range option whether or not it is already selected", () => {
  for (const path of ["src/app/(app)/leads/page.tsx", "src/app/(app)/email/page.tsx"]) {
    const source = readFileSync(path, "utf8");
    const from = source.indexOf('value="custom"');
    expect(from, path).toBeGreaterThan(-1);
    const tag = source.slice(from, source.indexOf(">", from));
    expect(tag, path).not.toContain("disabled");
  }
});
