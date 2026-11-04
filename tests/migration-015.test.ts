import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * Migration 015 lets a send that is only waiting be recorded as waiting. Without it the too-soon path
 * had to delete its attempt row, so nothing on a clock could ever find the draft again.
 *
 * Additive and re-runnable: one nullable column, a wider status CHECK, and a partial index. The six
 * statuses that already existed must all still be accepted, and a made-up one must not.
 */

const SQL = readFileSync("src/db/migrations/015_queued_sends.sql", "utf8");
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

describe("migration 015", () => {
  it("accepts queued and keeps the six statuses that already existed", async () => {
    await run();
    const db = await getDb();
    const account = await db.query<{ id: string }>(
      `INSERT INTO email_accounts (id, name, provider, email_address, normalized_email, from_name, status)
       VALUES (gen_random_uuid(), 'Migration 015', 'sandbox', 'migration-015@example.test',
               'migration-015@example.test', 'Migration 015', 'connected')
       RETURNING id`,
    );
    const accountId = account.rows[0].id;
    const prospect = await db.query<{ id: string }>(
      `INSERT INTO prospects (id, business_name, name_key, created_by_type)
       VALUES (gen_random_uuid(), 'Migration 015 Co', 'migration-015-co', 'founder')
       RETURNING id`,
    );
    const draft = await db.query<{ id: string }>(
      `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
                           ai_generated, warnings, created_by_type)
       VALUES (gen_random_uuid(), $1, 'first_contact', 0, 'approved', 'Subject', 'Body', 'a@b.test',
               false, '[]'::jsonb, 'founder')
       RETURNING id`,
      [prospect.rows[0].id],
    );
    const draftId = draft.rows[0].id;

    try {
      // one attempt row per draft (draft_id is unique), so the statuses are walked on that one row
      const send = await db.query<{ id: string }>(
        `INSERT INTO outbound_sends (id, draft_id, account_id, recipient_email, subject,
                                     idempotency_key, status)
         VALUES (gen_random_uuid(), $1, $2, 'a@b.test', 'Subject', 'migration-015-key', 'sending')
         RETURNING id`,
        [draftId, accountId],
      );
      const sendId = send.rows[0].id;

      for (const status of ["accepted", "sandbox", "failed", "uncertain", "blocked"]) {
        await db.query(`UPDATE outbound_sends SET status = $2 WHERE id = $1`, [sendId, status]);
      }

      await db.query(
        `UPDATE outbound_sends SET status = 'queued', queued_at = now() WHERE id = $1`,
        [sendId],
      );
      const queued = await db.query<{ queued_at: string | null }>(
        `SELECT queued_at FROM outbound_sends WHERE id = $1`,
        [sendId],
      );
      expect(queued.rows[0].queued_at).not.toBeNull();

      await expect(
        db.query(`UPDATE outbound_sends SET status = 'invented' WHERE id = $1`, [sendId]),
      ).rejects.toThrow();
    } finally {
      await db.query(`DELETE FROM outbound_sends WHERE draft_id = $1`, [draftId]);
      await db.query(`DELETE FROM drafts WHERE id = $1`, [draftId]);
      await db.query(`DELETE FROM prospects WHERE id = $1`, [prospect.rows[0].id]);
      await db.query(`DELETE FROM email_accounts WHERE id = $1`, [accountId]);
    }
  });

  it("is safe to run again, twice over", async () => {
    await run();
    await run();
    const db = await getDb();
    const constraint = await db.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'outbound_sends_status_check'`,
    );
    expect(constraint.rows[0].definition).toContain("queued");
    const column = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.columns
        WHERE table_name = 'outbound_sends' AND column_name = 'queued_at'`,
    );
    expect(column.rows[0].count).toBe("1");
    const index = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_indexes
        WHERE tablename = 'outbound_sends' AND indexname = 'outbound_sends_queued_idx'`,
    );
    expect(index.rows[0].count).toBe("1");
  });
});
