import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import {
  seedFilterVerificationFixture as seed,
  cleanupFilterVerificationFixture as cleanup,
} from "./helpers/filter-verification-fixture";
import {
  verifyLeadFilterState,
  leadVerificationTotals,
} from "./helpers/verify-lead-filter-state";
import { PIPELINE, CATEGORIES } from "@/lib/types";
import { AGENT_TAGS, CHANNEL_TAGS } from "@/lib/agent/agentTag";
import { ADDED_RANGES } from "@/lib/dates/pakistan";
import { getDb } from "@/lib/db/client";
import { oracleIds } from "./helpers/filter-sql-oracle";
import { listProspectsPage, getProspectOriginFacets } from "@/lib/services/prospects";
import { listDraftsPage, getDraftOriginFacets } from "@/lib/services/drafts";

const BASE = {
  now: new Date("2026-11-05T20:00:00.000Z"),
  timezone: "Asia/Karachi",
  addedFrom: "2026-10-01",
  addedTo: "2026-11-05",
};

const QUALIFICATIONS = ["candidate", "verified", "rejected"] as const;

/**
 * Six existing matrix rows moved onto the midnight edges of a stored workspace zone: local
 * midnight +/-1ms in Asia/Karachi and the 04:59:59.999Z/05:00Z boundary in America/New_York.
 */
const WORKSPACE_EDGES: { nameKey: string; createdAt: string }[] = [
  { nameKey: "matrix-fixture-444", createdAt: "2026-11-05T18:59:59.999Z" },
  { nameKey: "matrix-fixture-445", createdAt: "2026-11-05T19:00:00.000Z" },
  { nameKey: "matrix-fixture-446", createdAt: "2026-11-06T04:59:59.999Z" },
  { nameKey: "matrix-fixture-447", createdAt: "2026-11-06T05:00:00.000Z" },
  { nameKey: "matrix-fixture-448", createdAt: "2026-11-06T19:00:00.000Z" },
  { nameKey: "matrix-fixture-449", createdAt: "2026-11-06T05:00:00.000Z" },
];

const jobs: string[] = [];
const senders: string[] = [];

type Axis = { name: string; values: () => unknown[] };

const AXES: Axis[] = [
  { name: "query", values: () => ["FilterFixture", "Matchland", "fixture-1.example.test", "matrix-1@fixture-1.example.test", "NoMatch"] },
  { name: "status", values: () => [...PIPELINE] },
  { name: "category", values: () => CATEGORIES.map((c) => c.value) },
  { name: "qualification", values: () => [...QUALIFICATIONS] },
  { name: "jobId", values: () => [...jobs] },
  { name: "agent", values: () => [...AGENT_TAGS] },
  { name: "channel", values: () => [...CHANNEL_TAGS, "unknown"] },
  { name: "sender", values: () => ["default", ...senders] },
  { name: "added", values: () => [...ADDED_RANGES] },
  { name: "hasEmail", values: () => [true, false] },
];

beforeAll(async () => {
  const fixture = await seed("filter-verification-leads");
  jobs.push(...fixture.jobs);
  senders.push(...fixture.senders);

  const db = await getDb();
  for (const edge of WORKSPACE_EDGES) {
    await db.query(
      `UPDATE prospects SET created_at = $1 WHERE name_key = $2`,
      [edge.createdAt, edge.nameKey],
    );
  }
  await db.query(
    `UPDATE drafts d SET created_at = p.created_at
       FROM prospects p
      WHERE d.prospect_id = p.id AND p.name_key LIKE 'matrix-fixture-%'`,
  );
});

afterAll(async () => {
  await mkdir("scratch", { recursive: true });
  await writeFile(
    "scratch/filter-verification-leads.json",
    JSON.stringify({ ...leadVerificationTotals, fixtureRows: 450, axes: 10, pairs: 45 }, null, 2),
  );
  await cleanup();
});

describe("lead filter verification", () => {
  it("baseline", async () => {
    await verifyLeadFilterState({ ...BASE }, senders);
    expect(leadVerificationTotals.states).toBeGreaterThan(0);
  });

  for (const axis of AXES) {
    it(`singles: ${axis.name}`, async () => {
      for (const value of axis.values()) {
        await verifyLeadFilterState({ ...BASE, [axis.name]: value }, senders);
      }
    });
  }

  for (let i = 0; i < AXES.length; i += 1) {
    for (let j = i + 1; j < AXES.length; j += 1) {
      const a = AXES[i];
      const b = AXES[j];
      it(`pairs: ${a.name} x ${b.name}`, async () => {
        for (const av of a.values()) {
          for (const bv of b.values()) {
            await verifyLeadFilterState({ ...BASE, [a.name]: av, [b.name]: bv }, senders);
          }
        }
      }, 120_000);
    }
  }
});

it("workspace boundary follows stored setting", async () => {
  const db = await getDb();
  const filters = { added: "today" as const, now: BASE.now };
  const sorted = (ids: unknown[]) => ids.map((id) => String(id)).sort();
  try {
    for (const zone of ["Asia/Karachi", "America/New_York"]) {
      await db.query(`UPDATE workspace_settings SET timezone = $1 WHERE id = 'default'`, [zone]);

      const expectedLeads = await oracleIds("leads", { ...filters, timezone: zone });
      const leads = await listProspectsPage({ ...filters, limit: 1000 });
      expect(sorted(leads.rows.map((row) => row.id))).toEqual(sorted(expectedLeads));
      expect(leads.total).toBe(expectedLeads.length);
      expect((await getProspectOriginFacets(filters)).added.today).toBe(
        (await oracleIds("leads", { ...filters, added: "today", timezone: zone })).length,
      );

      const expectedDrafts = await oracleIds("drafts", { ...filters, timezone: zone });
      const drafts = await listDraftsPage(undefined, 1000, undefined, filters);
      expect(sorted(drafts.rows.map((row) => row.id))).toEqual(sorted(expectedDrafts));
      expect(drafts.total).toBe(expectedDrafts.length);
      expect((await getDraftOriginFacets(undefined, filters)).added.today).toBe(
        (await oracleIds("drafts", { ...filters, added: "today", timezone: zone })).length,
      );
    }
  } finally {
    await db.query(`UPDATE workspace_settings SET timezone = $1 WHERE id = 'default'`, [
      "Asia/Karachi",
    ]);
  }
});
