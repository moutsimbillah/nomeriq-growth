import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/lib/db/client";
import { countDrafts, getDraftOriginFacets, listDraftsPage } from "@/lib/services/drafts";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * The "unknown" agent filter on the Drafts list.
 *
 * A draft whose source_agent was never recorded is what the UI calls "unknown". Filtering on it has
 * to match that coalesced value in SQL, exactly like the facet count already groups it, so the filter
 * and the number next to it agree. Both fixture drafts were created on 2001-01-15, and the custom
 * range scopes every assertion to that day so other files' rows cannot leak in.
 */

const PROSPECT_UNKNOWN = "dddddddd-0000-4000-8000-000000000001";
const PROSPECT_TAGGED = "dddddddd-0000-4000-8000-000000000002";

const DRAFT_NULL_AGENT = "dddddddd-0000-4000-8000-000000000011";
const DRAFT_UNKNOWN_AGENT = "dddddddd-0000-4000-8000-000000000012";

const PROSPECT_IDS = [PROSPECT_UNKNOWN, PROSPECT_TAGGED];

/** 2001-01-15 10:00 UTC — 15:00 the same day in Asia/Karachi. */
const CREATED_AT = "2001-01-15T10:00:00Z";
/** Noon UTC on the 15th, so both drafts fall in the Karachi "today" window. */
const NOW = new Date("2001-01-15T12:00:00Z");
/** The Karachi day 2001-01-15 as a half-open UTC window (Asia/Karachi is a fixed +05:00). */
const DAY_FROM = "2001-01-14T19:00:00Z";
const DAY_TO = "2001-01-15T19:00:00Z";

const FILTERS = { added: "custom" as const, addedFrom: "2001-01-15", addedTo: "2001-01-15" };

async function seed() {
  const db = await getDb();
  // A prior interrupted run leaves the same fixed ids behind; cascading from the prospects clears
  // their drafts too.
  await db.query(`DELETE FROM prospects WHERE id = ANY($1::uuid[])`, [PROSPECT_IDS]);

  await db.query(
    `INSERT INTO prospects (id, business_name, name_key, created_by_type, created_at, updated_at)
     VALUES ($1, 'Unknown Draft Fixture Co', 'unknown draft fixture co', 'api', $3::timestamptz, $3::timestamptz),
            ($2, 'Tagged Draft Fixture Co', 'tagged draft fixture co', 'api', $3::timestamptz, $3::timestamptz)`,
    [PROSPECT_UNKNOWN, PROSPECT_TAGGED, CREATED_AT],
  );

  // One draft with no recorded source_agent, one explicitly tagged unknown.
  await db.query(
    `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
                         created_by_type, source_agent, created_at, updated_at)
     VALUES ($1, $2, 'first_contact', 0, 'draft', 'Fixture', 'Fixture', 'fixture@example.test',
             'api', NULL, $5::timestamptz, $5::timestamptz),
            ($3, $4, 'first_contact', 0, 'draft', 'Fixture', 'Fixture', 'fixture@example.test',
             'api', 'unknown', $5::timestamptz, $5::timestamptz)`,
    [DRAFT_NULL_AGENT, PROSPECT_UNKNOWN, DRAFT_UNKNOWN_AGENT, PROSPECT_TAGGED, CREATED_AT],
  );
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  await seed();
});

afterAll(async () => {
  // Only the rows seeded here: deleting the prospects cascades to their drafts. The shared test
  // directory is left in place for the rest of the process.
  const db = await getDb();
  await db.query(`DELETE FROM prospects WHERE id = ANY($1::uuid[])`, [PROSPECT_IDS]);
  await closeDb();
});

describe("counting drafts with the unknown agent filter", () => {
  it("matches the coalesced SQL count, both being two", async () => {
    const db = await getDb();
    const direct = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM drafts d JOIN prospects p ON p.id = d.prospect_id
        WHERE coalesce(d.source_agent, 'unknown') = 'unknown'
          AND d.created_at >= $1::timestamptz AND d.created_at < $2::timestamptz`,
      [DAY_FROM, DAY_TO],
    );

    expect(direct.rows[0].n).toBe(2);
    expect(await countDrafts(undefined, "unknown", FILTERS)).toBe(2);
  });
});

describe("paging drafts with the unknown agent filter", () => {
  it("reports the whole coerced set as the total", async () => {
    const page = await listDraftsPage(undefined, 200, "unknown", FILTERS);
    expect(page.total).toBe(2);
    expect(page.rows.length).toBe(2);
  });
});

describe("facet counts under the unknown agent filter", () => {
  it("counts both coalesced senders, today, and the unknown agent itself", async () => {
    const facets = await getDraftOriginFacets(undefined, { ...FILTERS, agent: "unknown", now: NOW });
    expect(facets.senders.default).toBe(2);
    expect(facets.added.today).toBe(2);
    expect(facets.agents.unknown).toBe(2);
  });
});
