import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { ensureWorkspaceDefaults, updateWorkspaceSettings } from "@/lib/services/settings";
import { createResearchJob, getResearchJob, updateResearchJobStatus } from "@/lib/services/research";
import { runResearchTick } from "@/lib/services/research-engine";
import { getResearchUsage, recordResearchUsage } from "@/lib/services/research-usage";
import { getJobBudget } from "@/lib/services/research-runs";
import { qualifyingSite, createFakeProvider } from "./fake-provider";

const state = { userId: "" };

describe("spend reconciliation", () => {
  beforeAll(async () => {
    const db = await getDb();
    await ensureWorkspaceDefaults();
    state.userId = crypto.randomUUID();
    await db.query(
      `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, 'founder')`,
      [
        state.userId,
        "spend@test.nomeriq.com",
        "spend@test.nomeriq.com",
        "Spend Founder",
        hashPassword("TestPassw0rd!123"),
      ],
    );
    await updateWorkspaceSettings(
      {
        legalBusinessName: "Nomeriq Test",
        postalAddress: "1 Test Street",
        senderSignature: "Test",
        followUpMax: 2,
        followUpDelay1Days: 4,
        followUpDelay2Days: 7,
        researchDefaultBudgetUsd: 5,
        researchDefaultConcurrency: 3,
        deepseekSearchQps: 5,
        deepseekFetchQps: 5,
      },
      state.userId,
    );
  });

  afterAll(async () => {
    await closeDb();
    const dir = process.env.PGLITE_DIR || "";
    if (dir.startsWith(".data/test-vitest-")) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("keeps spent_usd exactly equal to the sum of usage rows across many charges", async () => {
    const job = await createResearchJob({
      name: "Reconciliation",
      targetCount: 5,
      categories: ["forex"],
      engine: "deepseek",
      budgetUsd: 100,
      concurrency: 3,
      userId: state.userId,
    });
    await updateResearchJobStatus(job.id, "active");

    // Costs with 6 decimals, the precision research_usage stores. If spent_usd
    // is a lower precision column, each incremental add rounds and the job's
    // stored spend silently drifts away from the operations it claims to total.
    const charges = [0.000750, 0.000750, 0.002250, 0.000405, 0.000755, 0.000751];
    for (const costUsd of charges) {
      await recordResearchUsage({
        jobId: job.id,
        operation: "search",
        model: "deepseek-flash",
        costUsd,
      });
    }

    const usage = await getResearchUsage(job.id);
    const budget = await getJobBudget(job.id);
    const expected = charges.reduce((sum, value) => sum + value, 0);

    expect(usage.costUsd).toBeCloseTo(expected, 6);
    // The stored job spend must reconcile exactly with the recorded operations.
    expect(budget!.spentUsd).toBeCloseTo(expected, 6);
    expect(usage.unknownCostCalls).toBe(0);
    expect(Math.abs(budget!.spentUsd - usage.costUsd!)).toBeLessThan(1e-9);
  });

  it("keeps spend reconciled through a real engine run", async () => {
    const job = await createResearchJob({
      name: "Reconciliation run",
      targetCount: 3,
      categories: ["forex"],
      engine: "deepseek",
      budgetUsd: 100,
      concurrency: 3,
      userId: state.userId,
    });
    await updateResearchJobStatus(job.id, "active");

    const sites = Array.from({ length: 3 }, (_, index) =>
      qualifyingSite({
        domain: `recon-${index}.example.com`,
        businessName: `Recon ${index}`,
        email: `desk${index}@recon-${index}.example.com`,
      }),
    );
    const { provider } = createFakeProvider({ sites });

    let guard = 0;
    let current = (await getResearchJob(job.id))!;
    while (current.verifiedCount < current.targetCount && guard < 20) {
      await runResearchTick(job.id, { provider, workerId: `recon-${guard}` });
      current = (await getResearchJob(job.id))!;
      guard += 1;
    }

    const usage = await getResearchUsage(job.id);
    const budget = await getJobBudget(job.id);
    expect(usage.unknownCostCalls).toBe(0);
    expect(budget!.spentUsd).toBeCloseTo(usage.costUsd!, 9);
  });

  it("reconciles pre-existing drift on an already-deployed database", async () => {
    // Simulates the upgrade path: a database that has been running with the old
    // numeric(12,4) column and has already accumulated rounding drift. Migration
    // 005 must both widen the column and repair the recorded total.
    const db = await getDb();
    const job = await createResearchJob({
      name: "Legacy drift",
      targetCount: 2,
      categories: ["forex"],
      engine: "deepseek",
      budgetUsd: 100,
      concurrency: 1,
      userId: state.userId,
    });
    await updateResearchJobStatus(job.id, "active");

    // Real charges summing to 0.005661, recorded as usage rows.
    const charges = [0.000750, 0.000750, 0.002250, 0.000405, 0.000755, 0.000751];
    for (const costUsd of charges) {
      await recordResearchUsage({
        jobId: job.id,
        operation: "search",
        model: "deepseek-flash",
        costUsd,
      });
    }
    const trueTotal = charges.reduce((sum, value) => sum + value, 0);

    // Force the historical defect: a drifted total, as the old column produced.
    await db.query(`UPDATE research_jobs SET spent_usd = $1 WHERE id = $2`, [
      0.0059,
      job.id,
    ]);

    // Re-run migration 005's reconciliation exactly as the migration does.
    await db.exec(`
      UPDATE research_jobs j
      SET spent_usd = u.total, updated_at = now()
      FROM (
        SELECT job_id, sum(cost_usd) AS total
        FROM research_usage
        WHERE job_id IS NOT NULL
        GROUP BY job_id
      ) u
      WHERE j.id = u.job_id
        AND abs(j.spent_usd - u.total) > 0.0000005;
    `);

    const budget = await getJobBudget(job.id);
    expect(budget!.spentUsd).toBeCloseTo(trueTotal, 6);
  });

  it("stores spend at the same precision as the usage rows it sums", async () => {
    // Guards the schema invariant directly: a lower-precision column silently
    // reintroduces drift however careful the application code is.
    const db = await getDb();
    const result = await db.query<{ table_name: string; numeric_precision: number; numeric_scale: number }>(
      `SELECT table_name, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE (table_name = 'research_jobs' AND column_name = 'spent_usd')
          OR (table_name = 'research_usage' AND column_name = 'cost_usd')`,
    );
    const scaleFor = (table: string) =>
      Number(result.rows.find((row) => row.table_name === table)?.numeric_scale);
    expect(scaleFor("research_usage")).toBe(6);
    expect(scaleFor("research_jobs")).toBe(scaleFor("research_usage"));
  });

  it("applies the spend migration idempotently to an existing database", async () => {
    // Migration 005 runs against databases that already hold data. It must be
    // safe to apply more than once, and must not corrupt a reconciled total.
    const db = await getDb();
    const migrationSql = await fs.readFile(
      path.join(process.cwd(), "src/db/migrations/005_spend_precision.sql"),
      "utf8",
    );

    const job = await createResearchJob({
      name: "Idempotency",
      targetCount: 1,
      categories: ["forex"],
      engine: "deepseek",
      budgetUsd: 10,
      concurrency: 1,
      userId: state.userId,
    });
    await recordResearchUsage({
      jobId: job.id,
      operation: "fetch",
      model: "deepseek-flash",
      costUsd: 0.000755,
    });

    // Apply twice; the second pass must be a no-op rather than an error.
    await db.exec(migrationSql);
    await db.exec(migrationSql);

    const budget = await getJobBudget(job.id);
    expect(budget!.spentUsd).toBeCloseTo(0.000755, 6);

    // The column must still be at full precision after repeated application.
    const result = await db.query<{ numeric_scale: number }>(
      `SELECT numeric_scale FROM information_schema.columns
       WHERE table_name = 'research_jobs' AND column_name = 'spent_usd'`,
    );
    expect(Number(result.rows[0]?.numeric_scale)).toBe(6);
  });
});
