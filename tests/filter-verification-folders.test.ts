import { afterAll, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { FOLDERS, folderFor } from "@/lib/services/folders";
import { PIPELINE } from "@/lib/types";
import { closeDb, getDb } from "@/lib/db/client";

/**
 * One independent SQL cube -- unnest PIPELINE crossed with suppression, archive, draft, reply and the
 * five timing modes -- carrying the existing precedence as a CASE. Every row is also handed to
 * `folderFor`, so a real disagreement fails instead of agreeing with itself. No lead rows are read.
 */
const REASONS = ["unsubscribe", "opt_out", "complaint", "bounce", "manual"];
const T04 = "2026-11-04T10:00:00.000Z";
const T05 = "2026-11-05T10:00:00.000Z";
/** none, inbound latest, outbound latest, inbound only, tied, outbound only. */
const TIMINGS: [string | null, string | null][] = [
  [null, null], [T05, T04], [T04, T05], [T05, null], [T05, T05], [null, T05],
];

const stamp = (v: string | null) => (v ? `'${v}'::timestamptz` : "NULL::timestamptz");
const statuses = PIPELINE.map((s) => `('${s}')`).join(",");
const reasons = [...REASONS.map((r) => `('${r}')`), "(NULL::text)"].join(",");
const timings = TIMINGS.map(([i, o]) => `(${stamp(i)}, ${stamp(o)})`).join(",");

/** Every virtual row, with the folder the existing precedence says it belongs in. */
const JUDGED = `
  WITH cube AS (
    SELECT p.status, s.reason, a.archived, d.draft_waiting, r.replied, t.inbound, t.outbound
    FROM unnest(ARRAY[${statuses}]::text[]) AS p(status)
    CROSS JOIN (VALUES ${reasons}) AS s(reason)
    CROSS JOIN (VALUES (false), (true)) AS a(archived)
    CROSS JOIN (VALUES (false), (true)) AS d(draft_waiting)
    CROSS JOIN (VALUES (false), (true)) AS r(replied)
    CROSS JOIN (VALUES ${timings}) AS t(inbound, outbound)
  )
  SELECT *, CASE
      WHEN archived THEN 'archived'
      WHEN reason IN ('unsubscribe', 'opt_out', 'complaint') THEN 'opted_out'
      WHEN reason = 'bounce' THEN 'failed'
      WHEN reason = 'manual' THEN 'on_hold'
      WHEN status = 'won' THEN 'won'
      WHEN status = 'lost' THEN 'closed_lost'
      WHEN status IN ('demo', 'proposal') THEN 'meeting'
      WHEN inbound IS NOT NULL AND (outbound IS NULL OR inbound >= outbound) THEN 'needs_reply'
      WHEN draft_waiting THEN 'to_approve'
      WHEN status = 'interested' THEN 'in_conversation'
      WHEN replied AND outbound > coalesce(inbound, to_timestamp(0)) THEN 'in_conversation'
      WHEN status = 'contacted' THEN 'waiting'
      ELSE 'new_leads'
    END AS expected
  FROM cube
`;

type Row = {
  status: string; reason: string | null; archived: boolean; draft_waiting: boolean;
  replied: boolean; inbound: string | null; outbound: string | null; expected: string;
};

/** "rejected" is already in FOLDERS, so the keys are just the folder keys plus the archive surface. */
const KEYS = [...new Set([...FOLDERS.map((f) => f.key), "archived"])];
const totals = { cases: 0 };
/** The real per-folder counts, filled in by the test and written out by afterAll. */
let countMap: Record<string, number> = {};
const tally = () => Object.fromEntries(KEYS.map((key) => [key, 0]));
const input = (r: Row) => ({
  status: r.status, archivedAt: r.archived ? T05 : null, suppressionReason: r.reason,
  hasDraftWaiting: r.draft_waiting, hasReplied: r.replied, lastInboundAt: r.inbound, lastOutboundAt: r.outbound,
});
const seen = (r: Row) => `${r.status}/${r.reason}/${r.archived}/${r.draft_waiting}/${r.replied}`;

afterAll(async () => {
  await mkdir("scratch", { recursive: true });
  const counts = { cases: totals.cases, counts: countMap, missingFolderSurface: true };
  await writeFile("scratch/filter-verification-folders.json", JSON.stringify(counts, null, 2));
  await closeDb();
});

it("matches folderFor and its own counts against the cube", async () => {
  const db = await getDb();
  const { rows } = await db.query<Row>(JUDGED);
  const wrong = rows.filter((r) => folderFor(input(r)) !== r.expected);
  expect(wrong.map(seen)).toEqual([]);
  totals.cases = rows.length;
  expect(rows.length).toBe(PIPELINE.length * (REASONS.length + 1) * 2 * 2 * 2 * TIMINGS.length);

  const { rows: grouped } = await db.query<{ expected: string; n: number }>(
    `SELECT expected, count(*)::int AS n FROM (${JUDGED}) judged GROUP BY expected`,
  );
  const actual = tally();
  const expected = tally();
  for (const row of rows) actual[folderFor(input(row))] += 1;
  for (const g of grouped) expected[g.expected] = Number(g.n);
  expect(actual).toEqual(expected);
  expect(expected.rejected).toBe(0);
  const sum = (counts: Record<string, number>) => Object.values(counts).reduce((n, v) => n + v, 0);
  expect(sum(actual)).toBe(rows.length);
  expect(sum(expected)).toBe(rows.length);
  countMap = actual;
});
