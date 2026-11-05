import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { getDb } from "@/lib/db/client";
import { getConversationCounts, listConversations } from "@/lib/services/conversations";
import {
  cleanupFilterVerificationFixture as cleanup,
  seedFilterVerificationFixture as seed,
} from "./helpers/filter-verification-fixture";

/**
 * The Inbox filter matrix over the same 450-row fixture the other verification files use. The count
 * has to describe the whole filtered set — both its size and its unread total — while the list still
 * hands back a capped window. The SQL below is written out here rather than borrowed, so a real
 * disagreement between the two readings fails instead of agreeing with itself.
 */
type Filter = { query?: string; onlyReplied?: boolean };

const QUERIES = ["", "FilterFixture", "Fixture", "matrix-1@example.test", "NoMatch"];
const REPLIED = [true, false];
const AXES: { name: keyof Filter; values: (string | boolean)[] }[] = [
  { name: "query", values: QUERIES },
  { name: "onlyReplied", values: REPLIED },
];
const totals = { states: 0, countChecks: 0, idChecks: 0, pagingChecks: 0 };

/** The rows the Inbox admits, counted and ordered by SQL written here. */
async function oracle(input: Filter) {
  const db = await getDb();
  const params: unknown[] = [];
  const where = ["c.last_message_at IS NOT NULL"];
  if (input.onlyReplied !== false) where.push("c.last_inbound_at IS NOT NULL");
  const query = input.query?.trim();
  if (query) {
    params.push(`%${query}%`);
    where.push(`(p.business_name ILIKE $1 OR c.subject ILIKE $1 OR EXISTS (
      SELECT 1 FROM prospect_emails pe WHERE pe.prospect_id = p.id AND pe.email ILIKE $1))`);
  }
  const base = `FROM conversations c JOIN prospects p ON p.id = c.prospect_id WHERE ${where.join(" AND ")}`;
  const counts = await db.query<{ total: number; unread: number }>(
    `SELECT count(*)::int AS total, coalesce(sum(c.unread_count), 0)::int AS unread ${base}`,
    params,
  );
  const ids = await db.query<{ id: string }>(
    `SELECT c.id ${base} ORDER BY COALESCE(c.last_inbound_at, c.last_message_at) DESC`,
    params,
  );
  return {
    total: Number(counts.rows[0].total),
    unread: Number(counts.rows[0].unread),
    ids: ids.rows.map((row) => String(row.id)),
  };
}

async function verify(input: Filter): Promise<void> {
  const expected = await oracle(input);
  const counts = await getConversationCounts(input);
  expect({ total: counts.total, unread: counts.unread }).toEqual({
    total: expected.total,
    unread: expected.unread,
  });
  totals.countChecks += 2;

  const ids100 = (await listConversations({ ...input, limit: 100 })).map((row) => String(row.id));
  const ids200 = (await listConversations({ ...input, limit: 200 })).map((row) => String(row.id));
  expect(ids100).toEqual(expected.ids.slice(0, Math.min(100, expected.ids.length)));
  expect(ids200).toEqual(expected.ids.slice(0, Math.min(200, expected.ids.length)));
  totals.idChecks += ids100.length + ids200.length;

  // The 200-row window reaches past the old 150-row ceiling, and the count keeps describing the whole
  // filtered set rather than the window that happened to be loaded.
  if (expected.ids.length > 150) {
    expect(ids200.length).toBeGreaterThan(150);
    expect(ids200).toContain(expected.ids[150]);
  }
  if (expected.ids.length > 200) expect(counts.total).toBeGreaterThan(ids200.length);
  totals.pagingChecks += 2;
  totals.states += 1;
}

beforeAll(async () => {
  await seed("inbox");
});

afterAll(async () => {
  await mkdir("scratch", { recursive: true });
  await writeFile(
    "scratch/filter-verification-inbox.json",
    JSON.stringify({ ...totals, fixtureRows: 450, missingFolderSurface: true }, null, 2),
  );
  await cleanup();
});

describe("inbox filter verification", () => {
  it("baseline", async () => {
    await verify({});
  });

  for (const axis of AXES) {
    it(`singles: ${axis.name}`, async () => {
      for (const value of axis.values) await verify({ [axis.name]: value } as Filter);
    });
  }

  it("pairs: query x onlyReplied", async () => {
    for (const query of QUERIES) {
      for (const onlyReplied of REPLIED) await verify({ query, onlyReplied });
    }
  });
});
