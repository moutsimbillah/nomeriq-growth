import { afterAll, beforeAll, expect, it } from "vitest";

import { closeDb, getDb } from "@/lib/db/client";
import { getProspectOriginFacets, listProspectsPage } from "@/lib/services/prospects";
import { countActiveFilters, leadFilterQuery, readLeadFilters } from "@/lib/leads/leadFilters";

/** 180 fixture leads, 160 of them with an email, so a page (150) and the true total (160) disagree. */
const MARKER = "EmailFixture";
const SEED = [
  `DELETE FROM prospects WHERE name_key LIKE 'email-fixture-%'`,
  `INSERT INTO prospects (id, business_name, name_key, created_by_type)
   SELECT gen_random_uuid(), 'EmailFixture' || i, 'email-fixture-' || i, 'api'
   FROM generate_series(1, 180) AS i`,
  // Each fixture business has its own email domain; strict deduplication refuses a shared one.
  `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url)
   SELECT gen_random_uuid(), p.id, 'f-' || i || '@email-fixture-' || i || '.example.test',
          'f-' || i || '@email-fixture-' || i || '.example.test', 'https://email-fixture-' || i || '.example.test'
   FROM generate_series(1, 160) AS i
   JOIN prospects p ON p.name_key = 'email-fixture-' || i`,
];

beforeAll(async () => {
  const db = await getDb();
  for (const sql of SEED) await db.query(sql);
});

afterAll(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM prospects WHERE name_key LIKE 'email-fixture-%'`);
  await closeDb();
});

it("round-trips the no filter through the URL and counts it as one active filter", () => {
  const filters = readLeadFilters({ hasEmail: "no" });
  expect(filters.hasEmail).toBe(false);
  expect(leadFilterQuery(filters)).toBe("?hasEmail=no");
  expect(countActiveFilters(filters)).toBe(1);
});

it("drops an unrecognised hasEmail value", () => {
  const filters = readLeadFilters({ hasEmail: "maybe" });
  expect(filters.hasEmail).toBeUndefined();
  expect(countActiveFilters(filters)).toBe(0);
});

it("lists only leads with an email, capped at one page against the true total", async () => {
  const page = await listProspectsPage({ query: MARKER, hasEmail: true });
  expect(page.total).toBe(160);
  expect(page.rows).toHaveLength(150);
});

it("loads every matching lead when the window grows past the total", async () => {
  const page = await listProspectsPage({ query: MARKER, hasEmail: true, limit: 300 });
  expect(page.total).toBe(160);
  expect(page.rows).toHaveLength(160);
});

it("counts both facet sides over the whole set, not a page", async () => {
  const facets = await getProspectOriginFacets({ query: MARKER });
  expect(facets.hasEmail).toEqual({ yes: 160, no: 20 });
  const none = await listProspectsPage({ query: MARKER, hasEmail: false });
  expect(none.total).toBe(20);
  const db = await getDb();
  const truth = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM prospects p
     WHERE p.name_key LIKE 'email-fixture-%'
       AND EXISTS (SELECT 1 FROM prospect_emails pe WHERE pe.prospect_id = p.id)`,
  );
  expect(Number(truth.rows[0].n)).toBe(facets.hasEmail.yes);
});
