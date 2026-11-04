import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * Migration 014 widens the allowed contact source types with founder_entered, so an address the
 * founder typed can be recorded honestly instead of being refused. Additive and re-runnable: it only
 * replaces the CHECK with a wider set and touches no row.
 */

const SQL = readFileSync("src/db/migrations/014_founder_entered_email.sql", "utf8");
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

beforeAll(async () => {
  await ensureWorkspaceDefaults();
});
afterAll(async () => {
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

describe("migration 014", () => {
  it("accepts a founder-entered contact, and still accepts the four sourced types", async () => {
    await run();
    const db = await getDb();
    const prospect = await db.query<{ id: string }>(
      `INSERT INTO prospects (id, business_name, name_key, categories, created_by_type)
       VALUES (gen_random_uuid(), 'Migration 014 Co', 'migration 014 co', '[]'::jsonb, 'founder')
       RETURNING id`,
    );
    const id = prospect.rows[0].id;
    for (const type of ["official_website", "official_social", "official_directory", "public_profile", "founder_entered"]) {
      await db.query(
        `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type)
         VALUES (gen_random_uuid(), $1, $2, $2, 'https://example.test/contact', $3)`,
        [id, `${type}@migration-014.example`, type],
      );
    }
    const rows = await db.query(`SELECT 1 FROM prospect_emails WHERE prospect_id = $1`, [id]);
    expect(rows.rows).toHaveLength(5);

    await expect(
      db.query(
        `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type)
         VALUES (gen_random_uuid(), $1, 'x@migration-014.example', 'x@migration-014.example',
                 'https://example.test/contact', 'invented')`,
        [id],
      ),
    ).rejects.toThrow();

    await db.query(`DELETE FROM prospect_emails WHERE prospect_id = $1`, [id]);
    await db.query(`DELETE FROM prospects WHERE id = $1`, [id]);
  });

  it("is safe to run again", async () => {
    const db = await getDb();
    const before = await db.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'prospect_emails_source_type_check'`,
    );
    await run();
    await run();
    const after = await db.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'prospect_emails_source_type_check'`,
    );
    expect(after.rows[0].definition).toBe(before.rows[0].definition);
  });
});