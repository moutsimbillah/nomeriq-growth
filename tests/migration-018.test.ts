import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * Migration 018 keeps the old portal as it was, in a read-only `legacy` schema.
 *
 * Two things matter: nothing is lost, and the application cannot come to depend on it — an archive the
 * app reads is not an archive, it is a second schema with an unclear owner.
 */

const SQL = readFileSync("src/db/migrations/018_legacy_archive.sql", "utf8");
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

describe("migration 018: the legacy archive", () => {
  it("holds every exported table plus the file provenance, and is safe to re-run", async () => {
    await run();
    await run();
    const db = await getDb();

    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'legacy' ORDER BY 1`,
    );
    const names = tables.rows.map((row) => row.table_name);
    // the 47 exported tables and one provenance table
    expect(names).toHaveLength(48);
    expect(names).toContain("import_files");
    // every archive table is one of the old portal's own, never something this portal invented
    expect(names.filter((name) => name !== "import_files").every((name) => name.startsWith("marketing_"))).toBe(true);
    // the tables the plan called out by name are certainly there
    for (const required of [
      "marketing_qualification_assessments",
      "marketing_pipeline_transitions",
      "marketing_outreach_sequences",
      "marketing_outreach_draft_approvals",
      "marketing_workspace_revocations",
      "marketing_outreach_intents",
      "marketing_outreach_events",
      "marketing_email_transport_evidence",
      "marketing_email_holds",
      "marketing_conversation_links",
      "marketing_conversation_attention",
      "marketing_reply_suggestions",
      "marketing_sales_draft_bindings",
      "marketing_sales_proposal_bindings",
      "marketing_message_proposals",
    ]) {
      expect(names, required).toContain(required);
    }
  });

  it("keeps a row exactly as it arrived", async () => {
    const db = await getDb();
    const original = {
      id: "6f0c2b7e-0000-4000-8000-000000000001",
      angle: "postal-address tension — “we know your market”",
      wave: 2,
      scores: { brand_risk: 0.2, fit: 0.87 },
      tags: ["stock signals", "options"],
      footer: "Unsubscribe — ñ ✓",
      executor_token: null,
    };
    await db.query(`INSERT INTO legacy.marketing_outreach_sequences (id, data) VALUES ($1, $2::jsonb)
                    ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [original.id, JSON.stringify(original)]);

    const read = await db.query<{ data: typeof original }>(
      `SELECT data FROM legacy.marketing_outreach_sequences WHERE id = $1`,
      [original.id],
    );
    expect(read.rows[0].data).toEqual(original);
    await db.query(`DELETE FROM legacy.marketing_outreach_sequences WHERE id = $1`, [original.id]);
  });

  it("records the file it loaded, once", async () => {
    const db = await getDb();
    const row = [
      "marketing_outreach_sequences.jsonl",
      "marketing_outreach_sequences",
      "9f2c1a4c3f5e6d7b8a9c0d1e2f3a4b5c6d7e8f90123456789abcdef0123456",
      459,
      129787,
    ];
    await db.query(
      `INSERT INTO legacy.import_files (file, source_table, sha256, rows, bytes)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (file) DO NOTHING`,
      row,
    );
    const read = await db.query<{ rows: number }>(
      `SELECT rows FROM legacy.import_files WHERE file = $1`,
      [row[0]],
    );
    expect(read.rows[0].rows).toBe(459);
    // the same file cannot be recorded twice, so a re-run cannot double-count
    await expect(
      db.query(
        `INSERT INTO legacy.import_files (file, source_table, sha256, rows, bytes)
         VALUES ($1, $2, $3, $4, $5)`,
        row,
      ),
    ).rejects.toThrow();
    await db.query(`DELETE FROM legacy.import_files WHERE file = $1`, [row[0]]);
  });

  it("is never read by the application", async () => {
    // A guard, not a comment: an archive the app queries is not an archive.
    const offenders: string[] = [];
    async function walk(dir: string) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const source = await fs.readFile(full, "utf8");
        // either the schema prefix or an explicit legacy table name would be a dependency
        if (/legacy\.(marketing_|import_files)/.test(source) || /\bFROM\s+legacy\b/.test(source)) {
          offenders.push(full);
        }
      }
    }
    await walk("src");
    expect(offenders).toEqual([]);
  });
});