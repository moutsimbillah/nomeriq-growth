import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { runAgentAction } from "@/lib/agent/service";
import { getOverallLeadTotals, getResearchOverview } from "@/lib/services/research";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { assessmentFor } from "./helpers/lead-assessment";

/**
 * The per-job counters only know about leads a research job created. A lead saved directly by a
 * connector belongs to no job, so `report_progress` must also report totals from the saved rows.
 */

const KEY = {
  id: "oauth:nq_overall",
  name: "Claude",
  assistant: "custom" as const,
  scopes: ["research:read", "research:write", "drafts:write", "progress:read", "product_truth:read"],
};

const PAYLOAD = {
  businessName: "No Job Signals",
  websiteUrl: "https://no-job.example",
  categories: ["forex"],
  signalDescription: "Sells paid forex signal subscriptions to retail traders.",
  email: "contact@no-job.example",
  emailSourceType: "official_website",
  emailSourceUrl: "https://no-job.example/contact",
  qualificationStatus: "verified",
  leadAssessment: assessmentFor("https://no-job.example"),
  sources: [{ url: "https://no-job.example/pricing", label: "Official pricing page" }],
};

afterAll(async () => {
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

beforeAll(async () => {
  await ensureWorkspaceDefaults();
});

describe("report_progress totals outside any research job", () => {
  it("counts a lead that belongs to no job, and says so separately", async () => {
    const saved = await runAgentAction(KEY as never, "save_prospect", PAYLOAD);
    const { prospect } = saved.data as { prospect: { id: string } };
    await runAgentAction(KEY as never, "save_draft", {
      prospectId: prospect.id,
      subject: "Independent signals for your members",
      body: "We build white-label trading-signal platforms. Who runs your alerts today?",
    });

    const overall = await getOverallLeadTotals();
    const perJob = await getResearchOverview();

    // From the saved rows.
    expect(overall.allLeads).toBe(1);
    // A modern assessment is what makes this a verified record; the legacy label alone would not.
    expect(overall.verifiedLeads).toBe(1);
    expect(overall.verifiedWithEmail).toBe(1);
    expect(overall.qualifiedTargetLeads).toBe(1);
    expect(overall.draftsSaved).toBe(1);
    expect(overall.notInAnyResearchJob).toBe(1);

    // The per-job counters know nothing about it — which is exactly why `overall` exists.
    expect(perJob.totalVerified).toBe(0);
    expect(perJob.totalDrafts).toBe(0);
  });

  it("is what report_progress returns", async () => {
    const result = await runAgentAction(KEY as never, "report_progress", {});
    const data = result.data as {
      overall: { verifiedLeads: number; qualifiedTargetLeads: number; notInAnyResearchJob: number };
      overview: { totalVerified: number; totalEmailsStored: number };
      note: string;
    };

    expect(data.overall.verifiedLeads).toBe(1);
    expect(data.overall.qualifiedTargetLeads).toBe(1);
    expect(data.overall.notInAnyResearchJob).toBe(1);
    expect(data.overview.totalVerified).toBe(0);
    expect(data.overview.totalEmailsStored).toBe(0);
    // Progress is named separately from the raw stored totals, so a caller cannot confuse them.
    expect(data.note).toContain("overall");
    expect(data.note).toContain("qualifiedTargetLeads");
    expect(data.note).toContain("not target progress");
  });

  it("drops the lead out of 'not in any job' once it is attached to one", async () => {
    const db = await getDb();
    const job = await db.query<{ id: string }>(
      `INSERT INTO research_jobs (id, name, target_count, categories, status)
       VALUES (gen_random_uuid(), 'Overall test job', 10, '["forex"]'::jsonb, 'active')
       RETURNING id`,
    );
    await db.query(`UPDATE prospects SET research_job_id = $1 WHERE website_url LIKE '%no-job.example%'`, [
      job.rows[0].id,
    ]);

    const overall = await getOverallLeadTotals();
    expect(overall.notInAnyResearchJob).toBe(0);
    expect(overall.allLeads).toBe(1);
  });
});