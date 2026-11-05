import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * Migration 022 marks the import's own mailbox as never the workspace default.
 *
 * The defect it repairs: the resolver sorted by is_default and then took the first row regardless, so
 * moutsim@nomeriq.com — the one row in the live table — acted as the default for every lead the import
 * never pinned to it. Additive and safe to re-run: one column with a default, and one UPDATE that only
 * ever touches that address.
 */

const ADDRESS = "moutsim@nomeriq.com";

const SQL = readFileSync("src/db/migrations/022_never_default_sender.sql", "utf8");
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

const created = { accounts: [] as string[] };

async function newAccount(address: string, isDefault: boolean): Promise<string> {
  const db = await getDb();
  const row = await db.query<{ id: string }>(
    `INSERT INTO email_accounts (id, name, provider, email_address, normalized_email, from_name,
                                 status, is_default)
     VALUES (gen_random_uuid(), $1, 'sandbox', $2, $2, $1, 'unverified', $3)
     RETURNING id`,
    [`Migration 022 ${created.accounts.length + 1}`, address, isDefault],
  );
  created.accounts.push(row.rows[0].id);
  return row.rows[0].id;
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
});
afterAll(async () => {
  const db = await getDb();
  for (const id of created.accounts) await db.query(`DELETE FROM email_accounts WHERE id = $1`, [id]);
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

describe("migration 022", () => {
  it("adds never_default and marks the import's mailbox, leaving other rows alone", async () => {
    const db = await getDb();

    const columns = await db.query<{ column_name: string; is_nullable: string; column_default: string }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'email_accounts' AND column_name = 'never_default'`,
    );
    expect(columns.rows).toHaveLength(1);
    expect(columns.rows[0].is_nullable).toBe("NO");
    expect(columns.rows[0].column_default).toContain("false");

    // the live state this repairs: the import's row present, and the only row, yet acting as default
    const other = await newAccount("migration-022-other@example.test", false);
    const imported = await newAccount(ADDRESS, true);
    await run();

    const rows = await db.query<{ id: string; never_default: boolean; is_default: boolean }>(
      `SELECT id, never_default, is_default FROM email_accounts WHERE id = ANY($1::uuid[])`,
      [[imported, other]],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    expect(byId.get(imported)?.never_default).toBe(true);
    expect(byId.get(imported)?.is_default).toBe(false);
    // no other row changed value
    expect(byId.get(other)?.never_default).toBe(false);
    expect(byId.get(other)?.is_default).toBe(false);
  });

  it("is safe to run again, twice over", async () => {
    await run();
    await run();
    const db = await getDb();
    const columns = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.columns
        WHERE table_name = 'email_accounts' AND column_name = 'never_default'`,
    );
    expect(columns.rows[0].count).toBe("1");
    const imported = await db.query<{ never_default: boolean; is_default: boolean }>(
      `SELECT never_default, is_default FROM email_accounts WHERE normalized_email = $1`,
      [ADDRESS],
    );
    expect(imported.rows[0].never_default).toBe(true);
    expect(imported.rows[0].is_default).toBe(false);
  });
});
