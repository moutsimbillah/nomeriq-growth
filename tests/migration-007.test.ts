import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb, type DbClient } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * Migration 007 does two things the application now relies on:
 *
 * 1. The DeepSeek QPS ceiling is 5 per second per account (Search and Fetch).
 *    The old constraint allowed 100/25, so 007 clamps any stored row and then
 *    rebuilds the CHECK.
 * 2. api_keys gains an expiry, backfilled to 90 days after creation so every
 *    key already in use has a definite end date.
 *
 * These tests apply the real SQL file against a real migrated database rather
 * than asserting on the file's text, because the behaviour that matters is what
 * the database does when the migration runs — including when it runs twice.
 */

const MIGRATION_PATH = path.join(
  process.cwd(),
  "src",
  "db",
  "migrations",
  "007_qps_and_key_expiry.sql",
);

const DAY_MS = 86_400_000;

let db: DbClient;
let migrationSql: string;

describe("migration 007 — QPS ceiling and key expiry", () => {
  beforeAll(async () => {
    db = await getDb();
    migrationSql = await fs.readFile(MIGRATION_PATH, "utf8");
    await ensureWorkspaceDefaults();
  });

  afterAll(async () => {
    await closeDb();
    const dir = process.env.PGLITE_DIR || "";
    if (dir.startsWith(".data/test-vitest-")) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("applies twice without error", async () => {
    // It has already run once through AUTO_MIGRATE; these two re-applications
    // are the upgrade path a redeploy performs.
    await expect(db.exec(migrationSql)).resolves.toBeUndefined();
    await expect(db.exec(migrationSql)).resolves.toBeUndefined();
  });

  it("refuses a QPS value above the documented ceiling", async () => {
    await expect(
      db.query("UPDATE workspace_settings SET deepseek_search_qps = 6"),
    ).rejects.toThrow();
    await expect(
      db.query("UPDATE workspace_settings SET deepseek_fetch_qps = 6"),
    ).rejects.toThrow();
  });

  it("clamps a row that already held the old 100/25 values", async () => {
    // Simulate the pre-007 state: no constraint, out-of-range values stored.
    await db.exec(
      "ALTER TABLE workspace_settings DROP CONSTRAINT IF EXISTS workspace_settings_deepseek_qps_check",
    );
    await db.query(
      "UPDATE workspace_settings SET deepseek_search_qps = 100, deepseek_fetch_qps = 25",
    );

    await db.exec(migrationSql);

    const row = await db.query<{ search_qps: number | string; fetch_qps: number | string }>(
      `SELECT deepseek_search_qps AS search_qps, deepseek_fetch_qps AS fetch_qps
       FROM workspace_settings LIMIT 1`,
    );
    expect(Number(row.rows[0].search_qps)).toBe(5);
    expect(Number(row.rows[0].fetch_qps)).toBe(5);
  });

  it("stores api_keys.expires_at as a timestamp with time zone", async () => {
    const column = await db.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'api_keys' AND column_name = 'expires_at'`,
    );
    expect(column.rows).toHaveLength(1);
    expect(column.rows[0].data_type).toBe("timestamp with time zone");
    // Legacy rows predate the column, so it must stay nullable.
    expect(column.rows[0].is_nullable).toBe("YES");
  });

  it("backfills a 90-day expiry for a key created before the column existed", async () => {
    const legacyId = crypto.randomUUID();
    const createdAt = "2026-01-01T00:00:00Z";

    await db.query(
      `INSERT INTO api_keys
        (id, name, assistant, key_prefix, key_hash, scopes, created_by, created_at, expires_at)
       VALUES ($1, 'legacy key', 'claude', 'ng_live_legacy', $2, '[]'::jsonb, NULL, $3, NULL)`,
      [legacyId, `hash-legacy-${legacyId}`, createdAt],
    );

    await db.exec(migrationSql);

    const row = await db.query<{ expires_at: string | Date | null }>(
      "SELECT expires_at FROM api_keys WHERE id = $1",
      [legacyId],
    );
    const expiresAt = row.rows[0]?.expires_at;
    expect(expiresAt).not.toBeNull();
    expect(new Date(String(expiresAt)).getTime()).toBe(
      new Date(createdAt).getTime() + 90 * DAY_MS,
    );
  });
});