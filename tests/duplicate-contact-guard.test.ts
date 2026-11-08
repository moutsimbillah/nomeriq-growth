import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, type DbClient } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { createEmailAccount } from "@/lib/email/accounts";
import { sendDraft } from "@/lib/services/email-sending";
import { sendReply } from "@/lib/services/conversations";
import { markProspectDuplicate } from "@/lib/services/prospect-duplicates";
import { findDuplicateContactConflict } from "@/lib/services/duplicate-contact";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * Founder rule: a send must never contact a business another lead already owns or is already in
 * contact with — exact address (free-mail included) or the same business email domain/website
 * (free/shared mail excluded) — and two leads must not both pass while a first send is in flight.
 * The lead's own retries/follow-ups continue, a founder-linked duplicate never sends, and its
 * canonical lead stays usable. A refusal sends nothing and records no new address association.
 */
const transport = vi.hoisted(() => ({ to: [] as string[], gate: null as Promise<void> | null, entered: null as (() => void) | null }));
vi.mock("@/lib/email/send-provider", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/email/send-provider")>();
  return {
    ...original,
    deliverEmail: async (...args: Parameters<typeof original.deliverEmail>) => {
      transport.to.push(args[1].to);
      transport.entered?.();
      if (transport.gate) await transport.gate;
      return original.deliverEmail(...args);
    },
  };
});

let db: DbClient;
let userId = "";
const run = crypto.randomUUID().slice(0, 8);
const leads: string[] = [];
const accounts: string[] = [];
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
const dom = (tag: string) => `${tag.replaceAll("_","-")}-${run}.example`;

async function account() {
  const created = await createEmailAccount({ provider: "sandbox", emailAddress: `dupguard-${crypto.randomUUID()}@sender-${run}.example`,
    fromName: "Guard", name: "Guard", dailySendLimit: 500, minIntervalSeconds: 5 }, userId);
  accounts.push(created.id);
  return created.id;
}
async function lead(name: string, opts: { domain?: string; emails?: string[] } = {}) {
  const id = crypto.randomUUID(); leads.push(id);
  await db.query(`INSERT INTO prospects (id,business_name,name_key,website_url,domain_key,status,created_by_type)
    VALUES ($1,$2,$3,$4,$5,'verified','legacy')`,
    [id, name, `dupguard-${run}-${id}`, opts.domain ? `https://www.${opts.domain}/` : null, opts.domain ?? null]);
  for (const email of opts.emails ?? []) await storeEmail(id, email);
  return id;
}
async function storeEmail(prospectId: string, email: string) {
  await db.query(`INSERT INTO prospect_emails (id,prospect_id,email,normalized_email,source_url,source_type,is_primary)
    VALUES (gen_random_uuid(),$1,$2,$2,'https://source.example/contact','official_website',false)`, [prospectId, email]);
}
/** A pre-034 row: the future-write identity trigger did not exist when such overlaps were saved. */
async function legacyEmail(prospectId: string, email: string) {
  if (process.env.DATABASE_URL || !process.env.PGLITE_DIR?.startsWith(".data/test-vitest-")) throw new Error("Legacy fixture requires the isolated test database");
  await db.query(`ALTER TABLE prospect_emails DISABLE TRIGGER growth_prospect_email_guard`);
  try { await storeEmail(prospectId, email); }
  finally { await db.query(`ALTER TABLE prospect_emails ENABLE TRIGGER growth_prospect_email_guard`); }
}
async function history(prospectId: string, to: string) {
  const conversationId = crypto.randomUUID();
  await db.query(`INSERT INTO conversations (id,prospect_id,subject,last_outbound_at) VALUES ($1,$2,'Original',$3)`, [conversationId, prospectId, daysAgo(20)]);
  await db.query(`INSERT INTO messages (id,prospect_id,conversation_id,direction,source,from_email,to_emails,subject,body_text,sent_at,delivery_status)
    VALUES (gen_random_uuid(),$1,$2,'outbound','smtp','founder@nomeriq.example',$3::jsonb,'Original','Original',$4,'accepted')`,
    [prospectId, conversationId, JSON.stringify([to]), daysAgo(20)]);
}
async function draft(prospectId: string, recipient: string, kind = "first_contact", sequence = 0) {
  const id = crypto.randomUUID();
  await db.query(`INSERT INTO drafts (id,prospect_id,kind,sequence,status,subject,body,recipient_email,created_by_type,approved_at)
    VALUES ($1,$2,$3,$4,'approved','A question','Hello, a short question about your signals.',$5,'founder',now())`,
    [id, prospectId, kind, sequence, recipient]);
  return id;
}
async function code(fn: () => Promise<unknown>) {
  try { const out = await fn() as { status?: string; queued?: boolean }; return out.queued ? "queued" : out.status ?? "sent"; }
  catch (error) { return (error as { code?: string }).code ?? String(error); }
}
async function send(draftId: string, allowFounderRecipient = false) {
  return code(async () => sendDraft({ draftId, accountId: await account(), actorUserId: userId, allowFounderRecipient }));
}
async function sideEffects(draftId: string) {
  const sends = await db.query(`SELECT 1 FROM outbound_sends WHERE draft_id=$1`, [draftId]);
  const messages = await db.query(`SELECT 1 FROM messages WHERE draft_id=$1`, [draftId]);
  const tokens = await db.query(`SELECT 1 FROM unsubscribe_tokens t JOIN drafts d ON d.prospect_id=t.prospect_id
    AND t.normalized_email=lower(d.recipient_email) WHERE d.id=$1`, [draftId]);
  return { sends: sends.rows.length, messages: messages.rows.length, tokens: tokens.rows.length };
}
async function link(duplicateId: string, canonicalId: string) {
  await db.query(`INSERT INTO prospect_duplicate_links (id,prospect_id,canonical_prospect_id,previous_state,created_by_user_id)
    VALUES (gen_random_uuid(),$1,$2,'{}'::jsonb,$3)`, [duplicateId, canonicalId, userId]);
}
const none = { sends: 0, messages: 0, tokens: 0 };

