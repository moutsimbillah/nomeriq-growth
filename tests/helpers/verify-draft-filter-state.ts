import { expect } from "vitest";
import { oracleIds } from "./filter-sql-oracle";
import { countDrafts, getDraftOriginFacets, listDraftsPage } from "@/lib/services/drafts";
import { AGENT_TAGS } from "@/lib/agent/agentTag";
import { COUNTED_ADDED_RANGES } from "@/lib/dates/pakistan";

/** Running check counts, so a suite can report how much of the matrix it really exercised. */
export const draftVerificationTotals = { states: 0, resultChecks: 0, facetChecks: 0 };
const PAGE = 120;
const RANGES = ["last7", "last30", "last_month", "this_month", "today", "yesterday"];

function oracleFilter(f: Record<string, any>, patch: Record<string, any> = {}) {
  return { ...f, ...patch };
}

/**
 * Verifies one Drafts filter state against the independent SQL oracle: the true total, the capped
 * window and its ids, the full-page id set, and every facet option counted with the state's other
 * filters applied but never its own. `status` stays a base constraint in every facet query.
 */
export async function verifyDraftFilterState(
  f: Record<string, any>,
  senders: string[],
): Promise<void> {
  const expected = await oracleIds("drafts", oracleFilter(f));
  const inExpected = new Set(expected);

  const page = await listDraftsPage(f.status, PAGE, f.agent, f);
  const count = await countDrafts(f.status, f.agent, f);
  expect(count).toBe(expected.length);
  expect(page.total).toBe(expected.length);
  expect(page.rows.length).toBe(Math.min(PAGE, page.total));
  expect(page.hasMore).toBe(page.total > page.rows.length);
  for (const row of page.rows) expect(inExpected.has(row.id), row.id).toBe(true);
  draftVerificationTotals.states += 1;
  draftVerificationTotals.resultChecks += 4;

  // A window wider than the whole filtered set returns exactly that set, so "Load more" can only
  // ever add rows the oracle already matched, and the first page is a subset of it.
  const full = await listDraftsPage(f.status, expected.length + PAGE, f.agent, f);
  const loaded = full.rows.map((row) => row.id).sort();
  expect(loaded).toEqual([...expected].sort());
  const shown = new Set(loaded);
  for (const row of page.rows) expect(shown.has(row.id), row.id).toBe(true);
  draftVerificationTotals.resultChecks += 2;

  const facets = await getDraftOriginFacets(f.status, f);
  expect(AGENT_TAGS.length).toBe(8);
  for (const agent of AGENT_TAGS) {
    expect(facets.agents[agent] ?? 0, agent).toBe(
      (await oracleIds("drafts", oracleFilter(f, { agent }))).length,
    );
    draftVerificationTotals.facetChecks += 1;
  }
  for (const sender of [...senders, "default"]) {
    expect(facets.senders[sender] ?? 0, sender).toBe(
      (await oracleIds("drafts", oracleFilter(f, { sender }))).length,
    );
    draftVerificationTotals.facetChecks += 1;
  }
  for (const key of Object.keys(facets.senders)) {
    expect(key === "default" || senders.includes(key), key).toBe(true);
  }
  expect([...COUNTED_ADDED_RANGES].sort()).toEqual([...RANGES].sort());
  for (const added of COUNTED_ADDED_RANGES) {
    expect(facets.added[added] ?? 0, added).toBe(
      (await oracleIds("drafts", oracleFilter(f, { added }))).length,
    );
    draftVerificationTotals.facetChecks += 1;
  }
}
