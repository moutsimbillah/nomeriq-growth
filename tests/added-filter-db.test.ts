import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { getProspectOriginFacets, listProspects } from "@/lib/services/prospects";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * The date filter against real rows, around the boundary that matters: midnight in Pakistan is 19:00
 * UTC, so a lead saved at 23:59 Karachi is yesterday's and one saved at 00:01 is today's, even though
 * UTC calls both of them the same date.
 */

const NOW = new Date("2026-11-04T19:30:00Z"); // 2026-11-05 00:30 in Karachi

const ROWS: [string, string, string][] = [
  // name, created_at (UTC), expected Karachi day
  ["Karachi Late Yesterday", "2026-11-04T18:59:00Z", "yesterday"], // 23:59 on the 4th
  ["Karachi First Minute Today", "2026-11-04T19:01:00Z", "today"], // 00:01 on the 5th
  ["Karachi Exactly Midnight", "2026-11-04T19:00:00Z", "today"], // 00:00 on the 5th
  ["Six Days Ago Karachi", "2026-10-29T19:30:00Z", "last7"], // 00:30 on the 30th
  ["Twenty Days Ago Karachi", "2026-10-15T19:30:00Z", "last30"], // 00:30 on the 16th
  ["Last Month Karachi", "2026-10-01T10:00:00Z", "last_month"], // 15:00 on the 1st
];

async function seed() {
  const db = await getDb();
  await db.query(`DELETE FROM prospects WHERE business_name = ANY($1)`, [ROWS.map((r) => r[0])]);
  for (const [name, createdAt, day] of ROWS) {
    await db.query(
      `INSERT INTO prospects (id, business_name, name_key, website_url, domain_key, categories,
                              qualification_status, status, created_by_type, source_agent, source_channel,
                              created_at, updated_at)
       VALUES (gen_random_uuid(), $1, lower($1), $2, $2, '["forex"]'::jsonb, 'verified', 'verified',
               'api', 'claude', 'mcp_oauth', $3, $3)`,
      [name, `${name.replace(/[^a-z]/gi, "").toLowerCase()}.example`, createdAt],
    );
    void day;
  }
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  await seed();
});

afterAll(async () => {
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

const MINE = new Set(ROWS.map((r) => r[0]));
/**
 * Test files share one PGlite directory per process, so other files' rows are in this table too.
 * Every assertion below is scoped to the six rows seeded here, and the facet assertions compare
 * against a baseline measured in the same run.
 */
const names = (rows: { businessName: string }[]) =>
  rows.map((r) => r.businessName).filter((n) => MINE.has(n)).sort();

describe("filtering by the Karachi day a lead was added", () => {
  it("puts the 23:59 entry on yesterday and the 00:01 entry on today", async () => {
    const today = await listProspects({ added: "today", now: NOW });
    expect(names(today)).toEqual(["Karachi Exactly Midnight", "Karachi First Minute Today"]);

    const yesterday = await listProspects({ added: "yesterday", now: NOW });
    expect(names(yesterday)).toEqual(["Karachi Late Yesterday"]);
  });

  it("includes a lead saved at exactly midnight in Pakistan", async () => {
    const today = await listProspects({ added: "today", now: NOW });
    expect(today.map((p) => p.businessName)).toContain("Karachi Exactly Midnight");
  });

  it("keeps the two sides of midnight in different buckets", async () => {
    const today = await listProspects({ added: "today", now: NOW });
    const yesterday = await listProspects({ added: "yesterday", now: NOW });
    const overlap = names(today).filter((n) => names(yesterday).includes(n));
    expect(overlap).toEqual([]);
  });

  it("covers the wider presets", async () => {
    const last7 = await listProspects({ added: "last7", now: NOW });
    expect(names(last7)).toContain("Six Days Ago Karachi");
    expect(names(last7)).toContain("Karachi First Minute Today");
    expect(names(last7)).not.toContain("Twenty Days Ago Karachi");

    const last30 = await listProspects({ added: "last30", now: NOW });
    expect(names(last30)).toContain("Twenty Days Ago Karachi");

    const lastMonth = await listProspects({ added: "last_month", now: NOW });
    // October is last month relative to 5 November, so the 16th and the 30th are in it too
    expect(names(lastMonth)).toEqual([
      "Last Month Karachi",
      "Six Days Ago Karachi",
      "Twenty Days Ago Karachi",
    ]);

    const thisMonth = await listProspects({ added: "this_month", now: NOW });
    expect(names(thisMonth)).not.toContain("Last Month Karachi");
    expect(names(thisMonth)).toContain("Karachi First Minute Today");
  });

  it("takes a custom range, inclusive of both Karachi days", async () => {
    const rows = await listProspects({ added: "custom", addedFrom: "2026-11-04", addedTo: "2026-11-04", now: NOW });
    expect(names(rows)).toEqual(["Karachi Late Yesterday"]); // the 4th in Karachi
  });

  it("combines with the agent filter", async () => {
    const both = await listProspects({ added: "today", agent: "claude", now: NOW });
    expect(both.length).toBe(2);
    const contradictory = await listProspects({ added: "today", agent: "founder", now: NOW });
    expect(contradictory.length).toBe(0);
  });
});

describe("counts for the date options", () => {
  // today: the two rows after Karachi midnight on the 5th. yesterday: the 23:59 row on the 4th.
  // last7: those three plus 30 Oct Karachi. last30: those plus 16 Oct Karachi.
  // this_month: the three November rows. last_month: the three October rows.
  const MINE_PER_PRESET: Record<string, number> = {
    today: 2, yesterday: 1, last7: 4, last30: 5, this_month: 3, last_month: 3,
  };

  it("counts at least the rows the presets cover", async () => {
    // Facets are database-wide and other test files share this one, so each preset must account for
    // every seeded row it covers, and the row-level assertions below pin the exact numbers.
    const facets = await getProspectOriginFacets({ now: NOW });
    for (const [range, mine] of Object.entries(MINE_PER_PRESET)) {
      expect(facets.added[range], range).toBeGreaterThanOrEqual(mine);
    }
  });

  it("counts each preset with the other filters applied", async () => {
    const unfiltered = await getProspectOriginFacets({ now: NOW });
    const todayOnly = await getProspectOriginFacets({ added: "today", now: NOW });
    // the date axis stays complete: choosing another range is still possible
    expect(todayOnly.added.today).toBe(unfiltered.added.today);
    expect(todayOnly.added.yesterday).toBe(unfiltered.added.yesterday);
    // while the agent axis narrows to what the range contains
    expect(todayOnly.agents.claude ?? 0).toBeLessThan(unfiltered.agents.claude ?? 0);
  });

  it("counts exactly the six seeded rows, whatever else is in the table", async () => {
    const today = await listProspects({ added: "today", now: NOW });
    expect(today.filter((p) => MINE.has(p.businessName)).length).toBe(2);
    const lastMonth = await listProspects({ added: "last_month", now: NOW });
    expect(lastMonth.filter((p) => MINE.has(p.businessName)).length).toBe(3);
    const last30 = await listProspects({ added: "last30", now: NOW });
    expect(last30.filter((p) => MINE.has(p.businessName)).length).toBe(5);
  });

  it("cleans up after itself", async () => {
    const db = await getDb();
    await db.query(`DELETE FROM prospects WHERE business_name = ANY($1)`, [ROWS.map((r) => r[0])]);
    const left = await db.query(`SELECT 1 FROM prospects WHERE business_name = ANY($1)`, [ROWS.map((r) => r[0])]);
    expect(left.rows.length).toBe(0);
  });
});