beforeAll(async () => {
  db = await getDb(); await ensureWorkspaceDefaults();
  userId = crypto.randomUUID();
  await db.query(`INSERT INTO users (id,email,normalized_email,name,password_hash,role) VALUES ($1,$2,$2,'Dup guard',$3,'founder')`,
    [userId, `dupguard-${run}@test.example`, hashPassword(crypto.randomUUID())]);
});
afterEach(() => { transport.to.length = 0; transport.gate = null; transport.entered = null; vi.restoreAllMocks(); });
afterAll(async () => {
  await db.query(`DELETE FROM prospect_duplicate_links WHERE prospect_id=ANY($1::uuid[]) OR canonical_prospect_id=ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM audit_log WHERE metadata->>'prospectId'=ANY($1::text[]) OR entity_id=ANY($1::text[])`, [leads]);
  await db.query(`DELETE FROM outbound_sends WHERE prospect_id=ANY($1::uuid[]) OR account_id=ANY($2::uuid[])`, [leads, accounts]);
  await db.query(`DELETE FROM unsubscribe_tokens WHERE prospect_id=ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM messages WHERE prospect_id=ANY($1::uuid[]) OR conversation_id IN (SELECT id FROM conversations WHERE prospect_id=ANY($1::uuid[]))`, [leads]);
  await db.query(`DELETE FROM drafts WHERE prospect_id=ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM conversations WHERE prospect_id=ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM prospect_emails WHERE prospect_id=ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM suppressions WHERE prospect_id=ANY($1::uuid[])`, [leads]);
  await db.query(`UPDATE prospects SET sending_account_id=null WHERE id=ANY($1::uuid[])`, [leads]).catch(() => undefined);
  await db.query(`DELETE FROM prospects WHERE id=ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM email_accounts WHERE id=ANY($1::uuid[])`, [accounts]);
  await db.query(`DELETE FROM users WHERE id=$1`, [userId]);
  await closeDb();
});

