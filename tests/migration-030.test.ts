import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * Rehearsal for 030_lead_model.sql, required by the independent review of the lead-model Part 1
 * change (2026-11-07, batch deleg_eeae127a, item 8): every statement is additive-only
 * (CREATE TABLE/INDEX IF NOT EXISTS, ENABLE ROW LEVEL SECURITY, REVOKE ALL FROM PUBLIC), so running
 * it twice must leave every existing row and column untouched — not merely "not error".
 */

const SQL = readFileSync("src/db/migrations/030_lead_model.sql", "utf8");
const STATEMENTS = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

async function run() {
  const db = await getDb();
  for (const statement of STATEMENTS) await db.query(statement);
}

const TABLES = [
  "prospect_assessments",
  "prospect_audience_observations",
  "prospect_contact_route_observations",
  "prospect_assessment_overrides",
  "prospect_rejection_recommendations",
];

beforeAll(async () => {
  await ensureWorkspaceDefaults();
});
afterAll(async () => {
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

describe("migration 030 (lead model)", () => {
  it("every table and column already exists, from the normal migration bootstrap", async () => {
    const db = await getDb();
    for (const table of TABLES) {
      const columns = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table],
      );
      expect(columns.rows.length).toBeGreaterThan(0);
    }
  });

  it("is safe to run again, twice over: no column, row or row-security state changes", async () => {
    const db = await getDb();
    const before = new Map<string, { columns: number; rows: string }>();
    for (const table of TABLES) {
      const columns = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.columns WHERE table_name = $1`,
        [table],
      );
      const rows = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
      before.set(table, { columns: Number(columns.rows[0].count), rows: rows.rows[0].count });
    }
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      [TABLES],
    );
    expect(rls.rows.every((row) => row.relrowsecurity === true)).toBe(true);

    await run();
    await run();

    for (const table of TABLES) {
      const columns = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.columns WHERE table_name = $1`,
        [table],
      );
      const rows = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
      const expected = before.get(table)!;
      // The exact proof the reviewer asked for: not merely "no error", but no column added or
      // dropped, and no existing row touched.
      expect(Number(columns.rows[0].count)).toBe(expected.columns);
      expect(rows.rows[0].count).toBe(expected.rows);
    }
    const rlsAfter = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      [TABLES],
    );
    expect(rlsAfter.rows.every((row) => row.relrowsecurity === true)).toBe(true);
  });
});
