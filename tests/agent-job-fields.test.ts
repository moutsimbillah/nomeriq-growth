import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";

import { closeDb, getDb } from "@/lib/db/client";
import { ensureBootstrapUser } from "@/lib/auth/session";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { createResearchJob, getResearchJob } from "@/lib/services/research";
import { saveProspect } from "@/lib/services/prospects";
import { runAgentAction } from "@/lib/agent/service";
import { assessmentFor } from "./helpers/lead-assessment";

/**
 * The assistant-facing job shape must name target progress and raw stored totals apart, and must keep
 * its older field names working as deprecated aliases of the CORRECTED values. A rename without the
 * alias broke the documented acceptance harness once; an alias that pointed back at the old
 * "any verified row with an email" counting would silently restore the very loophole this work closes.
 *
 * The fixture is deliberately discriminating: one counted Tier 1/Other lead and one email-no-website
 * lead. The raw total sees both (2); target progress sees only one (1). So an alias that agreed with
 * the raw total instead of the qualified count would fail here.
 */

const KEY = {
  id: "oauth:nq_jobfields",
  name: "Claude",
  assistant: "custom" as const,
  scopes: ["research:read", "research:write", "progress:read"],
};

let jobId = "";
let founderId = "";

afterAll(async () => {
  const db = await getDb();
  await db.query("DELETE FROM prospect_assessments WHERE prospect_id IN (SELECT id FROM prospects WHERE research_job_id=$1)", [jobId]);
  await db.query("DELETE FROM prospect_emails WHERE prospect_id IN (SELECT id FROM prospects WHERE research_job_id=$1)", [jobId]);
  await db.query("DELETE FROM prospect_sources WHERE prospect_id IN (SELECT id FROM prospects WHERE research_job_id=$1)", [jobId]);
  await db.query("DELETE FROM prospects WHERE research_job_id=$1", [jobId]);
  await db.query("DELETE FROM research_jobs WHERE id=$1", [jobId]);
  await db.query("DELETE FROM users WHERE id=$1", [founderId]);
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  const founder = await ensureBootstrapUser({
    email: `job-fields-${crypto.randomUUID()}@example.test`,
    name: "Job fields founder",
    password: crypto.randomUUID(),
  });
  founderId = founder.id;
  jobId = (await createResearchJob({
    name: "Job fields target",
    targetCount: 5,
    categories: ["forex"],
    userId: founder.id,
  })).id;

  // Counts: eligible Tier 1/Other with a source-backed email and an official website.
  const countedKey = `jf${crypto.randomUUID().replaceAll("-", "")}`;
  const counted = await saveProspect({
    businessName: `Compat counted ${countedKey}`,
    websiteUrl: `https://${countedKey}.example.test`,
    categories: ["forex"],
    email: `owner@${countedKey}.example.test`,
    emailSourceUrl: `https://${countedKey}.example.test/contact`,
    emailSourceType: "official_website",
    signalDescription: "Synthetic paid Forex signals",
    sources: [{ url: `https://${countedKey}.example.test/signals`, label: "Signals" }],
    researchJobId: jobId,
    actorType: "api",
    leadAssessment: assessmentFor(`https://${countedKey}.example.test`),
  });

  // Saved and verified, but NOT a counted tier: a published email on an official profile, no website.
  const profileKey = `jf${crypto.randomUUID().replaceAll("-", "")}`;
  const profile = `https://instagram.com/${profileKey}`;
  const notCounted = await saveProspect({
    businessName: `Compat email no website ${profileKey}`,
    websiteUrl: null,
    instagramUrl: profile,
    categories: ["forex"],
    email: `owner@${profileKey}.example.test`,
    emailSourceUrl: profile,
    emailSourceType: "official_social",
    signalDescription: "Synthetic paid Forex signals",
    sources: [{ url: `${profile}/signals`, label: "Profile signals" }],
    researchJobId: jobId,
    actorType: "api",
    leadAssessment: assessmentFor(profile),
  });

  expect(counted.leadModel?.tier).toBe("other");
  expect(notCounted.leadModel?.tier).toBe("email_no_website");
  expect(notCounted.prospect.qualificationStatus).toBe("verified"); // stored, just not counted
});

type JobFields = Record<string, number | string | null>;

async function jobFrom(tool: "list_research_jobs" | "get_research_job" | "report_progress"): Promise<JobFields> {
  const result = await runAgentAction(KEY as never, tool, tool === "list_research_jobs" ? {} : tool === "get_research_job" ? { jobId } : {});
  const data = result.data as Record<string, unknown>;
  const job = tool === "list_research_jobs"
    ? (data.jobs as Record<string, unknown>[]).find((row) => row.id === jobId)
    : tool === "get_research_job"
      ? data.job as Record<string, unknown>
      : (data.jobs as Record<string, unknown>[]).find((row) => row.id === jobId);
  expect(job).toBeTruthy();
  return job as JobFields;
}

describe("assistant job field compatibility", () => {
  it.each(["list_research_jobs", "get_research_job", "report_progress"] as const)(
    "%s reports the corrected count and keeps deprecated aliases in step",
    async (tool) => {
      const job = await jobFrom(tool);
      const stored = (await getResearchJob(jobId))!;

      // Authoritative names.
      expect(job.qualifiedTargetLeads).toBe(1);
      expect(job.verifiedRecordsWithEmail).toBe(2);
      // Deprecated aliases: same corrected values, present so older clients keep working.
      expect(job.newVerifiedLeads).toBe(job.qualifiedTargetLeads);
      expect(job.publishedContactEmails).toBe(job.verifiedRecordsWithEmail);
      // The alias must NOT have revived the old "verified row with an email" count (which would be 2).
      expect(job.newVerifiedLeads).toBe(1);
      expect(job.newVerifiedLeads).not.toBe(job.verifiedRecordsWithEmail);
      // Parity with the service figures the UI reads.
      expect(job.qualifiedTargetLeads).toBe(stored.verifiedCount);
      expect(job.verifiedRecordsWithEmail).toBe(stored.emailCount);
      expect(job.remaining).toBe(stored.remaining);
    },
  );

  it("keeps the acceptance harness on the authoritative field", () => {
    const harness = readFileSync("scripts/e2e-engine.mjs", "utf8");
    expect(harness).toContain("reported.qualifiedTargetLeads");
    expect(harness).not.toContain("newVerifiedLeads");
  });
});