describe("send-time cross-lead duplicate-contact guard", () => {
  it.each([
    ["www", true], ["trailing-dot", true], ["inbound", true], ["conversation-owner", true],
    ["lookalike", false], ["subdomain", false], ["local-part", false], ["failed", false], ["non-array", false],
  ])("history prefilter preserves the shared resolver's %s decision", async (mode, held) => {
    const domain = dom(`prefilter-${mode}`);
    const target = await lead(`Prefilter target ${mode}`, { domain });
    const other = await lead(`Prefilter other ${mode}`);
    let address = `owner@${domain}`;
    if (mode === "www") address = ` OWNER@WWW.${domain.toUpperCase()} `;
    if (mode === "trailing-dot") address += ".";
    if (mode === "lookalike") address += ".evil.test";
    if (mode === "subdomain") address = `owner@sub.${domain}`;
    if (mode === "local-part") address = `${domain}@unrelated.test`;
    const conversation = crypto.randomUUID();
    await db.query("INSERT INTO conversations(id,prospect_id,subject) VALUES($1,$2,'Prefilter synthetic history')", [conversation, other]);
    await db.query(`INSERT INTO messages(id,prospect_id,conversation_id,direction,source,from_email,to_emails,sent_at,delivery_status)
      VALUES(gen_random_uuid(),$1,$2,$3,'smtp',$4,$5::jsonb,now(),$6)`, [
      mode === "conversation-owner" ? null : other, conversation, mode === "inbound" ? "inbound" : "outbound",
      mode === "inbound" ? address : "founder@prefilter-sender.test",
      JSON.stringify(mode === "non-array" ? { invalid: address } : [address, "unrelated@elsewhere.test"]),
      mode === "failed" ? "failed" : "accepted",
    ]);
    const result = await findDuplicateContactConflict({ prospectId: target, recipient: `info@${domain}` }, db);
    if (held) expect(result).toMatchObject({ kind: "contact_history", prospectId: other });
    else expect(result).toBeNull();
  });

  it("GoldSignals/FXPremiere: a recorded email domain on one lead matching another lead's website holds BOTH sends, different inboxes included", async () => {
    const fx = dom("fxpremiere");
    const fxLead = await lead("FXPremiere", { domain: fx, emails: [`info@${fx}`] });
    const gold = await lead("GoldSignals.co", { domain: dom("goldsignals") });
    await legacyEmail(gold, `support@${fx}`);
    const goldDraft = await draft(gold, `support@${fx}`);
    const fxDraft = await draft(fxLead, `info@${fx}`);
    expect(await send(goldDraft)).toBe("duplicate_contact");
    expect(await send(fxDraft)).toBe("duplicate_contact");
    expect(await sideEffects(goldDraft)).toEqual(none);
    expect(await sideEffects(fxDraft)).toEqual(none);
    expect(transport.to).toEqual([]);
  });

  it("linked history prevents a second first-contact, but canonical follow-ups work; an unrelated contacted owner still holds A", async () => {
    const d = dom("canonical");
    const a = await lead("Canonical A", { domain: d, emails: [`hello@${d}`] });
    const b = await lead("Duplicate B");
    await legacyEmail(b, `owner@${d}`);
    await history(b, `owner@${d}`);
    const aDraft = await draft(a, `hello@${d}`);
    const bDraft = await draft(b, `owner@${d}`, "follow_up", 1);
    expect(await send(aDraft)).toBe("duplicate_contact");
    await link(b, a);
    expect(await send(bDraft)).toBe("duplicate_contact");
    expect((await findDuplicateContactConflict({ prospectId: b, recipient: `owner@${d}` }, db))?.kind).toBe("duplicate_link");
    expect(await send(aDraft)).toBe("already_contacted");
    await history(a,`hello@${d}`);
    expect(await send(await draft(a,`hello@${d}`,"follow_up",1))).toBe("sandbox");
    expect(transport.to).toEqual([`hello@${d}`]);
    // No history was moved or merged: B's message still belongs to B.
    expect((await db.query(`SELECT 1 FROM messages WHERE prospect_id=$1`, [b])).rows).toHaveLength(1);
    const unrelated = await lead("Unrelated owner");
    await history(unrelated, `ceo@${d}`);
    const aFollowUp = await draft(a, `hello@${d}`, "follow_up", 2);
    const before = await sideEffects(aFollowUp); // A's earlier follow-up already minted one token.
    expect(await send(aFollowUp)).toBe("duplicate_contact");
    expect(await sideEffects(aFollowUp)).toEqual({ ...none, tokens: before.tokens });
    expect(await sideEffects(bDraft)).toEqual(none);
  });

  it("a linked duplicate's history counts as the canonical lead's own, so an uncontacted identity owner does not hold the canonical", async () => {
    const d = dom("inherit");
    const a = await lead("Canonical inherit A", { domain: d, emails: [`a@${d}`] });
    const b = await lead("Duplicate inherit B");
    await legacyEmail(b, `b@${d}`);
    await history(b, `b@${d}`);
    const c = await lead("Uncontacted inherit C");
    await legacyEmail(c, `c@${d}`);
    await link(b, a);
    expect(await findDuplicateContactConflict({prospectId:a,recipient:`a@${d}`},db)).toBeNull();
    expect(await send(await draft(a, `a@${d}`))).toBe("already_contacted");
    await history(a,`a@${d}`);
    expect(await send(await draft(a, `a@${d}`,"follow_up",1))).toBe("sandbox");
    const cDraft = await draft(c, `c@${d}`);
    expect(await send(cDraft)).toBe("duplicate_contact");
    expect(await sideEffects(cDraft)).toEqual(none);
    expect(transport.to).toEqual([`a@${d}`]);
  });

  it("a typed recipient at another lead's contacted business domain is refused before any address is recorded", async () => {
    const d = dom("typed");
    const owner = await lead("Owner", { domain: dom("owner-site") });
    await history(owner, `owner@${d}`);
    const other = await lead("Other", { domain: dom("other-site") });
    const typed = await draft(other, `sales-team@${d}`);
    expect(await send(typed, true)).toBe("duplicate_contact");
    expect((await db.query(`SELECT 1 FROM prospect_emails WHERE prospect_id=$1`, [other])).rows).toHaveLength(0);
    expect(await sideEffects(typed)).toEqual(none);
    expect(transport.to).toEqual([]);
  });

  it("free-mail: the exact address on another lead is refused, a different inbox at the same free provider is not domain-held", async () => {
    const owner = await lead("Free owner");
    await history(owner, `jane.${run}@gmail.com`);
    const other = await lead("Free other");
    const typed = await draft(other, `Jane.${run}@Gmail.com`);
    expect(await send(typed, true)).toBe("duplicate_contact");
    expect((await db.query(`SELECT 1 FROM prospect_emails WHERE prospect_id=$1`, [other])).rows).toHaveLength(0);
    expect(await sideEffects(typed)).toEqual(none);
    await db.query(`UPDATE drafts SET recipient_email=$1 WHERE id=$2`, [`otherperson.${run}@gmail.com`, typed]);
    expect(await send(typed, true)).toBe("sandbox");
    expect(transport.to).toEqual([`otherperson.${run}@gmail.com`]);
  });

  it("the contacted lead's own follow-up and same-draft retry continue; another uncontacted lead on that domain is held", async () => {
    const d = dom("owner-follow");
    const a = await lead("Contacted A", { domain: d, emails: [`owner@${d}`] });
    await history(a, `owner@${d}`);
    const other = await lead("Uncontacted D");
    await legacyEmail(other, `info@${d}`);
    const followUp = await draft(a, `owner@${d}`, "follow_up", 1);
    // A definitive SMTP refusal earlier: the same draft retries on its own ledger row.
    await db.query(`INSERT INTO outbound_sends (id,draft_id,prospect_id,idempotency_key,status,error,completed_at)
      VALUES (gen_random_uuid(),$1,$2,$3,'failed','550 earlier refusal',now())`, [followUp, a, `dupguard-${crypto.randomUUID()}`]);
    expect(await send(followUp)).toBe("sandbox");
    const held = await draft(other, `info@${d}`);
    expect(await send(held)).toBe("duplicate_contact");
    expect(await sideEffects(held)).toEqual(none);
    expect(transport.to).toEqual([`owner@${d}`]);
  });

  it("while the first lead's send is in flight, a second lead at the same business domain is refused", async () => {
    const d = dom("inflight");
    const a = await lead("In flight A", { domain: dom("inflight-a") });
    const b = await lead("Second B", { domain: dom("inflight-b") });
    const aDraft = await draft(a, `alpha@${d}`);
    const bDraft = await draft(b, `beta@${d}`);
    let release!: () => void;
    transport.gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>(resolve => { transport.entered = resolve; });
    const first = send(aDraft, true);
    await entered;
    expect(transport.to).toEqual([`alpha@${d}`]);
    expect((await db.query<{ status: string }>(`SELECT status FROM outbound_sends WHERE draft_id=$1`, [aDraft])).rows[0]?.status).toBe("sending");
    expect((await findDuplicateContactConflict({ prospectId: b, recipient: `beta@${d}`, draftId: bDraft }, db))?.kind).toBe("contact_history");
    expect(await send(bDraft, true)).toBe("duplicate_contact");
    release();
    expect(await first).toBe("sandbox");
    expect(await sideEffects(bDraft)).toEqual(none);
    expect((await db.query(`SELECT 1 FROM prospect_emails WHERE prospect_id=$1`, [b])).rows).toHaveLength(0);
    expect(transport.to).toEqual([`alpha@${d}`]);
  });

  it("a reservation landing after the unlocked pre-check is caught by the locked re-check before the row is written", async () => {
    const d = dom("race");
    const a = await lead("Racer A", { domain: dom("race-a") });
    const b = await lead("Racer B", { domain: dom("race-b") });
    const aDraft = await draft(a, `first@${d}`);
    const bDraft = await draft(b, `second@${d}`);
    const original = db.transaction.bind(db);
    let injected = false;
    vi.spyOn(db, "transaction").mockImplementation(async (fn) => original(async (tx) => fn({
      ...tx,
      transaction: tx.transaction,
      query: async (text: string, params?: unknown[]) => {
        const result = await tx.query(text, params);
        if (!injected && /LOCK TABLE outbound_sends/.test(text)) {
          // Another lead's send committed its reservation between B's pre-check and B's lock.
          injected = true;
          await tx.query(`INSERT INTO outbound_sends (id,draft_id,account_id,prospect_id,idempotency_key,status)
            VALUES (gen_random_uuid(),$1,null,$2,$3,'sending')`, [aDraft, a, `dupguard-${crypto.randomUUID()}`]);
        }
        return result;
      },
    } as DbClient)) as never);
    expect(await send(bDraft, true)).toBe("duplicate_contact");
    expect(injected).toBe(true);
    expect(await sideEffects(bDraft)).toEqual(none);
    expect((await db.query(`SELECT 1 FROM prospect_emails WHERE prospect_id=$1`, [b])).rows).toHaveLength(0);
    expect(transport.to).toEqual([]);
  });

  async function replyFixture(tag: string) {
    const domain = dom(tag);
    const email = `owner@${domain}`;
    const id = await lead(`Reply ${tag}`, { domain, emails:[email] });
    await history(id,email);
    const conversationId = String((await db.query<{id:string}>("SELECT id FROM conversations WHERE prospect_id=$1",[id])).rows[0].id);
    await db.query(`INSERT INTO messages(id,prospect_id,conversation_id,direction,source,from_email,to_emails,subject,body_text,received_at,message_id)
      VALUES(gen_random_uuid(),$1,$2,'inbound','imap',$3,'["founder@nomeriq.example"]','Reply','Please tell me more.',now(),$4)`,[id,conversationId,email,`<${crypto.randomUUID()}@${domain}>`]);
    return {id,conversationId,email};
  }

  it.each(["previous_do_not_contact","manual_suppression","unsubscribe"])("duplicate marking preserves %s across the canonical business",async restriction=>{
    const a=await lead(`Canonical hold ${restriction}`,{domain:dom(`hold-a-${restriction}`),emails:[`hello@${dom(`hold-a-${restriction}`)}`]});
    const b=await lead(`Duplicate hold ${restriction}`,{domain:dom(`hold-b-${restriction}`),emails:[`support@${dom(`hold-b-${restriction}`)}`]});
    if(restriction==="previous_do_not_contact")await db.query("UPDATE prospects SET do_not_contact=true WHERE id=$1",[b]);
    if(restriction==="manual_suppression")await db.query(`INSERT INTO suppressions(id,prospect_id,email,normalized_email,reason,source)
      VALUES(gen_random_uuid(),$1,$2,$2,'manual','founder')`,[b,`support@${dom(`hold-b-${restriction}`)}`]);
    if(restriction==="unsubscribe"){
      await history(b,`support@${dom(`hold-b-${restriction}`)}`);
      await db.query("UPDATE conversations SET classification='unsubscribe' WHERE prospect_id=$1",[b]);
    }
    await markProspectDuplicate({prospectId:b,canonicalProspectId:a,actor:{id:userId,role:"founder"}});
    const email=`hello@${dom(`hold-a-${restriction}`)}`;
    expect((await findDuplicateContactConflict({prospectId:a,recipient:email},db))?.kind).toBe("linked_hold");
    const id=await draft(a,email);
    expect(await send(id)).toBe("duplicate_contact");
    expect(await sideEffects(id)).toEqual(none);expect(transport.to).toEqual([]);
  });

  it("reply sends use the same duplicate guard before a reservation or unsubscribe token is created", async () => {
    const reply = await replyFixture("reply-held");
    const other = await lead("Other contacted reply owner");
    await history(other,`sales@${dom("reply-held")}`);
    const accountId = await account();
    const before = (await db.query(`SELECT (SELECT count(*) FROM outbound_sends WHERE prospect_id=$1) sends,
      (SELECT count(*) FROM messages WHERE prospect_id=$1) messages,(SELECT count(*) FROM unsubscribe_tokens WHERE prospect_id=$1) tokens`,[reply.id])).rows;
    await expect(sendReply({conversationId:reply.conversationId,subject:"Re: Reply",body:"Here is a short answer.",accountId,actorUserId:userId,idempotencyKey:crypto.randomUUID()})).rejects.toMatchObject({code:"duplicate_contact"});
    expect((await db.query(`SELECT (SELECT count(*) FROM outbound_sends WHERE prospect_id=$1) sends,
      (SELECT count(*) FROM messages WHERE prospect_id=$1) messages,(SELECT count(*) FROM unsubscribe_tokens WHERE prospect_id=$1) tokens`,[reply.id])).rows).toEqual(before);
    expect(transport.to).toEqual([]);
  });

  it("a legitimate reply remains usable and its in-flight reservation prevents duplicate marking", async () => {
    const reply = await replyFixture("reply-own");
    const canonical = await lead("Canonical for reply race", {domain:dom("reply-canonical")});
    const accountId = await account();
    const input = {conversationId:reply.conversationId,subject:"Re: Reply",body:"Here is the answer you requested.",accountId,actorUserId:userId,idempotencyKey:crypto.randomUUID()};
    let release!:()=>void;
    transport.gate = new Promise<void>(resolve=>{release=resolve;});
    const entered = new Promise<void>(resolve=>{transport.entered=resolve;});
    const first = sendReply(input);
    await entered;
    try {
      await expect(markProspectDuplicate({prospectId:reply.id,canonicalProspectId:canonical,actor:{id:userId,role:"founder"}})).rejects.toMatchObject({code:"send_in_progress"});
      expect((await db.query("SELECT archived_at FROM prospects WHERE id=$1",[reply.id])).rows[0].archived_at).toBeNull();
    } finally { release(); }
    expect(await first).toMatchObject({status:"sandbox"});
    expect(await sendReply(input)).toMatchObject({alreadySent:true,status:"sandbox"});
    expect(transport.to).toEqual([reply.email]);
  });
});
