import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { verifyPassword } from "@/lib/auth/password";
import { getWorkspaceSettings } from "@/lib/services/settings";
import { main as runSeed, resolveSeedScope } from "../scripts/seed";

const FOUNDER_EMAIL = "seed-scope@nomeriq.test";
const FOUNDER_PASSWORD = "seed-scope-password";

async function tableCounts() {
  const db = await getDb();
  const result = await db.query<{
    users: number;
    prospects: number;
    drafts: number;
    email_accounts: number;
    research_jobs: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM users)          AS users,
       (SELECT count(*)::int FROM prospects)      AS prospects,
       (SELECT count(*)::int FROM drafts)         AS drafts,
       (SELECT count(*)::int FROM email_accounts) AS email_accounts,
       (SELECT count(*)::int FROM research_jobs)  AS research_jobs`,
  );
  return result.rows[0];
}

beforeAll(async () => {
  // The seed reads these at call time, so setting them here wins over any .env values.
  process.env.ADMIN_EMAIL = FOUNDER_EMAIL;
  process.env.ADMIN_PASSWORD = FOUNDER_PASSWORD;
  process.env.ADMIN_NAME = "Seed Scope Founder";
  // The seed narrates a lot; keep the suite's output readable.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await getDb();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("resolveSeedScope", () => {
  it("defaults to the full slice when unset or blank", () => {
    expect(resolveSeedScope(undefined)).toBe("full");
    expect(resolveSeedScope("")).toBe("full");
    expect(resolveSeedScope("   ")).toBe("full");
    expect(resolveSeedScope("full")).toBe("full");
  });

  it("accepts every founder spelling, case and spacing included", () => {
    for (const raw of ["founder", "FOUNDER", " founder ", "founder-only", "founder_only"]) {
      expect(resolveSeedScope(raw)).toBe("founder");
    }
  });

  it("refuses an unknown scope instead of quietly seeding samples", () => {
    expect(() => resolveSeedScope("samples")).toThrow(/Unknown SEED_SCOPE "samples"/);
  });
});

describe("SEED_SCOPE=founder", () => {
  it("creates the founder and the workspace settings, and nothing else", async () => {
    expect(await tableCounts()).toMatchObject({
      users: 0,
      prospects: 0,
      drafts: 0,
      email_accounts: 0,
      research_jobs: 0,
    });

    await runSeed("founder");

    expect(await tableCounts()).toMatchObject({
      users: 1,
      prospects: 0,
      drafts: 0,
      email_accounts: 0,
      research_jobs: 0,
    });

    const db = await getDb();
    const founder = (
      await db.query<{ email: string; role: string; normalized_email: string; password_hash: string }>(
        "SELECT email, role, normalized_email, password_hash FROM users",
      )
    ).rows[0];

    expect(founder.role).toBe("founder");
    expect(founder.normalized_email).toBe(FOUNDER_EMAIL);
    expect(verifyPassword(FOUNDER_PASSWORD, founder.password_hash)).toBe(true);

    const settings = await getWorkspaceSettings();
    expect(settings.legalBusinessName).toBe("Nomeriq");
    expect(settings.followUpMax).toBe(2);
  });

  it("is safe to re-run: no second founder and still no sample data", async () => {
    await runSeed("founder");
    expect(await tableCounts()).toMatchObject({ users: 1, prospects: 0, drafts: 0 });
  });
});

describe("the full slice is unchanged", () => {
  it("still seeds the samples when the scope is full", async () => {
    await runSeed("full");

    const counts = await tableCounts();
    expect(counts.users).toBe(1);
    expect(counts.research_jobs).toBe(1);
    expect(counts.email_accounts).toBe(1);
    expect(counts.prospects).toBeGreaterThan(0);
    expect(counts.drafts).toBeGreaterThan(0);
  });
});
