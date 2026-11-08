import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb, type DbClient } from "@/lib/db/client";
import { ensureBootstrapUser } from "@/lib/auth/session";
import { getRecipientPolicy, getRecipientPoliciesBatch } from "@/lib/services/recipient-policy";
import { getLeadOutreachBlock, getLeadOutreachBlocksBatch } from "@/lib/services/lead-outreach-guard";
import { readFollowUpCandidates } from "@/lib/services/agent-followups";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * The batch recipient-policy/outreach-block readers exist only to replace a per-lead query loop
 * with a fixed number of round trips. Every scenario here proves the batch answer for a lead is
 * identical to calling the single-lead function for that same lead — suppression, archive,
 * do-not-contact, an address-wide rejection hold, an excluded/category_b tier and a founder
 * override that clears back to the assessment's own value all have to carry through unchanged.
 */
let db: DbClient;
let userId: string;
const leads: string[] = [];
const suppressionIds: string[] = [];
const marker = crypto.randomUUID();

async function makeLead(opts: {
  email?: string; secondLocal?: string; doNotContact?: boolean; archived?: boolean;
} = {}): Promise<{ id: string; email: string; domain: string }> {
  const id = crypto.randomUUID();
  // A distinct business domain per fixture lead: different leads may not share a business email domain.
  const domain = `${id}.batch.test`;
  const email = opts.email ?? `${id}@${domain}`;
  leads.push(id);
  await db.query(
    `INSERT INTO prospects (id, business_name, name_key, domain_key, do_not_contact, archived_at, created_by_type)
     VALUES ($1::uuid, 'Batch fixture', $2, $2, $3, $4, 'founder')`,
    [id, `${marker}-${id}`, Boolean(opts.doNotContact), opts.archived ? new Date().toISOString() : null],
  );
  await db.query(
    `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type, is_primary)
     VALUES ($1, $2, $3, $3, $4, 'official_website', true)`,
    [crypto.randomUUID(), id, email, `https://${domain}`],
  );
  if (opts.secondLocal) {
    await db.query(
      `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type, is_primary)
       VALUES ($1, $2, $3, $3, $4, 'official_website', false)`,
      [crypto.randomUUID(), id, `${opts.secondLocal}@${domain}`, `https://${domain}`],
    );
  }
  const conversationId = crypto.randomUUID();
  await db.query(`INSERT INTO conversations (id, prospect_id, subject) VALUES ($1, $2, 'Batch')`, [conversationId, id]);
  await db.query(
    `INSERT INTO messages (id, conversation_id, prospect_id, direction, from_email, to_emails, sent_at)
     VALUES ($1, $2, $3, 'outbound', 'founder@batch.test', $4::jsonb, '2026-01-01')`,
    [crypto.randomUUID(), conversationId, id, JSON.stringify([email])],
  );
  return { id, email, domain };
}
async function suppress(email: string, reason: string, prospectId: string | null) {
  const id = crypto.randomUUID();
  suppressionIds.push(id);
  await db.query(
    `INSERT INTO suppressions (id, normalized_email, email, reason, prospect_id) VALUES ($1,$2,$2,$3,$4)`,
    [id, email, reason, prospectId],
  );
}

async function assess(prospectId: string, fields: { tier?: string | null; eligibility?: string; exclusionReason?: string }) {
  await db.query(
    `INSERT INTO prospect_assessments
       (id, prospect_id, rules_version, assessed_at, source_kind, eligibility, tier, exclusion_reason, provenance_key)
     VALUES ($1, $2, 'test', now(), 'founder', $3, $4, $5, $6)`,
    [crypto.randomUUID(), prospectId, fields.eligibility ?? "unknown", fields.tier ?? null, fields.exclusionReason ?? null, `assess:${crypto.randomUUID()}`],
  );
}
async function override(prospectId: string, fieldName: string, decision: "set" | "clear", value: unknown) {
  await db.query(
    `INSERT INTO prospect_assessment_overrides
       (id, prospect_id, field_name, decision, value, reason, decided_by, provenance_key)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'test override', $6, $7)`,
    [crypto.randomUUID(), prospectId, fieldName, decision, value === undefined ? null : JSON.stringify(value), userId, `override:${crypto.randomUUID()}`],
  );
}

