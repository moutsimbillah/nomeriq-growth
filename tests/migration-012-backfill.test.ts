import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * Migration 012 adds `source_client` and backfills the eight rows that existed when it was written.
 * This runs it against a throwaway database, twice, and proves it attributes exactly those rows and
 * nothing else — no wildcard, no blanket UPDATE.
 */

const SQL = readFileSync("src/db/migrations/012_source_client.sql", "utf8");

// PGlite runs one statement per call, so split the file the way the migrator does.
const STATEMENTS = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

const NAMED_PROSPECTS: [string, string, string][] = [
  ["f8602ca5-bf39-402b-84cd-21212da236fd", "P4 Provider", "Claude"],
  ["123d1e92-be6d-4754-a23c-d7958abce752", "Learn2Trade", "Claude"],
  ["815a1cd5-86c5-4705-9402-ab6b98526c89", "Tawsiyat", "Claude"],
  ["fa5981b5-b8d9-4a2e-acd8-89d4c0f2ee4a", "Infinity Signals FX", "ChatGPT"],
];

const NAMED_DRAFTS: [string, string, string][] = [
  ["f4610445-6004-47ef-a012-a4e2b5fa674a", "f8602ca5-bf39-402b-84cd-21212da236fd", "Claude"],
  ["132a60b9-4d4d-4c66-92fa-f42e0bdf4031", "123d1e92-be6d-4754-a23c-d7958abce752", "Claude"],
  ["c1b2ba85-2756-4985-9131-26bf70910f9f", "815a1cd5-86c5-4705-9402-ab6b98526c89", "Claude"],
  ["1eb2aebe-3032-4bde-8be4-7393d5daaa40", "fa5981b5-b8d9-4a2e-acd8-89d4c0f2ee4a", "ChatGPT"],
];

// A row with no audit entry: the migration must not touch it.
const STRANGER_PROSPECT = "aaaaaaaa-0000-4000-8000-000000000001";
const STRANGER_DRAFT = "aaaaaaaa-0000-4000-8000-000000000002";

async function runMigration() {
  const db = await getDb();
  for (const statement of STATEMENTS) await db.query(statement);
}

async function insertRow(table: "prospects" | "drafts", id: string, businessName: string) {
  const db = await getDb();
  if (table === "prospects") {
    await db.query(
      `INSERT INTO prospects (id, business_name, name_key, website_url, domain_key, categories,
                              qualification_status, status, created_by_type)
       VALUES ($1, $2, lower($2), $3, $3, '["forex"]'::jsonb, 'verified', 'verified', 'api')
       ON CONFLICT (id) DO NOTHING`,
      [id, businessName, `${id}.example`],
    );
    return;
  }
  await db.query(
    `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
                         ai_generated, warnings, created_by_type)
     VALUES ($1, $2, 'first_contact', 0, 'draft', 'Subject', $3, 'contact@example.com', true, '[]'::jsonb, 'api')
     ON CONFLICT (id) DO NOTHING`,
    [id, NAMED_DRAFTS.find(([draftId]) => draftId === id)?.[1] ?? STRANGER_PROSPECT,
     "A body long enough to satisfy the table's own expectations for a first contact draft."],
  );
}

async function values(table: "prospects" | "drafts") {
  const db = await getDb();
  const result = await db.query<{ id: string; source_client: string | null }>(
    `SELECT id, source_client FROM ${table} ORDER BY id`,
  );
  return new Map(result.rows.map((row) => [row.id, row.source_client]));
}

afterAll(async () => {
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  for (const [id, name] of NAMED_PROSPECTS) await insertRow("prospects", id, name);
  await insertRow("prospects", STRANGER_PROSPECT, "Not In Any Audit Entry");
  for (const [id] of NAMED_DRAFTS) await insertRow("drafts", id, "x");
  const db = await getDb();
  await db.query(
    `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
                         ai_generated, warnings, created_by_type)
     VALUES ($1, $2, 'first_contact', 0, 'draft', 'Subject', $3, 'contact@example.com', true, '[]'::jsonb, 'founder')
     ON CONFLICT (id) DO NOTHING`,
    [STRANGER_DRAFT, STRANGER_PROSPECT, "A body long enough to satisfy the table's own expectations."],
  );
});

describe("migration 012 backfill", () => {
  it("attributes exactly the eight rows the audit log named", async () => {
    await runMigration();

    const prospects = await values("prospects");
    for (const [id, , client] of NAMED_PROSPECTS) expect(prospects.get(id)).toBe(client);

    const drafts = await values("drafts");
    for (const [id, , client] of NAMED_DRAFTS) expect(drafts.get(id)).toBe(client);

    // Four prospects and four drafts were named; nothing else was touched.
    expect(prospects.get(STRANGER_PROSPECT)).toBeNull();
    expect(drafts.get(STRANGER_DRAFT)).toBeNull();
  });

  it("does not overwrite a value that is already there", async () => {
    const db = await getDb();
    await db.query(`UPDATE drafts SET source_client = 'Founder portal' WHERE id = $1`, [STRANGER_DRAFT]);

    await runMigration();

    const drafts = await values("drafts");
    expect(drafts.get(STRANGER_DRAFT)).toBe("Founder portal");
    // and the eight are still exactly as the audit log said
    for (const [id, , client] of NAMED_DRAFTS) expect(drafts.get(id)).toBe(client);
  });

  it("is safe to run again: a third and fourth pass change nothing", async () => {
    const before = { prospects: await values("prospects"), drafts: await values("drafts") };

    await runMigration();
    await runMigration();

    expect(await values("prospects")).toEqual(before.prospects);
    expect(await values("drafts")).toEqual(before.drafts);
  });
});