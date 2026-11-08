import { afterAll, beforeAll, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { closeDb, getDb, type DbClient } from "@/lib/db/client";
import { scanProspectDuplicates } from "@/lib/services/duplicate-audit";
import { checkDuplicate, saveProspect, type SaveProspectInput } from "@/lib/services/prospects";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

const ids: string[] = [];
const migration = "src/db/migrations/034_strict_prospect_identity.sql";
beforeAll(ensureWorkspaceDefaults);
afterAll(async () => {
  vi.restoreAllMocks();
  const db = await getDb();
  for (const table of ["prospect_emails", "prospect_sources", "prospect_aliases"]) await db.query(`DELETE FROM ${table} WHERE prospect_id=ANY($1::uuid[])`, [ids]);
  await db.query("DELETE FROM prospects WHERE id=ANY($1::uuid[])", [ids]);
  await closeDb();
});
function candidate(extra: Partial<SaveProspectInput> = {}): SaveProspectInput {
  return { businessName: `Strict ${crypto.randomUUID()}`, categories: ["forex"], qualificationStatus: "candidate", actorType: "seed", ...extra };
}
async function seed(extra: Partial<SaveProspectInput> = {}) {
  const result = await saveProspect(candidate(extra));
  if (result.created) ids.push(result.prospect.id);
  return result;
}

it("catches a sub-brand's support email against the parent's website without a precheck or auto-merge", async () => {
  const key = crypto.randomUUID();
  const parent = await seed({ websiteUrl: `https://parent-${key}.test`, email: `info@parent-${key}.test`, emailSourceUrl: `https://parent-${key}.test/contact` });
  const before = await getDb().then(db => db.query("SELECT * FROM prospects WHERE id=$1", [parent.prospect.id]));
  const sub = await seed({ websiteUrl: `https://brand-${key}.test`, email: `support@parent-${key}.test`, emailSourceUrl: `https://brand-${key}.test/contact` });
  expect(sub).toMatchObject({ created: false, duplicate: true, resolution: "review_required", matchedOn: ["business email domain"] });
  expect(sub.matches?.map(m => m.prospectId)).toEqual([parent.prospect.id]);
  const db = await getDb();
  expect((await db.query("SELECT * FROM prospects WHERE id=$1", [parent.prospect.id])).rows).toEqual(before.rows);
  expect((await db.query("SELECT id FROM prospects WHERE domain_key=$1", [`brand-${key}.test`])).rows).toHaveLength(0);
});

it("catches the reverse ordering and different inboxes on the same business email domain", async () => {
  const key = crypto.randomUUID();
  const brand = await seed({ websiteUrl: `https://brand-${key}.test`, email: `support@parent-${key}.test`, emailSourceUrl: `https://brand-${key}.test/contact` });
  expect((await seed({ websiteUrl: `https://parent-${key}.test` })).prospect.id).toBe(brand.prospect.id);
  expect((await seed({ email: `hello@parent-${key}.test`, emailSourceUrl: `https://parent-${key}.test/contact` })).resolution).toBe("review_required");
});

it("never guesses a parent company from a free mailbox, shared profile host or similar name", async () => {
  const key = crypto.randomUUID();
  const a = await seed({ businessName: `Different Alpha ${key}`, websiteUrl: `https://linktr.ee/alpha-${key}`, email: "info@gmail.com", emailSourceUrl: `https://linktr.ee/alpha-${key}` });
  const b = await seed({ businessName: `Different Beta ${key}`, websiteUrl: `https://linktr.ee/beta-${key}`, email: "support@gmail.com", emailSourceUrl: `https://linktr.ee/beta-${key}` });
  expect(a.created && b.created).toBe(true);
  expect((await checkDuplicate({ businessName: `Different Gamma ${key}`, emails: ["hello@gmail.com"] }))).toEqual([]);
  const db = await getDb();
  const domains = await db.query<{a: string; b: string; c: null; d: null}>(`SELECT growth_identity_domain('https://WWW.Example.co.uk./pricing') a,
    growth_identity_domain('example.com') b, growth_business_email_domain('support@outlook.com') c,
    growth_business_email_domain('support@youtube.com') d`);
  expect(domains.rows[0]).toEqual({ a: "example.co.uk", b: "example.com", c: null, d: null });
});

it("returns every conflicting owner with an explicit review result, never an arbitrary merge", async () => {
  const key = crypto.randomUUID();
  const a = await seed({ websiteUrl: `https://one-${key}.test` });
  const b = await seed({ instagramUrl: `https://instagram.com/other_${key}` });
  const result = await seed({ websiteUrl: `https://one-${key}.test`, instagramUrl: `https://instagram.com/other_${key}` });
  expect(result.resolution).toBe("review_required");
  expect(new Set(result.matches?.map(m => m.prospectId))).toEqual(new Set([a.prospect.id,b.prospect.id]));
});

it("does one lookup round trip independent of the number of input identity keys", async () => {
  const db = await getDb();
  const spy = vi.spyOn(db, "query");
  try {
    await checkDuplicate({ websiteUrl: "https://lookup-speed-unique.test", businessName: "Lookup speed unique", emails: ["support@lookup-speed-unique.test"], instagramUrl: "https://instagram.com/lookup_speed_unique", youtubeUrl: "https://youtube.com/@lookup_speed_unique", xUrl: "https://x.com/lookup_speed_unique", telegramUrl: "https://t.me/lookup_speed_unique" }, db);
    expect(spy).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
});

it("database guards refuse direct/import writes, including archived owners and email additions", async () => {
  const key = crypto.randomUUID();
  const owner = await seed({ websiteUrl: `https://owner-${key}.test` });
  const second = await seed({ websiteUrl: `https://second-${key}.test` });
  const db = await getDb();
  await db.query("UPDATE prospects SET archived_at=now() WHERE id=$1", [owner.prospect.id]);
  await expect(db.query("INSERT INTO prospect_emails (id,prospect_id,email,normalized_email,source_url) VALUES ($1,$2,$3,$3,$4)", [crypto.randomUUID(),second.prospect.id,`support@owner-${key}.test`,`https://second-${key}.test/contact`])).rejects.toMatchObject({ code: "23505" });
  await expect(db.query("UPDATE prospects SET domain_key=$2, website_url=$3 WHERE id=$1", [second.prospect.id,`owner-${key}.test`,`https://owner-${key}.test`])).rejects.toMatchObject({ code: "23505" });
  await expect(db.query("INSERT INTO prospects (id,business_name,name_key,domain_key) VALUES ($1,$2,$2,$3)", [crypto.randomUUID(),`Bypass ${key}`,`owner-${key}.test`])).rejects.toMatchObject({ code: "23505" });
  const third = await seed({websiteUrl:`https://third-${key}.test`});
  // The second row of a single INSERT must see the first row's newly claimed email domain.
  await expect(db.query(`INSERT INTO prospect_emails(id,prospect_id,email,normalized_email,source_url)
    VALUES($1,$2,$3,$3,'https://fixture.test/contact'),($4,$5,$6,$6,'https://fixture.test/contact')`,
    [crypto.randomUUID(),second.prospect.id,`info@bulk-${key}.test`,crypto.randomUUID(),third.prospect.id,`support@bulk-${key}.test`])).rejects.toMatchObject({code:"23505"});
  expect((await db.query("SELECT id FROM prospect_emails WHERE normalized_email=ANY($1::text[])",[[`info@bulk-${key}.test`,`support@bulk-${key}.test`]])).rows).toHaveLength(0);
});

it("replays the actual additive SQL twice on a pre-change database, preserving complete legacy rows", async () => {
  const db = new PGlite();
  try {
    const files = (await fs.readdir("src/db/migrations")).filter(f => f.endsWith(".sql") && f < "034").sort();
    for (const file of files) await db.exec(await fs.readFile(`src/db/migrations/${file}`, "utf8"));
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    await db.query("INSERT INTO prospects (id,business_name,name_key,website_url,domain_key,archived_at) VALUES ($1,'Legacy Parent','legacy parent','https://parent-legacy.test','parent-legacy.test',NULL),($2,'Legacy Brand','legacy brand','https://brand-legacy.test','brand-legacy.test','2026-01-02T03:04:05.123456Z')", [a,b]);
    await db.query("INSERT INTO prospect_emails (id,prospect_id,email,normalized_email,source_url) VALUES ($1,$2,'support@parent-legacy.test','support@parent-legacy.test','https://brand-legacy.test/contact')", [crypto.randomUUID(),b]);
    const snapshot = async () => (await db.query("SELECT row_to_json(p)::text AS snapshot FROM prospects p ORDER BY id")).rows;
    const emails = async () => (await db.query("SELECT row_to_json(e)::text AS snapshot FROM prospect_emails e ORDER BY id")).rows;
    const before = await snapshot(), beforeEmails = await emails();
    const sql = await fs.readFile(migration,"utf8");
    await db.exec(sql); await db.exec(sql);
    expect(await snapshot()).toEqual(before); expect(await emails()).toEqual(beforeEmails);
    expect((await db.query("SELECT tgname FROM pg_trigger WHERE tgname LIKE 'growth_prospect_%_guard'")).rows).toHaveLength(4);
    expect((await db.query("SELECT relrowsecurity FROM pg_class WHERE relname='prospect_duplicate_links'")).rows[0]).toEqual({relrowsecurity:true});
    // Read-only whole-population audit uses the same resolver, never a capped list.
    const client = {
      query: async <T>(sql: string, params: unknown[] = []) => {
        const result = await db.query<T>(sql,params);
        return { rows:result.rows, rowCount:result.affectedRows ?? result.rows.length };
      },
      exec: async () => { throw new Error("Audit must not execute DDL"); },
      transaction: async () => { throw new Error("Audit must not open a writer"); },
      close: async () => {},
    } as DbClient;
    await db.exec("BEGIN READ ONLY");
    try {
      const pairs = await scanProspectDuplicates(client);
      expect(pairs).toHaveLength(1);
      expect(new Set([pairs[0].prospectId,pairs[0].otherProspectId])).toEqual(new Set([a,b]));
      expect(pairs[0].reasons).toEqual(["business email domain"]);
    } finally { await db.exec("ROLLBACK"); }
    expect(await snapshot()).toEqual(before); expect(await emails()).toEqual(beforeEmails);
    // Legacy conflict does not prevent non-identity corrections/archiving.
    await db.query("UPDATE prospects SET do_not_contact=true WHERE id=$1",[b]);
  } finally { await db.close(); }
});
