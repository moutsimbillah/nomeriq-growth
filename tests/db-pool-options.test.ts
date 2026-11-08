import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Live measurement (2026-11-08): Postgres JIT-compiled ~400 functions for the follow-up candidate
 * query on every dashboard load. That was 3.3s of a 4.5s query; with JIT off the query ran in 1.6s.
 * The app's PostgreSQL pool therefore sends `-c jit=off` as a startup option on every connection.
 * This pins that so it cannot quietly disappear. PGlite (tests, local dev) is unaffected.
 */
const poolConfigs: Array<Record<string, unknown>> = [];

vi.mock("pg", () => {
  class Pool {
    constructor(config: Record<string, unknown>) { poolConfigs.push(config); }
    async query() { return { rows: [], rowCount: 0 }; }
    async end() {}
  }
  return { Pool, default: { Pool } };
});

const originalUrl = process.env.DATABASE_URL;
const originalMigrate = process.env.AUTO_MIGRATE;

afterEach(async () => {
  const { closeDb } = await import("@/lib/db/client");
  await closeDb();
  process.env.DATABASE_URL = originalUrl;
  process.env.AUTO_MIGRATE = originalMigrate;
  poolConfigs.length = 0;
});

describe("PostgreSQL pool connection options", () => {
  it("turns JIT off for every app connection", async () => {
    const { closeDb, getDb } = await import("@/lib/db/client");
    await closeDb();
    process.env.DATABASE_URL = "postgres://user:pw@127.0.0.1:5432/growth_test_unreachable";
    process.env.AUTO_MIGRATE = "false";

    await getDb();

    expect(poolConfigs).toHaveLength(1);
    expect(poolConfigs[0].options).toBe("-c jit=off");
  });
});
