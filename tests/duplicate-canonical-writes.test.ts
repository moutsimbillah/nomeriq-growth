import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { closeDb, getDb, type DbClient } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import {
  checkDuplicate,
  recordFounderEnteredEmail,
  saveProspect,
  updateProspect,
  type SaveProspectInput,
} from "@/lib/services/prospects";
import { markProspectDuplicate } from "@/lib/services/prospect-duplicates";
import { approveDraft, saveDraft } from "@/lib/services/drafts";
import { decideMessageLink } from "@/lib/services/message-linking";
import { scanProspectDuplicates } from "@/lib/services/duplicate-audit";

/**
 * Reviewer blocker: a founder-linked duplicate must not block the canonical (kept) lead's new
 * distinct addresses or identity edits, while unrelated leads and every new save stay blocked.
 * Also pins the free-mail host additions. Synthetic rows only; nothing is sent or merged.
 */

const KEY = crypto.randomUUID().slice(0, 8);
const DOMAIN = `canon-${KEY}.test`;
const MIGRATION = "src/db/migrations/034_strict_prospect_identity.sql";
const prospectIds: string[] = [];
const messageIds: string[] = [];
const userIds: string[] = [];
let founder = { id: "", role: "founder" as const };
let canonical = { id: "", name: "" };
let duplicate = { id: "", name: "" };
let unrelated = { id: "", name: "" };

async function seed(extra: Partial<SaveProspectInput> & { businessName: string }) {
  const result = await saveProspect({ categories: ["forex"], qualificationStatus: "candidate", actorType: "seed", ...extra });
  if (result.created) prospectIds.push(result.prospect.id);
  return result;
}

async function emailOwners(address: string): Promise<string[]> {
  const db = await getDb();
  return (await db.query<{ prospect_id: string }>(
    "SELECT prospect_id::text AS prospect_id FROM prospect_emails WHERE normalized_email=$1 ORDER BY prospect_id", [address],
  )).rows.map((row) => row.prospect_id);
}

async function newDraft(prospectId: string, recipient: string, sequence: number): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email, created_by_type)
     VALUES ($1, $2, 'follow_up', $3, 'draft', 'Synthetic subject', 'Synthetic body long enough for the editor.', $4, 'seed')`,
    [id, prospectId, sequence, recipient],
  );
  return id;
}

async function inbound(from: string): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  messageIds.push(id);
  await db.query(
    `INSERT INTO messages (id, direction, source, from_email, subject, body_text, received_at)
     VALUES ($1, 'inbound', 'imap', $2, 'Synthetic reply', 'Fixture message text', '2026-01-05')`,
    [id, from],
  );
  return id;
}

/** A read-only DbClient over an isolated PGlite, matching the strict-identity replay test. */
function pgliteClient(db: PGlite): DbClient {
  return {
    query: async <T>(sql: string, params: unknown[] = []) => {
      const result = await db.query<T>(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    exec: async () => { throw new Error("Audit must not execute DDL"); },
    transaction: async () => { throw new Error("Audit must not open a writer"); },
    close: async () => {},
  } as DbClient;
}

async function preIdentityDatabase(): Promise<PGlite> {
  const db = new PGlite();
  const files = (await fs.readdir("src/db/migrations")).filter((f) => f.endsWith(".sql") && f < "034").sort();
  for (const file of files) await db.exec(await fs.readFile(`src/db/migrations/${file}`, "utf8"));
  return db;
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  const db = await getDb();
  founder = { id: crypto.randomUUID(), role: "founder" };
  userIds.push(founder.id);
  await db.query(
    `INSERT INTO users (id, email, normalized_email, name, password_hash, role) VALUES ($1, $2, $2, 'Canonical writes', $3, 'founder')`,
    [founder.id, `canonical-${KEY}@users.test.invalid`, hashPassword(crypto.randomUUID())],
  );
  const c = await seed({ businessName: `Canon Keep ${KEY}`, websiteUrl: `https://${DOMAIN}` });
  const x = await seed({ businessName: `Canon Copy ${KEY}`, websiteUrl: `https://copy-${KEY}.test` });
  const u = await seed({ businessName: `Unrelated Lead ${KEY}`, websiteUrl: `https://unrelated-${KEY}.test` });
  expect([c.created, x.created, u.created]).toEqual([true, true, true]);
  canonical = { id: c.prospect.id, name: c.prospect.businessName };
  duplicate = { id: x.prospect.id, name: x.prospect.businessName };
  unrelated = { id: u.prospect.id, name: u.prospect.businessName };
  // Legacy state that predates the guards (raw SQL, triggers off): the duplicate already holds a
  // specific mailbox at the canonical lead's domain. No service can create this today.
  await db.transaction(async (tx) => {
    await tx.query("SET LOCAL session_replication_role = replica");
    await tx.query(
      `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type, is_primary)
       VALUES ($1, $2, $3, $3, $4, 'official_website', true)`,
      [crypto.randomUUID(), duplicate.id, `owner@${DOMAIN}`, `https://copy-${KEY}.test/contact`],
    );
  });
});

