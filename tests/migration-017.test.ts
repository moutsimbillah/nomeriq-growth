import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * Migration 017 lets a row say it came from the old portal.
 *
 * The tags are only worth having if they are true, so the import needs its own channel value rather
 * than claiming to be `founder` or `claude`. Additive and re-runnable: four CHECKs replaced with wider
 * sets, no row touched.
 */

const SQL = readFileSync("src/db/migrations/017_legacy_origin.sql", "utf8");
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

describe("migration 017", () => {
  it("accepts an imported row's channel and origin, and still refuses a made-up one", async () => {
    await run();
    const db = await getDb();

    const prospect = await db.query<{ id: string }>(
      `INSERT INTO prospects (id, business_name, name_key, created_by_type, source_agent, source_channel)
       VALUES (gen_random_uuid(), 'Legacy Origin Co', 'legacy-origin-co', 'legacy', 'claude', 'legacy_import')
       RETURNING id`,
    );
    const prospectId = prospect.rows[0].id;
    const draft = await db.query<{ id: string }>(
      `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
                           ai_generated, warnings, created_by_type, source_agent, source_channel)
       VALUES (gen_random_uuid(), $1, 'first_contact', 0, 'sent', 'Subject', 'Body', 'a@b.test',
               false, '[]'::jsonb, 'legacy', 'chatgpt', 'legacy_import')
       RETURNING id`,
      [prospectId],
    );
    const draftId = draft.rows[0].id;

    try {
      // the four values it already had must still be accepted, on both tables
      for (const channel of ["mcp_oauth", "api_key", "engine", "founder"]) {
        await db.query(`UPDATE prospects SET source_channel = $2 WHERE id = $1`, [prospectId, channel]);
        await db.query(`UPDATE drafts SET source_channel = $2 WHERE id = $1`, [draftId, channel]);
      }

      await expect(
        db.query(`UPDATE prospects SET source_channel = 'invented' WHERE id = $1`, [prospectId]),
      ).rejects.toThrow();
      await expect(
        db.query(`UPDATE drafts SET source_channel = 'invented' WHERE id = $1`, [draftId]),
      ).rejects.toThrow();
      await expect(
        db.query(`UPDATE prospects SET created_by_type = 'invented' WHERE id = $1`, [prospectId]),
      ).rejects.toThrow();
      // and the six that were allowed before are still allowed
      for (const origin of ["founder", "chatgpt", "claude", "deepseek", "api", "seed"]) {
        await db.query(`UPDATE prospects SET created_by_type = $2 WHERE id = $1`, [prospectId, origin]);
      }
      await db.query(`UPDATE prospects SET created_by_type = 'legacy' WHERE id = $1`, [prospectId]);
    } finally {
      await db.query(`DELETE FROM drafts WHERE id = $1`, [draftId]);
      await db.query(`DELETE FROM prospects WHERE id = $1`, [prospectId]);
    }
  });

  it("is safe to run again, twice over", async () => {
    await run();
    await run();
    const db = await getDb();
    const constraints = await db.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname IN ('prospects_source_channel_check', 'drafts_source_channel_check',
                          'prospects_created_by_type_check', 'drafts_created_by_type_check')`,
    );
    expect(constraints.rows).toHaveLength(4);
    for (const row of constraints.rows) {
      expect(row.definition).toMatch(/legacy_import|legacy/);
    }
    const index = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_indexes WHERE indexname = 'prospects_legacy_import_idx'`,
    );
    expect(index.rows[0].count).toBe("1");
  });
});
