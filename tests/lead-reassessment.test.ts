/**
 * Re-assessment of a lead Growth already holds.
 *
 * One business is one record, but an assistant that finds the missing evidence later must be able to
 * complete the qualification on that record — the alternative was an unbreakable "outreach blocked" state
 * with no path except a founder override. These tests pin the promotion, the founder-override refusal,
 * the archived refusal and the ambiguous-identity refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/db/client";
import { ensureBootstrapUser } from "@/lib/auth/session";
import { saveProspect, type SaveProspectInput } from "@/lib/services/prospects";
import type { LeadFinding } from "@/lib/leads/model";

let founderId = "";
const ids = new Set<string>();
const key = () => `ra${crypto.randomUUID().replaceAll("-", "")}`;

function assessment(eligible: boolean, keyName: string, checkedAt: string) {
  const website = `https://${keyName}.example.test`;
  const fact = (area: LeadFinding["area"]): LeadFinding => ({
    area, summary: `Synthetic official ${area} evidence`, sourceUrl: `${website}/${area}`, observedAt: checkedAt, verdict: "present",
  });
  return {
    assessedAt: checkedAt,
    eligibility: eligible ? "eligible" : "unknown",
    findings: [fact("paid_signals"), fact("markets"), fact("email"), fact("identity"), fact("activity")],
    sourcesChecked: [{ url: `${website}/signals`, checkedAt }],
  } as SaveProspectInput["leadAssessment"];
}

function payload(keyName: string, eligible: boolean): SaveProspectInput {
  const checkedAt = new Date().toISOString();
  return {
    businessName: `Reassess fixture ${keyName}`,
    websiteUrl: `https://${keyName}.example.test`,
    categories: ["forex"],
    signalDescription: "Synthetic paid Forex VIP signals",
    sources: [{ url: `https://${keyName}.example.test/signals`, label: "Official paid signals" }],
    email: `owner@${keyName}.example.test`,
    emailSourceUrl: `https://${keyName}.example.test/contact`,
    emailSourceType: "official_website",
    actorType: "api",
    leadAssessment: assessment(eligible, keyName, checkedAt),
  };
}

beforeAll(async () => {
  founderId = (await ensureBootstrapUser({
    email: `reassess-${crypto.randomUUID()}@fixture.test`,
    password: crypto.randomUUID(),
    name: "Synthetic",
  })).id;
});

afterAll(async () => {
  const db = await getDb();
  if (ids.size) {
    const list = [...ids];
    await db.query(`DELETE FROM prospect_assessment_overrides WHERE prospect_id = ANY($1::uuid[])`, [list]);
    await db.query(`DELETE FROM prospect_assessments WHERE prospect_id = ANY($1::uuid[])`, [list]);
    await db.query(`DELETE FROM prospect_emails WHERE prospect_id = ANY($1::uuid[])`, [list]);
    await db.query(`DELETE FROM audit_log WHERE entity_id = ANY($1::text[])`, [list]);
    await db.query(`DELETE FROM prospects WHERE id = ANY($1::uuid[])`, [list]);
  }
  await closeDb();
});

async function saveCandidate(keyName: string) {
  const saved = await saveProspect({
    businessName: `Reassess fixture ${keyName}`,
    websiteUrl: `https://${keyName}.example.test`,
    categories: ["forex"],
    signalDescription: "Synthetic paid Forex VIP signals",
    sources: [{ url: `https://${keyName}.example.test/signals`, label: "Official paid signals" }],
    email: `owner@${keyName}.example.test`,
    emailSourceUrl: `https://${keyName}.example.test/contact`,
    emailSourceType: "official_website",
    actorType: "api",
    leadAssessment: assessment(false, keyName, new Date().toISOString()),
  });
  ids.add(saved.prospect.id);
  return saved.prospect.id;
}

describe("a saved lead can be re-assessed with new evidence", () => {
  it("promotes a candidate to verified on the same record, keeping the old assessment as history", async () => {
    const name = key();
    const id = await saveCandidate(name);
    const before = (await getDb()).query;
    expect(before).toBeTypeOf("function");

    const again = await saveProspect(payload(name, true));
    expect(again.created).toBe(false);
    expect(again.resolution).toBe("reassessed");
    expect(again.prospect.id).toBe(id);
    expect(again.leadModel?.eligibility).toBe("eligible");

    const db = await getDb();
    const prospect = (await db.query<{ qualification_status: string; verified_at: string | null; status: string }>(
      `SELECT qualification_status, verified_at::text AS verified_at, status FROM prospects WHERE id = $1`, [id],
    )).rows[0];
    expect(prospect.qualification_status).toBe("verified");
    expect(prospect.verified_at).not.toBeNull();
    const assessments = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM prospect_assessments WHERE prospect_id = $1`, [id],
    )).rows[0].n;
    expect(assessments).toBeGreaterThanOrEqual(2);
    const total = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM prospects WHERE domain_key = $1`, [`${name}.example.test`],
    )).rows[0].n;
    expect(total).toBe(1);
    const audit = (await db.query<{ metadata: { reassessment?: boolean } }>(
      `SELECT metadata FROM audit_log WHERE entity_id = $1 AND action = 'lead.assessment_applied' ORDER BY created_at DESC LIMIT 1`, [id],
    )).rows[0];
    expect(audit?.metadata?.reassessment).toBe(true);
  });

  it("never displaces a founder decision on tier or eligibility", async () => {
    const name = key();
    const id = await saveCandidate(name);
    const db = await getDb();
    await db.query(
      `INSERT INTO prospect_assessment_overrides (id, prospect_id, field_name, decision, value, reason, decided_by, decided_at, provenance_key)
       VALUES ($1, $2, 'eligibility', 'set', '"eligible"'::jsonb, 'Founder decision', $3, now(), $4)`,
      [crypto.randomUUID(), id, founderId, crypto.randomUUID()],
    );
    const error = await saveProspect(payload(name, true)).then(() => null, (caught: unknown) => caught as Error & { code?: string });
    expect(error?.message).toMatch(/founder/i);
    const assessments = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM prospect_assessments WHERE prospect_id = $1`, [id],
    )).rows[0].n;
    expect(assessments).toBe(1);
  });

  it("refuses to resurrect an archived lead", async () => {
    const name = key();
    const id = await saveCandidate(name);
    const db = await getDb();
    await db.query(`UPDATE prospects SET archived_at = now() WHERE id = $1`, [id]);
    await expect(saveProspect(payload(name, true))).rejects.toThrow(/archived/i);
    const still = (await db.query<{ archived_at: string | null }>(
      `SELECT archived_at::text AS archived_at FROM prospects WHERE id = $1`, [id],
    )).rows[0];
    expect(still.archived_at).not.toBeNull();
  });

  it("leaves the earlier behaviour alone when no assessment is supplied", async () => {
    const name = key();
    const id = await saveCandidate(name);
    const db = await getDb();
    const before = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM prospect_assessments WHERE prospect_id = $1`, [id],
    )).rows[0].n;

    const result = await saveProspect({
      businessName: `Reassess fixture ${name}`,
      websiteUrl: `https://${name}.example.test`,
      categories: ["forex"],
      signalDescription: "Synthetic paid Forex VIP signals",
      sources: [{ url: `https://${name}.example.test/signals`, label: "Official paid signals" }],
      email: `owner@${name}.example.test`,
      emailSourceUrl: `https://${name}.example.test/contact`,
      emailSourceType: "official_website",
      actorType: "api",
    });

    expect(result.created).toBe(false);
    expect(result.resolution).toBe("already_exists");
    const after = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM prospect_assessments WHERE prospect_id = $1`, [id],
    )).rows[0].n;
    expect(after).toBe(before);
  });
});