afterAll(async () => {
  const db = await getDb();
  await db.query("DELETE FROM audit_log WHERE entity_id = ANY($1::text[]) OR entity_id = ANY($2::text[])", [prospectIds, messageIds]);
  await db.query("DELETE FROM prospect_duplicate_links WHERE prospect_id = ANY($1::uuid[]) OR canonical_prospect_id = ANY($1::uuid[])", [prospectIds]);
  await db.query("DELETE FROM messages WHERE id = ANY($1::uuid[])", [messageIds]);
  await db.query("DELETE FROM conversations WHERE prospect_id = ANY($1::uuid[])", [prospectIds]);
  await db.query("DELETE FROM outbound_sends WHERE prospect_id = ANY($1::uuid[])", [prospectIds]);
  await db.query("DELETE FROM drafts WHERE prospect_id = ANY($1::uuid[])", [prospectIds]);
  for (const table of ["prospect_emails", "prospect_aliases", "prospect_sources"]) {
    await db.query(`DELETE FROM ${table} WHERE prospect_id = ANY($1::uuid[])`, [prospectIds]);
  }
  await db.query("DELETE FROM prospects WHERE id = ANY($1::uuid[])", [prospectIds]);
  await db.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
  await closeDb();
});

describe("canonical lead after a founder duplicate link", () => {
  it("before the link, the duplicate's legacy mailbox blocks the other lead (the review hold is real)", async () => {
    await expect(recordFounderEnteredEmail(canonical.id, `support2@${DOMAIN}`))
      .rejects.toMatchObject({ status: 409, code: "duplicate_contact" });
    await expect(updateProspect(canonical.id, { businessName: `Canon Keep Renamed ${KEY}` }, founder.id))
      .rejects.toMatchObject({ status: 409, code: "duplicate" });
    expect(await emailOwners(`support2@${DOMAIN}`)).toEqual([]);
    const { link } = await markProspectDuplicate({ prospectId: duplicate.id, canonicalProspectId: canonical.id, actor: founder });
    expect(link).toMatchObject({ prospectId: duplicate.id, canonicalProspectId: canonical.id });
  });

  it("founder draft edit stores a NEW distinct inbox on the canonical lead; approval stores another", async () => {
    const edited = await newDraft(canonical.id, "nobody@example.invalid", 1);
    const saved = await saveDraft({
      id: edited, subject: "Following up", body: "A founder-written follow-up body that is long enough.",
      recipientEmail: `support2@${DOMAIN}`, actorType: "founder", actorUserId: founder.id,
    });
    expect(saved.recipientEmail).toBe(`support2@${DOMAIN}`);
    expect(await emailOwners(`support2@${DOMAIN}`)).toEqual([canonical.id]);

    const approving = await newDraft(canonical.id, `support3@${DOMAIN}`, 2);
    const approved = await approveDraft(approving, founder.id);
    expect(approved.status).toBe("approved");
    expect(await emailOwners(`support3@${DOMAIN}`)).toEqual([canonical.id]);
    // Nothing moved: the duplicate keeps its own legacy mailbox.
    expect(await emailOwners(`owner@${DOMAIN}`)).toEqual([duplicate.id]);
  });

  it("an unrelated lead typing an inbox at the canonical family's domain is still refused, with no association", async () => {
    const draft = await newDraft(unrelated.id, "nobody@example.invalid", 1);
    await expect(saveDraft({
      id: draft, subject: "Hello there", body: "A founder-written body for an unrelated lead here.",
      recipientEmail: `support9@${DOMAIN}`, actorType: "founder", actorUserId: founder.id,
    })).rejects.toMatchObject({ status: 409 });
    await expect(recordFounderEnteredEmail(unrelated.id, `support9@${DOMAIN}`))
      .rejects.toMatchObject({ status: 409, code: "duplicate_contact" });
    expect(await emailOwners(`support9@${DOMAIN}`)).toEqual([]);
    // Direct/import writes hit the same database guard.
    const db = await getDb();
    await expect(db.query(
      "INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url) VALUES ($1, $2, $3, $3, 'https://fixture.test/contact')",
      [crypto.randomUUID(), unrelated.id, `support8@${DOMAIN}`],
    )).rejects.toMatchObject({ code: "23505", constraint: "growth_identity_conflict" });
  });

  it("linking a real reply from a new inbox attaches it to the canonical lead; the unrelated lead is refused", async () => {
    const reply = await inbound(`support4@${DOMAIN}`);
    const linked = await decideMessageLink(reply, { action: "link", prospectId: canonical.id }, founder.id);
    expect(linked).toMatchObject({ action: "link", prospectId: canonical.id });
    expect(await emailOwners(`support4@${DOMAIN}`)).toEqual([canonical.id]);
    const db = await getDb();
    expect((await db.query<{ prospect_id: string }>("SELECT prospect_id::text AS prospect_id FROM messages WHERE id=$1", [reply])).rows[0].prospect_id)
      .toBe(canonical.id);

    const stray = await inbound(`support5@${DOMAIN}`);
    await expect(decideMessageLink(stray, { action: "link", prospectId: unrelated.id }, founder.id))
      .rejects.toMatchObject({ status: 409, code: "link_conflict" });
    expect(await emailOwners(`support5@${DOMAIN}`)).toEqual([]);
    expect((await db.query<{ prospect_id: string | null }>("SELECT prospect_id FROM messages WHERE id=$1", [stray])).rows[0].prospect_id).toBeNull();
  });

  it("the canonical lead's website/name edits succeed, including adopting the duplicate's name; unrelated edits are refused", async () => {
    const renamed = await updateProspect(canonical.id, {
      businessName: `Canon Keep Renamed ${KEY}`, websiteUrl: `https://www.${DOMAIN}/home`,
    }, founder.id);
    expect(renamed).toMatchObject({ businessName: `Canon Keep Renamed ${KEY}`, domainKey: DOMAIN });
    const adopted = await updateProspect(canonical.id, { businessName: duplicate.name }, founder.id);
    expect(adopted.businessName).toBe(duplicate.name);
    const db = await getDb();
    // The alias row stays with the duplicate (no row moves); the canonical simply carries the name.
    const aliasOwner = await db.query<{ prospect_id: string }>(
      "SELECT prospect_id::text AS prospect_id FROM prospect_aliases WHERE alias_key=(SELECT name_key FROM prospects WHERE id=$1)", [duplicate.id],
    );
    expect(aliasOwner.rows.map((row) => row.prospect_id)).toEqual([duplicate.id]);

    await expect(updateProspect(unrelated.id, { websiteUrl: `https://${DOMAIN}` }, founder.id))
      .rejects.toMatchObject({ status: 409, code: "duplicate" });
    await expect(updateProspect(unrelated.id, { businessName: duplicate.name }, founder.id))
      .rejects.toMatchObject({ status: 409, code: "duplicate" });
    expect((await db.query("SELECT domain_key, business_name FROM prospects WHERE id=$1", [unrelated.id])).rows[0])
      .toEqual({ domain_key: `unrelated-${KEY}.test`, business_name: unrelated.name });
  });

  it("every new save still rechecks every family and reports the canonical lead, never the archived copy", async () => {
    const domainHit = await seed({
      businessName: `New Brand ${KEY}`, websiteUrl: `https://new-brand-${KEY}.test`,
      email: `support7@${DOMAIN}`, emailSourceUrl: `https://new-brand-${KEY}.test/contact`,
    });
    expect(domainHit).toMatchObject({ created: false, duplicate: true, resolution: "review_required" });
    expect(domainHit.matches?.map((m) => m.prospectId)).toEqual([canonical.id]);

    // The duplicate's exact legacy mailbox resolves to the canonical family as well.
    const exactHit = await seed({
      businessName: `New Exact ${KEY}`, websiteUrl: `https://new-exact-${KEY}.test`,
      email: `owner@${DOMAIN}`, emailSourceUrl: `https://new-exact-${KEY}.test/contact`,
    });
    expect(exactHit.created).toBe(false);
    expect(exactHit.matches?.map((m) => m.prospectId)).toEqual([canonical.id]);
    expect(exactHit.matchedOn).toEqual(expect.arrayContaining(["contact email"]));

    // A payload cannot smuggle an exemption: the option is not part of the identity input.
    const smuggled = await seed({
      businessName: `New Smuggle ${KEY}`, websiteUrl: `https://${DOMAIN}/other`,
      ...({ ignoreTarget: canonical.id, ignore_target: canonical.id } as object),
    } as SaveProspectInput);
    expect(smuggled.created).toBe(false);
    expect(smuggled.matches?.map((m) => m.prospectId)).toEqual([canonical.id]);
    expect((await checkDuplicate({ emails: [`support6@${DOMAIN}`] })).map((m) => m.prospect.id)).toEqual([canonical.id]);
  });

  it("an exact existing non-role mailbox stays globally unique: the canonical cannot take the duplicate's address", async () => {
    await expect(recordFounderEnteredEmail(canonical.id, `owner@${DOMAIN}`))
      .rejects.toMatchObject({ status: 409, code: "duplicate_contact" });
    expect(await emailOwners(`owner@${DOMAIN}`)).toEqual([duplicate.id]);
  });

  it("the audit omits the founder-resolved pair", async () => {
    const pairs = await scanProspectDuplicates();
    const mine = pairs.filter((p) => [canonical.id, duplicate.id, unrelated.id].some((id) => id === p.prospectId || id === p.otherProspectId));
    expect(mine).toEqual([]);
  });

  it("the exemption is internal only: no agent/MCP surface mentions it", () => {
    for (const path of ["src/lib/agent/service.ts", "src/lib/agent/scopes.ts", "src/app/api/mcp/route.ts"]) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/ignoreTarget|ignore_target|growth_identity_owner/);
    }
  });
});