beforeAll(async () => {
  db = await getDb();
  await ensureWorkspaceDefaults();
  userId = (await ensureBootstrapUser({ email: `${marker}@batch.test`, password: crypto.randomUUID(), name: "Batch fixture" })).id;
});
afterAll(async () => {
  await db.query(`DELETE FROM audit_log WHERE entity_id = ANY($1::text[])`, [leads]);
  await db.query(`DELETE FROM prospect_assessment_overrides WHERE prospect_id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM prospect_assessments WHERE prospect_id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM suppressions WHERE id = ANY($1::uuid[])`, [suppressionIds]);
  await db.query(`DELETE FROM messages WHERE prospect_id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM conversations WHERE prospect_id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM prospect_emails WHERE prospect_id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM prospects WHERE id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await closeDb();
});

describe("batched recipient policy matches the single-lead reader", () => {
  it("agrees across plain, do-not-contact, archived, suppressed and preferred-recipient leads", async () => {
    const plain = await makeLead();
    const dnc = await makeLead({ doNotContact: true });
    const archived = await makeLead({ archived: true });
    const suppressed = await makeLead();
    await suppress(suppressed.email, "manual", suppressed.id);
    const withAlt = await makeLead({ secondLocal: `alt-${crypto.randomUUID()}` });

    const ids = [plain.id, dnc.id, archived.id, suppressed.id, withAlt.id];
    const batch = await getRecipientPoliciesBatch(ids, db);
    for (const id of ids) {
      expect(batch.get(id)).toEqual(await getRecipientPolicy(id, db));
    }
  });

  it("agrees when an offer-rejection hold blocks a shared address across two leads", async () => {
    // Founder rule (strict deduplication, migration 034): a role mailbox on one business domain can
    // no longer repeat across two different leads; the database refuses it for review.
    const corporate = `info@shared-${crypto.randomUUID()}.batch.test`;
    await makeLead({ email: corporate });
    await expect(makeLead({ email: corporate })).rejects.toMatchObject({ code: "23505", constraint: "growth_identity_conflict" });
    // A role mailbox on a free-mail host is the shared address that can still repeat across leads.
    const shared = "info@gmx.net";
    const held = await makeLead({ email: shared, doNotContact: true });
    await db.query(
      `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'system', NULL, 'lead.rejection_hold_set', 'prospect', $2, $3::jsonb)`,
      [crypto.randomUUID(), held.id, JSON.stringify({ blockedNormalizedEmail: shared })],
    );
    const other = await makeLead({ email: shared });
    const unrelated = await makeLead();
    const ids = [held.id, other.id, unrelated.id];
    const batch = await getRecipientPoliciesBatch(ids, db);
    for (const id of ids) expect(batch.get(id)).toEqual(await getRecipientPolicy(id, db));
    expect(batch.get(other.id)?.blocked).toBe(true);
  });

  it("agrees on an empty id list and on an id with no rows", async () => {
    expect(await getRecipientPoliciesBatch([], db)).toEqual(new Map());
    expect((await getRecipientPoliciesBatch([crypto.randomUUID()], db)).size).toBe(0);
    // Deliberate difference from the single-lead reader, which throws 404 for an unknown id:
    // a list scan must not abort every OTHER lead's result because one id was deleted mid-scan.
    // A missing id is left out of the map, so the caller falls through to "not eligible" —
    // strictly safer than the alternative on a send path.
    await expect(getRecipientPolicy(crypto.randomUUID(), db)).rejects.toMatchObject({ status: 404 });
  });
});

describe("batched outreach block matches the single-lead reader", () => {
  it("agrees for category_b, excluded and unqualified-eligible assessments", async () => {
    const categoryB = await makeLead();
    await assess(categoryB.id, { tier: "category_b", eligibility: "eligible" });
    const excluded = await makeLead();
    await assess(excluded.id, { tier: "excluded", eligibility: "excluded", exclusionReason: "test exclusion" });
    const unqualified = await makeLead();
    await assess(unqualified.id, { tier: null, eligibility: "unknown" });
    const unassessed = await makeLead();
    const ids = [categoryB.id, excluded.id, unqualified.id, unassessed.id];
    const batch = await getLeadOutreachBlocksBatch(ids, db);
    for (const id of ids) expect(batch.get(id) ?? null).toEqual(await getLeadOutreachBlock(id, db));
    expect(batch.get(categoryB.id)?.code).toBe("alternative_contact_only");
    expect(batch.get(excluded.id)?.code).toBe("excluded_lead");
    expect(batch.get(unqualified.id)?.code).toBe("unqualified_lead");
    expect(batch.get(unassessed.id) ?? null).toBeNull();
  });

  it("agrees when a founder override clears an excluded tier back to the assessment's own value", async () => {
    const lead = await makeLead();
    await assess(lead.id, { tier: "tier_1", eligibility: "eligible" });
    await override(lead.id, "tier", "set", "excluded");
    await override(lead.id, "tier", "clear", undefined);
    const batch = await getLeadOutreachBlocksBatch([lead.id], db);
    expect(batch.get(lead.id) ?? null).toEqual(await getLeadOutreachBlock(lead.id, db));
    expect(batch.get(lead.id) ?? null).toBeNull();
  });

  it("agrees when an eligibility override or a still-in-force tier override drives the block", async () => {
    const eligibilityExcluded = await makeLead();
    await assess(eligibilityExcluded.id, { tier: "tier_1", eligibility: "eligible" });
    await override(eligibilityExcluded.id, "eligibility", "set", "excluded");

    const tierExcluded = await makeLead();
    await assess(tierExcluded.id, { tier: "tier_1", eligibility: "eligible" });
    await override(tierExcluded.id, "tier", "set", "excluded");

    const ids = [eligibilityExcluded.id, tierExcluded.id];
    const batch = await getLeadOutreachBlocksBatch(ids, db);
    for (const id of ids) expect(batch.get(id) ?? null).toEqual(await getLeadOutreachBlock(id, db));
    expect(batch.get(eligibilityExcluded.id)?.code).toBe("excluded_lead");
    expect(batch.get(tierExcluded.id)?.code).toBe("excluded_lead");
  });

  it("agrees when an override exists on a lead with no assessment row at all", async () => {
    const noAssessment = await makeLead();
    await override(noAssessment.id, "tier", "set", "category_b");
    const plain = await makeLead();
    const ids = [noAssessment.id, plain.id];
    const batch = await getLeadOutreachBlocksBatch(ids, db);
    for (const id of ids) expect(batch.get(id) ?? null).toEqual(await getLeadOutreachBlock(id, db));
    expect(batch.get(noAssessment.id)?.code).toBe("alternative_contact_only");
    expect(batch.get(plain.id) ?? null).toBeNull();
  });

  it("agrees when assessments or overrides tie on their ordering timestamps", async () => {
    const tiedAssessments = await makeLead();
    const assessedAt = "2026-02-01T00:00:00.000Z";
    // Identical assessed_at AND created_at: only the id tie-breaker can order these, and the two
    // implementations must break the tie the same way or they would return different tiers.
    for (const tier of ["tier_1", "category_b"]) {
      await db.query(
        `INSERT INTO prospect_assessments
           (id, prospect_id, rules_version, assessed_at, created_at, source_kind, eligibility, tier, provenance_key)
         VALUES ($1, $2, 'test', $3, $3, 'founder', 'eligible', $4, $5)`,
        [crypto.randomUUID(), tiedAssessments.id, assessedAt, tier, `assess:${crypto.randomUUID()}`],
      );
    }

    const tiedOverrides = await makeLead();
    await assess(tiedOverrides.id, { tier: "tier_1", eligibility: "eligible" });
    const decidedAt = "2026-03-01T00:00:00.000Z";
    for (const value of ["excluded", "tier_1"]) {
      await db.query(
        `INSERT INTO prospect_assessment_overrides
           (id, prospect_id, field_name, decision, value, reason, decided_by, decided_at, provenance_key)
         VALUES ($1, $2, 'tier', 'set', $3::jsonb, 'timestamp tie', $4, $5, $6)`,
        [crypto.randomUUID(), tiedOverrides.id, JSON.stringify(value), userId, decidedAt, `override:${crypto.randomUUID()}`],
      );
    }

    const ids = [tiedAssessments.id, tiedOverrides.id];
    const batch = await getLeadOutreachBlocksBatch(ids, db);
    for (const id of ids) expect(batch.get(id) ?? null).toEqual(await getLeadOutreachBlock(id, db));
  });
});

describe("follow-up candidate scan no longer scales per row", () => {
  it("issues roughly the same query count for five due leads as for one", async () => {
    const settings = {
      followUpMax: 2, followUpDailyLimit: 999, followUpDelay1Days: 0, followUpDelay2Days: 7,
      followUpAutoEnabled: false, timezone: "UTC",
    };
    const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
    async function dueLead() {
      const lead = await makeLead();
      await db.query(`UPDATE conversations SET last_outbound_at = $1 WHERE prospect_id = $2`, [daysAgo(20), lead.id]);
      await db.query(`UPDATE messages SET sent_at = $1 WHERE prospect_id = $2`, [daysAgo(20), lead.id]);
      return lead;
    }
    const first = await dueLead();
    let count1 = 0;
    const orig1 = db.query.bind(db);
    (db as any).query = (...args: unknown[]) => { count1++; return orig1(...(args as [string, unknown[]?])); };
    await readFollowUpCandidates(db, settings);
    (db as any).query = orig1;

    const rest = await Promise.all([dueLead(), dueLead(), dueLead(), dueLead()]);
    void rest;
    let count5 = 0;
    const orig2 = db.query.bind(db);
    (db as any).query = (...args: unknown[]) => { count5++; return orig2(...(args as [string, unknown[]?])); };
    const candidates = await readFollowUpCandidates(db, settings);
    (db as any).query = orig2;

    expect(candidates.some((c) => c.prospectId === first.id)).toBe(true);
    expect(candidates.length).toBeGreaterThanOrEqual(5);
    // Fixed-query-count batching: 5x the leads must not come close to 5x the queries.
    expect(count5).toBeLessThan(count1 + 5);
  });
});
