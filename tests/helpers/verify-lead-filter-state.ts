import { expect } from "vitest";
import { oracleIds } from "./filter-sql-oracle";
import { listProspectsPage, countProspects, getProspectOriginFacets } from "@/lib/services/prospects";
import { AGENT_TAGS, CHANNEL_TAGS } from "@/lib/agent/agentTag";
import { COUNTED_ADDED_RANGES } from "@/lib/dates/pakistan";

export const leadVerificationTotals = { states: 0, resultChecks: 0, facetChecks: 0 };

export async function verifyLeadFilterState(
  f: Record<string, any>,
  senders: string[],
): Promise<void> {
  const expected = await oracleIds("leads", f);
  const expectedIds = expected.map((id) => String(id));

  const page = await listProspectsPage({ ...f, limit: 150 });
  const total = await countProspects(f);

  expect(page.total).toBe(expectedIds.length);
  expect(total).toBe(expectedIds.length);
  expect(page.rows.length).toBe(Math.min(150, expectedIds.length));
  expect(page.hasMore).toBe(expectedIds.length > 150);

  const returnedIds = page.rows.map((row: { id: unknown }) => String(row.id));
  for (const id of returnedIds) {
    expect(expectedIds).toContain(id);
  }
  leadVerificationTotals.resultChecks += 6;

  const full = await listProspectsPage({ ...f, limit: expectedIds.length + 150 });
  const fullIds = full.rows.map((row: { id: unknown }) => String(row.id));
  expect([...fullIds].sort()).toEqual([...expectedIds].sort());
  expect(returnedIds.every((id) => fullIds.includes(id))).toBe(true);

  const facets = (await getProspectOriginFacets(f)) as unknown as Record<
    string,
    Record<string, number>
  >;
  const check = async (
    axis: string,
    key: string,
    field: string,
    value: unknown,
  ): Promise<void> => {
    expect(Number(facets[axis][key] ?? 0)).toBe(
      (await oracleIds("leads", { ...f, [field]: value })).length,
    );
    leadVerificationTotals.facetChecks += 1;
  };

  for (const tag of AGENT_TAGS) {
    await check("agents", tag, "agent", tag);
  }
  for (const tag of [...CHANNEL_TAGS, "unknown"]) {
    await check("channels", tag, "channel", tag);
  }
  for (const sender of ["default", ...senders]) {
    await check("senders", sender, "sender", sender);
  }
  for (const range of COUNTED_ADDED_RANGES) {
    await check("added", range, "added", range);
  }
  await check("hasEmail", "yes", "hasEmail", true);
  await check("hasEmail", "no", "hasEmail", false);

  leadVerificationTotals.states += 1;
}
