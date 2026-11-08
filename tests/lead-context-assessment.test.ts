import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/profiles", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/email/profiles")>();
  return {
    ...original,
    resolveSendingProfile: vi.fn(async () => ({ fromName: "Moutsim · Nomeriq", emailAddress: "moutsim@sender.example.test", signature: "" })),
  };
});

import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { buildLeadContext } from "@/lib/ai/lead-context";
import { saveLeadAssessment } from "@/lib/services/lead-model";
import { LEAD_RULES_TEXT, LEAD_RULES_VERSION } from "@/lib/leads/model";
import { ASSISTANT_SKILL } from "@/lib/agent/instructions";

/**
 * The two ways the lead context can mislead a draft, and the fix for each:
 *
 *  - A lead nobody has assessed must not read as a lead proven to lack a
 *    platform. "Unknown" and "we did not check" are not the same as "Low".
 *  - A Category B lead is a research record that is never emailed. If a draft is
 *    ever produced for one, the context has to say so rather than describing it
 *    as an ordinary prospect.
 *
 * The tests drive the real builder and the real assessment writer, so they fail
 * if the wording or the wiring is changed back.
 */
const noAssessment = crypto.randomUUID();
const categoryB = crypto.randomUUID();

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  const db = await getDb();
  for (const [id, name, key] of [
    [noAssessment, "Unassessed Signals", "unassessed-signals"],
    [categoryB, "Telegram Only Signals", "telegram-only-signals"],
  ] as const) {
    await db.query(
      `INSERT INTO prospects (id, business_name, name_key, website_url, domain_key, categories, status)
       VALUES ($1, $2, $3, $4, $5, '["forex"]'::jsonb, 'new')`,
      [id, name, key, `https://${key}.example.test`, `${key}.example.test`],
    );
  }
  // Category B: eligible as a research record, no email, an official Telegram route.
  await db.query(
    `INSERT INTO prospect_contact_route_observations
       (id, prospect_id, platform, route_kind, handle, official_status, checked_at, source_url, provenance_key)
     VALUES ($1, $2, 'telegram', 'channel', 'telegramonlysignals', 'verified', now(),
             'https://telegram-only-signals.example.test/', $3)`,
    [crypto.randomUUID(), categoryB, crypto.randomUUID()],
  );
  await saveLeadAssessment(categoryB, {
    assessedAt: new Date().toISOString(),
    sourceKind: "research",
    eligibility: "eligible",
    platformMaturity: "fragmented",
    productFit: "high",
    fitReasoning: "Sells paid signals through a Telegram channel only.",
    researchConfidence: "medium",
    provenanceKey: crypto.randomUUID(),
    findings: [
      { area: "paid_signals", summary: "Paid memberships are sold.", sourceUrl: "https://telegram-only-signals.example.test/", observedAt: new Date().toISOString(), verdict: "present" },
      { area: "markets", summary: "Forex signals are sold.", sourceUrl: "https://telegram-only-signals.example.test/", observedAt: new Date().toISOString(), verdict: "present" },
      { area: "activity", summary: "Signals were posted this week.", sourceUrl: "https://telegram-only-signals.example.test/", observedAt: new Date().toISOString(), verdict: "present" },
    ],
    sourcesChecked: [{ url: "https://telegram-only-signals.example.test/", checkedAt: new Date().toISOString() }],
  });
});

afterAll(async () => {
  const db = await getDb();
  for (const id of [noAssessment, categoryB]) {
    await db.query(`DELETE FROM prospect_assessments WHERE prospect_id = $1`, [id]);
    await db.query(`DELETE FROM prospect_contact_route_observations WHERE prospect_id = $1`, [id]);
    await db.query(`DELETE FROM prospects WHERE id = $1`, [id]);
  }
  await closeDb();
});

describe("an unassessed lead", () => {
  it("says it was not assessed instead of implying something is missing", async () => {
    const context = await buildLeadContext(noAssessment);
    expect(context.present.assessment).toBe(false);
    expect(context.text).toContain("Assessment: not recorded");
    expect(context.text).toContain("Do not describe its platform, tooling or gaps at all");
    // The old placeholder claimed a tier field did not exist at all; the new
    // wording must not resurrect it, and no fit line may be invented.
    expect(context.text).not.toContain("Tier: not recorded");
    expect(context.text).not.toMatch(/Product fit: (High|Medium|Low)/);
  });
});

describe("a Category B lead", () => {
  it("tells the model it is a research record that is never emailed", async () => {
    const context = await buildLeadContext(categoryB);
    expect(context.present.assessment).toBe(true);
    expect(context.text).toContain("Category B");
    expect(context.text).toContain("never emailed, saved as a research record");
  });
});

describe("the rules every agent receives", () => {
  it("carries the founder's rules verbatim, with a precedence rule", () => {
    expect(ASSISTANT_SKILL).toContain(LEAD_RULES_TEXT);
    expect(ASSISTANT_SKILL).toContain(`BEGIN APPROVED RULES (verbatim)`);
    expect(ASSISTANT_SKILL).toContain(LEAD_RULES_VERSION);
    // Precedence must be stated, or the older prose sections can contradict it.
    expect(ASSISTANT_SKILL).toContain("this one wins");
  });

  it("still keeps the explanations that are not part of the rules document", () => {
    // The canonical block is added to the skill, not swapped in for it: the
    // operational guidance must survive alongside the rules.
    expect(ASSISTANT_SKILL).toContain("## Duplicate checking — mandatory");
    expect(ASSISTANT_SKILL).toContain("## The search ledger — check before you repeat");
  });
});