describe("migration replay and audit grouping on an isolated database", () => {
  it("replaces a stale 8-argument resolver additively, with explicit lookup and internal-write signatures", async () => {
    const db = await preIdentityDatabase();
    try {
      // A database that applied an earlier draft of 034 has an 8-argument resolver.
      await db.exec(`CREATE FUNCTION growth_find_identity_matches(text[],text[],text[],text[],text[],text[],text[],text[])
        RETURNS TABLE(prospect_id uuid, reasons text[]) LANGUAGE sql AS $$ SELECT NULL::uuid, NULL::text[] WHERE false $$`);
      const sql = await fs.readFile(MIGRATION, "utf8");
      await db.exec(sql);
      await db.exec(sql);
      const overloads = await db.query<{ args: string }>(
        "SELECT pg_get_function_identity_arguments(oid) AS args FROM pg_proc WHERE proname='growth_find_identity_matches'",
      );
      expect(overloads.rows).toHaveLength(2);
      expect(overloads.rows.filter(row => row.args.includes("ignore_target uuid"))).toHaveLength(1);
      expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE\b/i);
      const id = crypto.randomUUID();
      await db.query("INSERT INTO prospects (id,business_name,name_key,website_url,domain_key) VALUES ($1,'Replay','replay','https://replay.test','replay.test')", [id]);
      const eight = await db.query<{ prospect_id: string }>(
        "SELECT prospect_id FROM growth_find_identity_matches(ARRAY['replay.test'],ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[])",
      );
      expect(eight.rows).toEqual([{ prospect_id: id }]);
      expect((await db.query("SELECT tgname FROM pg_trigger WHERE tgname LIKE 'growth_prospect_%_guard'")).rows).toHaveLength(4);
    } finally { await db.close(); }
  });

  it("groups audit pairs by canonical family: the linked pair drops out, an unrelated collider is reported against the canonical", async () => {
    const db = await preIdentityDatabase();
    try {
      const c = crypto.randomUUID(), x = crypto.randomUUID(), u = crypto.randomUUID();
      await db.query(`INSERT INTO prospects (id,business_name,name_key,website_url,domain_key) VALUES
        ($1,'Family Keep','family keep','https://family.test','family.test'),
        ($2,'Family Copy','family copy','https://family-copy.test','family-copy.test'),
        ($3,'Other Brand','other brand','https://other-brand.test','other-brand.test')`, [c, x, u]);
      await db.query(`INSERT INTO prospect_emails (id,prospect_id,email,normalized_email,source_url) VALUES
        ($1,$2,'owner@family.test','owner@family.test','https://family-copy.test/contact'),
        ($3,$4,'support@family.test','support@family.test','https://other-brand.test/contact')`,
        [crypto.randomUUID(), x, crypto.randomUUID(), u]);
      const sql = await fs.readFile(MIGRATION, "utf8");
      await db.exec(sql);
      const client = pgliteClient(db);
      const pairKeys = (pairs: Awaited<ReturnType<typeof scanProspectDuplicates>>) =>
        pairs.map((p) => [p.prospectId, p.otherProspectId].sort().join("|")).sort();
      expect(pairKeys(await scanProspectDuplicates(client))).toEqual([[c, x], [c, u], [x, u]].map((p) => p.sort().join("|")).sort());
      await db.query("INSERT INTO prospect_duplicate_links (id,prospect_id,canonical_prospect_id,previous_state) VALUES ($1,$2,$3,'{}'::jsonb)",
        [crypto.randomUUID(), x, c]);
      const after = await scanProspectDuplicates(client);
      expect(pairKeys(after)).toEqual([[c, u].sort().join("|")]);
      expect(after[0].reasons).toEqual(["business email domain"]);
    } finally { await db.close(); }
  });
});

