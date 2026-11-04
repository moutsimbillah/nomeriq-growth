import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * Migration 016 gives a mailbox the fields a profile needs (signature, warm-up) and ties a lead and a
 * thread to the profile that emailed them. Additive and re-runnable: four nullable columns and two
 * indexes, and no existing row is touched.
 */

const SQL = readFileSync("src/db/migrations/016_sending_profiles.sql", "utf8");
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

describe("migration 016", () => {
  it("adds the profile fields, and a lead can carry a profile", async () => {
    await run();
    const db = await getDb();

    const columns = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name = 'email_accounts' AND column_name IN ('signature', 'warmup_started_at'))
           OR (table_name = 'prospects' AND column_name IN ('sending_profile_id', 'sending_profile_pinned_at'))
           OR (table_name = 'conversations' AND column_name = 'sending_profile_id')`,
    );
    expect(columns.rows).toHaveLength(5);

    const account = await db.query<{ id: string }>(
      `INSERT INTO email_accounts (id, name, provider, email_address, normalized_email, from_name, status)
       VALUES (gen_random_uuid(), 'Migration 016', 'sandbox', 'migration-016@example.test',
               'migration-016@example.test', 'Migration 016', 'connected')
       RETURNING id`,
    );
    const accountId = account.rows[0].id;
    const prospect = await db.query<{ id: string }>(
      `INSERT INTO prospects (id, business_name, name_key, created_by_type, sending_profile_id,
                              sending_profile_pinned_at)
       VALUES (gen_random_uuid(), 'Migration 016 Co', 'migration-016-co', 'founder', $1, now())
       RETURNING id`,
      [accountId],
    );

    try {
      await db.query(`UPDATE email_accounts SET signature = 'Best, Founder' WHERE id = $1`, [accountId]);
      const stored = await db.query<{ signature: string }>(
        `SELECT signature FROM email_accounts WHERE id = $1`,
        [accountId],
      );
      expect(stored.rows[0].signature).toBe("Best, Founder");

      // deleting the profile must not delete the lead: it simply has no profile any more
      await db.query(`DELETE FROM email_accounts WHERE id = $1`, [accountId]);
      const after = await db.query<{ sending_profile_id: string | null }>(
        `SELECT sending_profile_id FROM prospects WHERE id = $1`,
        [prospect.rows[0].id],
      );
      expect(after.rows[0].sending_profile_id).toBeNull();
    } finally {
      await db.query(`DELETE FROM prospects WHERE id = $1`, [prospect.rows[0].id]);
      await db.query(`DELETE FROM email_accounts WHERE id = $1`, [accountId]);
    }
  });

  it("is safe to run again, twice over", async () => {
    await run();
    await run();
    const db = await getDb();
    const indexes = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_indexes
        WHERE indexname IN ('prospects_sending_profile_idx', 'conversations_sending_profile_idx')`,
    );
    expect(indexes.rows[0].count).toBe("2");
  });
});