describe("free-mail providers are never a shared business domain", () => {
  const PROVIDERS = ["hotmail.co.uk", "live.co.uk", "outlook.fr", "yahoo.fr", "yahoo.co.in", "web.de", "mail.ru", "gmx.at", "rediffmail.com"];

  it("the single SQL source returns no business domain for each provider, but keeps corporate domains", async () => {
    const db = await getDb();
    for (const host of PROVIDERS) {
      const row = (await db.query<{ d: string | null }>("SELECT growth_business_email_domain($1) AS d", [`someone@${host}`])).rows[0];
      expect(row.d, host).toBeNull();
    }
    expect((await db.query<{ d: string }>("SELECT growth_business_email_domain($1) AS d", [`someone@corp-${KEY}.test`])).rows[0].d)
      .toBe(`corp-${KEY}.test`);
  });

  it("different inboxes at each provider save as separate leads; the exact mailbox and a corporate domain stay protected", async () => {
    for (const [index, host] of PROVIDERS.entries()) {
      const tag = `${KEY}-${index}`;
      const first = await seed({ businessName: `Freemail First ${tag}`, websiteUrl: `https://fm-first-${tag}.test`,
        email: `alice.${tag}@${host}`, emailSourceUrl: `https://fm-first-${tag}.test/contact` });
      const second = await seed({ businessName: `Freemail Second ${tag}`, websiteUrl: `https://fm-second-${tag}.test`,
        email: `bob.${tag}@${host}`, emailSourceUrl: `https://fm-second-${tag}.test/contact` });
      expect([first.created, second.created], host).toEqual([true, true]);
      const exact = await seed({ businessName: `Freemail Exact ${tag}`, websiteUrl: `https://fm-exact-${tag}.test`,
        email: `alice.${tag}@${host}`, emailSourceUrl: `https://fm-exact-${tag}.test/contact` });
      expect(exact, host).toMatchObject({ created: false, duplicate: true, matchedOn: ["contact email"] });
      expect(exact.matches?.map((m) => m.prospectId), host).toEqual([first.prospect.id]);
    }
    const corp = await seed({ businessName: `Corporate First ${KEY}`, websiteUrl: `https://corp-site-${KEY}.test`,
      email: `jane@corp-${KEY}.test`, emailSourceUrl: `https://corp-site-${KEY}.test/contact` });
    expect(corp.created).toBe(true);
    const sibling = await seed({ businessName: `Corporate Sibling ${KEY}`, websiteUrl: `https://corp-other-${KEY}.test`,
      email: `bob@corp-${KEY}.test`, emailSourceUrl: `https://corp-other-${KEY}.test/contact` });
    expect(sibling).toMatchObject({ created: false, resolution: "review_required", matchedOn: ["business email domain"] });
  });
});
