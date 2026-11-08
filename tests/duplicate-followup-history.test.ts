import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, type DbClient } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { createEmailAccount } from "@/lib/email/accounts";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { sendDraft } from "@/lib/services/email-sending";
import { markProspectDuplicate, restoreProspectDuplicate } from "@/lib/services/prospect-duplicates";
import { readFollowUpCandidates, readFollowUpSettings, saveAgentFollowUpDrafts } from "@/lib/services/agent-followups";

/**
 * Founder rule: a lead actively linked as a duplicate of a canonical lead is the same business, so
 * its replies, opt-outs, holds and pipeline outcomes stop the canonical lead's follow-ups — in the
 * send gate and in automatic/agent candidate selection alike, for events recorded before and after
 * the mark. The mark's own archived_at/do_not_contact on the duplicate is not a restriction, and a
 * DSN/OOO/own-account inbound on the duplicate is not a reply (the real-reply predicate decides).
 */
const transport = vi.hoisted(() => ({ to: [] as string[] }));
vi.mock("@/lib/email/send-provider", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/email/send-provider")>();
  return {
    ...original,
    deliverEmail: async (...args: Parameters<typeof original.deliverEmail>) => {
      transport.to.push(args[1].to);
      return original.deliverEmail(...args);
    },
  };
});

let db: DbClient;
let userId = "";
const run = crypto.randomUUID().slice(0, 8);
const marker = `dupfup-${run}`;
const leads: string[] = [];
const accounts: string[] = [];
const suppressions: string[] = [];
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
let settings: Record<string, unknown>;
let dailyBaseline = 0;

async function account(emailAddress?: string) {
  const created = await createEmailAccount({ provider: "sandbox",
    emailAddress: emailAddress ?? `dupfup-${crypto.randomUUID()}@sender-${run}.example`,
    fromName: "Follow-up history", name: "Follow-up history", dailySendLimit: 500, minIntervalSeconds: 5 }, userId);
  accounts.push(created.id);
  return created.id;
}

/** Every lead owns its identity keys: no shared domains, so only the link itself can relate them. */
async function lead(name: string) {
  const id = crypto.randomUUID(); leads.push(id);
  await db.query(`INSERT INTO prospects (id,business_name,name_key,status,created_by_type)
    VALUES ($1,$2,$3,'contacted','legacy')`, [id, name, `${marker}-${id}`]);
  return id;
}

async function storeEmail(prospectId: string, email: string) {
  await db.query(`INSERT INTO prospect_emails (id,prospect_id,email,normalized_email,source_url,source_type,is_primary)
    VALUES (gen_random_uuid(),$1,$2,$2,'https://source.example/contact','official_website',true)`, [prospectId, email]);
}

async function conversationFor(prospectId: string) {
  const conversationId = crypto.randomUUID();
  await db.query(`INSERT INTO conversations (id,prospect_id,subject) VALUES ($1,$2,'Thread')`, [conversationId, prospectId]);
  return conversationId;
}

/** The canonical lead's own contacted history: one outbound 20 days ago, nothing inbound. */
async function contactedHistory(prospectId: string, email: string) {
  const conversationId = crypto.randomUUID();
  await db.query(`INSERT INTO conversations (id,prospect_id,subject,last_outbound_at) VALUES ($1,$2,'Original',$3)`, [conversationId, prospectId, daysAgo(20)]);
  await db.query(`INSERT INTO messages (id,prospect_id,conversation_id,direction,source,from_email,to_emails,subject,body_text,sent_at,delivery_status)
    VALUES (gen_random_uuid(),$1,$2,'outbound','smtp','founder@nomeriq.example',$3::jsonb,'Original','Original',$4,'accepted')`,
    [prospectId, conversationId, JSON.stringify([email]), daysAgo(20)]);
  await db.query(`INSERT INTO drafts (id,prospect_id,kind,sequence,status,subject,body,recipient_email,created_by_type,sent_at,created_at)
    VALUES (gen_random_uuid(),$1,'first_contact',0,'sent','Original','Original message',$2,'legacy',$3,$3)`, [prospectId, email, daysAgo(20)]);
}

async function inbound(prospectId: string, conversationId: string, from: string,
  opts: { subject?: string; headers?: Record<string, string>; undated?: boolean } = {}) {
  await db.query(`INSERT INTO messages (id,prospect_id,conversation_id,direction,source,from_email,to_emails,subject,body_text,sent_at,received_at,created_at,raw_headers,message_id)
    VALUES (gen_random_uuid(),$1,$2,'inbound','imap',$3,$4::jsonb,$5,'Please tell me more about your signals.',$6,$7,$8,$9::jsonb,$10)`,
    [prospectId, conversationId, from, JSON.stringify(["someone@inbound.example"]), opts.subject ?? "Reply about your signals",
      opts.undated ? null : daysAgo(1), opts.undated ? null : daysAgo(1), daysAgo(0),
      JSON.stringify(opts.headers ?? {}), `<${crypto.randomUUID()}@inbound.example>`]);
}

/** A rejection recommendation anchored to an outbound row, so the recommendation alone is the stop. */
async function rejectionRecommendation(prospectId: string, conversationId: string) {
  const messageId = (await db.query<{ id: string }>(`INSERT INTO messages (id,prospect_id,conversation_id,direction,source,from_email,to_emails,subject,body_text,sent_at,delivery_status)
    VALUES (gen_random_uuid(),$1,$2,'outbound','smtp','founder@nomeriq.example','[]'::jsonb,'Original','Original message',$3,'accepted') RETURNING id`,
    [prospectId, conversationId, daysAgo(2)])).rows[0]!.id;
  await db.query(`INSERT INTO prospect_rejection_recommendations (id,prospect_id,message_id,reason,objection,provenance_key)
    VALUES (gen_random_uuid(),$1,$2,'Offer rejection recorded for the duplicate follow-up regression fixture.','We do not want this.',$3)`,
    [prospectId, messageId, `offer-rejection:${messageId}`]);
}

async function addSuppression(prospectId: string, email: string) {
  const id = crypto.randomUUID(); suppressions.push(id);
  await db.query(`INSERT INTO suppressions (id,prospect_id,email,normalized_email,reason,source,active)
    VALUES ($1,$2,$3,$3,'manual','founder',true)`, [id, prospectId, email]);
}

async function mark(duplicateId: string, canonicalId: string) {
  await markProspectDuplicate({ prospectId: duplicateId, canonicalProspectId: canonicalId, actor: { id: userId, role: "founder" } });
}

async function listed(prospectId: string) {
  return (await readFollowUpCandidates(db, await readFollowUpSettings(db), prospectId)).length;
}

async function draft(prospectId: string, recipient: string) {
  const id = crypto.randomUUID();
  await db.query(`INSERT INTO drafts (id,prospect_id,kind,sequence,status,subject,body,recipient_email,created_by_type,approved_at)
    VALUES ($1,$2,'follow_up',1,'approved','A question','Hello, a short question about your signals.',$3,'founder',now())`,
    [id, prospectId, recipient]);
  return id;
}

async function code(fn: () => Promise<unknown>) {
  try { const out = await fn() as { status?: string; queued?: boolean }; return out.queued ? "queued" : out.status ?? "sent"; }
  catch (error) { return (error as { code?: string }).code ?? String(error); }
}
const send = (draftId: string) => code(async () => sendDraft({ draftId, accountId: await account(), actorUserId: userId }));

async function sideEffects(draftId: string) {
  const sends = await db.query<{ status: string }>(`SELECT status FROM outbound_sends WHERE draft_id=$1`, [draftId]);
  const messages = await db.query(`SELECT 1 FROM messages WHERE draft_id=$1`, [draftId]);
  const draftRow = await db.query<{ status: string }>(`SELECT status FROM drafts WHERE id=$1`, [draftId]);
  return { sendStatus: sends.rows[0]?.status ?? null, messages: messages.rows.length, draftStatus: draftRow.rows[0]?.status ?? null };
}

/** Canonical lead with contacted history, plus a duplicate linked to it by the founder. */
async function pair(name: string) {
  const canonical = await lead(`Canonical ${name}`);
  const dup = await lead(`Duplicate ${name}`);
  const dupConversation = await conversationFor(dup);
  const dupEmail = `${dup}@${dup}.example.test`;
  await storeEmail(dup, dupEmail);
  const email = `${canonical}@${canonical}.example.test`;
  await storeEmail(canonical, email);
  await contactedHistory(canonical, email);
  return { canonical, dup, dupConversation, dupEmail, email };
}

/** Applies a follow-up stop on the duplicate, before or after the founder marks it. */
async function stopCase(name: string, when: "before" | "after") {
  const { canonical, dup, dupConversation, dupEmail } = await pair(name);
  const apply = async () => {
    switch (name) {
      case "real_reply": await inbound(dup, dupConversation, dupEmail); break;
      case "undated_inbound": await inbound(dup, dupConversation, dupEmail, { undated: true }); break;
      case "not_interested_classification":
        await db.query(`UPDATE conversations SET classification='not_interested' WHERE id=$1`, [dupConversation]); break;
      case "unsubscribe_classification":
        await db.query(`UPDATE conversations SET classification='unsubscribe' WHERE id=$1`, [dupConversation]); break;
      case "rejection_recommendation": await rejectionRecommendation(dup, dupConversation); break;
      case "terminal_status_lost": await db.query(`UPDATE prospects SET status='lost' WHERE id=$1`, [dup]); break;
      case "pre_mark_do_not_contact": await db.query(`UPDATE prospects SET do_not_contact=true WHERE id=$1`, [dup]); break;
      case "manual_suppression": await addSuppression(dup, dupEmail); break;
      case "post_mark_rejection_hold":
        await db.query(`INSERT INTO audit_log (id,actor_type,actor_id,action,entity_type,entity_id,metadata)
          VALUES (gen_random_uuid(),'system',NULL,'lead.rejection_hold_set','prospect',$1,'{}'::jsonb)`, [dup]); break;
      default: throw new Error(`Unknown stop case ${name}`);
    }
  };
  if (when === "before") await apply();
  await mark(dup, canonical);
  if (when === "after") await apply();
  return canonical;
}

beforeAll(async () => {
  db = await getDb(); await ensureWorkspaceDefaults();
  userId = crypto.randomUUID();
  await db.query(`INSERT INTO users (id,email,normalized_email,name,password_hash,role) VALUES ($1,$2,$2,'Duplicate follow-up history',$3,'founder')`,
    [userId, `${marker}@test.example`, hashPassword(crypto.randomUUID())]);
  settings = (await db.query(`SELECT follow_up_max,follow_up_daily_limit,follow_up_auto_enabled,follow_up_delay_1_days,follow_up_delay_2_days,timezone
    FROM workspace_settings WHERE id='default'`)).rows[0]!;
  dailyBaseline = Number((await db.query<{ n: number }>(`SELECT count(*)::int n FROM drafts WHERE kind='follow_up'
    AND created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    AND created_at < (date_trunc('day',now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC'`)).rows[0]!.n);
});

beforeEach(async () => {
  await db.query(`UPDATE workspace_settings SET follow_up_max=2,follow_up_daily_limit=$1,follow_up_auto_enabled=false,
    follow_up_delay_1_days=4,follow_up_delay_2_days=7,timezone='UTC' WHERE id='default'`, [dailyBaseline + 10]);
});

afterEach(() => { transport.to.length = 0; vi.restoreAllMocks(); });

afterAll(async () => {
  await db.query(`UPDATE workspace_settings SET follow_up_max=$1,follow_up_daily_limit=$2,follow_up_auto_enabled=$3,
    follow_up_delay_1_days=$4,follow_up_delay_2_days=$5,timezone=$6 WHERE id='default'`,
    [settings.follow_up_max, settings.follow_up_daily_limit, settings.follow_up_auto_enabled,
      settings.follow_up_delay_1_days, settings.follow_up_delay_2_days, settings.timezone]);
  await db.query(`DELETE FROM prospect_rejection_recommendations WHERE prospect_id=ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM audit_log WHERE entity_id=ANY($1::text[]) OR metadata->>'prospectId'=ANY($1::text[])`, [leads]);
  await db.query(`DELETE FROM unsubscribe_tokens WHERE prospect_id=ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM outbound_sends WHERE prospect_id=ANY($1::uuid[]) OR account_id=ANY($2::uuid[])`, [leads, accounts]);
  await db.query(`DELETE FROM messages WHERE prospect_id=ANY($1::uuid[]) OR conversation_id IN (SELECT id FROM conversations WHERE prospect_id=ANY($1::uuid[]))`, [leads]);
  await db.query(`DELETE FROM drafts WHERE prospect_id=ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM conversations WHERE prospect_id=ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM prospect_emails WHERE prospect_id=ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM suppressions WHERE prospect_id=ANY($1::uuid[]) OR id=ANY($2::uuid[])`, [leads, suppressions]);
  await db.query(`DELETE FROM prospect_duplicate_links WHERE prospect_id=ANY($1::uuid[]) OR canonical_prospect_id=ANY($1::uuid[])`, [leads]);
  await db.query(`UPDATE prospects SET sending_account_id=null WHERE id=ANY($1::uuid[])`, [leads]).catch(() => undefined);
  await db.query(`DELETE FROM prospects WHERE id=ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM email_accounts WHERE id=ANY($1::uuid[])`, [accounts]);
  await db.query(`DELETE FROM users WHERE id=$1`, [userId]);
  await closeDb();
});

describe("linked duplicates stop canonical follow-ups", () => {
  it("a clean duplicate mark does not stop the canonical lead's follow-ups: the mark's own archived_at/DNC is not a hold", async () => {
    const { canonical, email } = await pair("clean");
    const dup = await lead("Clean duplicate");
    await mark(dup, canonical);
    expect(await listed(canonical)).toBe(1);
    const draftId = await draft(canonical, email);
    expect(await send(draftId)).toBe("sandbox");
    expect(transport.to).toEqual([email]);
    expect(await sideEffects(draftId)).toMatchObject({ sendStatus: "sandbox", draftStatus: "sent" });
  });

  it("a real reply on an active linked duplicate blocks the canonical follow-up send and cancels the draft (after the mark)", async () => {
    const { canonical, dup, dupConversation, dupEmail, email } = await pair("reply-after");
    await mark(dup, canonical);
    await inbound(dup, dupConversation, dupEmail);
    const draftId = await draft(canonical, email);
    expect(await send(draftId)).toBe("prospect_replied");
    expect(await sideEffects(draftId)).toMatchObject({ sendStatus: "blocked", messages: 0, draftStatus: "cancelled" });
    expect(transport.to).toEqual([]);
  });

  it("a real reply on the duplicate recorded before the mark still blocks the canonical follow-up send", async () => {
    const { canonical, dup, dupConversation, dupEmail, email } = await pair("reply-before");
    await inbound(dup, dupConversation, dupEmail);
    await mark(dup, canonical);
    const draftId = await draft(canonical, email);
    expect(await send(draftId)).toBe("prospect_replied");
    expect(await sideEffects(draftId)).toMatchObject({ sendStatus: "blocked", messages: 0, draftStatus: "cancelled" });
    expect(transport.to).toEqual([]);
  });

  it("a pre-existing restriction on the duplicate keeps the linked_hold refusal for follow-ups: the draft is blocked, not reply-cancelled", async () => {
    const { canonical, dup, dupEmail, email } = await pair("hold-boundary");
    await addSuppression(dup, dupEmail);
    await mark(dup, canonical);
    const draftId = await draft(canonical, email);
    expect(await send(draftId)).toBe("duplicate_contact");
    expect(await sideEffects(draftId)).toMatchObject({ sendStatus: null, messages: 0, draftStatus: "approved" });
    expect(transport.to).toEqual([]);
  });

  it("an out-of-office auto-reply on the duplicate is not a reply: the canonical follow-up still sends", async () => {
    const { canonical, dup, dupConversation, dupEmail, email } = await pair("ooo-negative");
    await mark(dup, canonical);
    await inbound(dup, dupConversation, dupEmail, { subject: "Out of office: automatic reply" });
    const draftId = await draft(canonical, email);
    expect(await send(draftId)).toBe("sandbox");
    expect(transport.to).toEqual([email]);
  });

  it.each([
    ["real_reply", "after"], ["real_reply", "before"], ["undated_inbound", "after"],
    ["not_interested_classification", "after"], ["unsubscribe_classification", "after"],
    ["rejection_recommendation", "after"], ["terminal_status_lost", "after"],
    ["pre_mark_do_not_contact", "before"], ["manual_suppression", "before"],
    ["post_mark_rejection_hold", "after"],
  ])("candidate selection skips the canonical lead when a linked duplicate carries %s (%s the mark)", async (name, when) => {
    expect(await listed(await stopCase(name, when as "before" | "after"))).toBe(0);
  });

  it.each(["clean_mark", "dsn_delivery_report", "ooo_auto_reply", "own_account_inbound", "repeated_mark_do_not_contact"])(
    "candidate selection keeps the canonical lead when a linked duplicate carries only %s", async (name) => {
      const { canonical, dup, dupConversation, dupEmail } = await pair(`control-${name}`);
      await mark(dup, canonical);
      if (name === "dsn_delivery_report") await inbound(dup, dupConversation, `mailer-daemon@${dup}.example.test`,
        { subject: "Delivery Status Notification (Failure)", headers: { deliveryReport: "true" } });
      if (name === "ooo_auto_reply") await inbound(dup, dupConversation, dupEmail,
        { subject: "Out of office: automatic reply", headers: { autoReply: "true" } });
      if (name === "own_account_inbound") {
        const own = `ownbox-${crypto.randomUUID()}@ownaccount-${run}.example`;
        await account(own);
        await inbound(dup, dupConversation, own);
      }
      // The mark itself set do_not_contact=true on the duplicate; re-asserting it is still not a hold.
      if (name === "repeated_mark_do_not_contact") await db.query(`UPDATE prospects SET do_not_contact=true WHERE id=$1`, [dup]);
      expect(await listed(canonical)).toBe(1);
    });

  it("restoring the duplicate link releases the stop: a later reply on the restored lead no longer stops the canonical", async () => {
    const { canonical, dup, dupConversation, dupEmail } = await pair("restore");
    await mark(dup, canonical);
    await restoreProspectDuplicate({ prospectId: dup, actor: { id: userId, role: "founder" } });
    await inbound(dup, dupConversation, dupEmail);
    expect(await listed(canonical)).toBe(1);
  });

  it("the agent draft save refuses the canonical lead after a real reply on its linked duplicate, and saves before one", async () => {
    const refused = await pair("persist-refused");
    const saved = await pair("persist-saved");
    await mark(refused.dup, refused.canonical);
    await mark(saved.dup, saved.canonical);
    const actor = { actorType: "chatgpt" as const, actorKeyId: `oauth:${crypto.randomUUID()}`,
      sourceAgent: "chatgpt" as const, sourceChannel: "mcp_oauth" as const, sourceClient: "ChatGPT" };
    const input = (prospectId: string) => ({ prospectId, expectedSequence: 1,
      subject: "A short follow-up", body: "Would a brief discussion about Nomeriq be useful for your team?" });
    expect(await saveAgentFollowUpDrafts({ drafts: [input(saved.canonical)], actor }))
      .toMatchObject({ saved: 1, preserved: 0, refused: 0 });
    await inbound(refused.dup, refused.dupConversation, refused.dupEmail);
    const result = await saveAgentFollowUpDrafts({ drafts: [input(refused.canonical)], actor });
    expect(result).toMatchObject({ saved: 0, preserved: 0, refused: 1 });
    expect(result.results[0]).toMatchObject({ status: "refused", code: "not_eligible" });
    expect((await db.query(`SELECT 1 FROM drafts WHERE prospect_id=$1 AND kind='follow_up'`, [refused.canonical])).rows).toHaveLength(0);
  });

  it("the final guarded INSERT re-applies the linked stop: a reply on the duplicate landing after the candidate read refuses the save", async () => {
    const { canonical, dup, dupConversation, dupEmail } = await pair("persist-race");
    await mark(dup, canonical);
    const original = db.transaction.bind(db);
    let injected = false;
    vi.spyOn(db, "transaction").mockImplementation(async (fn) => original(async (tx) => fn({
      ...tx,
      transaction: tx.transaction,
      query: async (text: string, params?: unknown[]) => {
        if (!injected && /^WITH eligible AS/.test(text)) {
          // The duplicate's reply commits between the candidate read and the guarded INSERT.
          injected = true;
          await tx.query(`INSERT INTO messages (id,prospect_id,conversation_id,direction,source,from_email,to_emails,subject,body_text,received_at)
            VALUES (gen_random_uuid(),$1,$2,'inbound','imap',$3,'[]'::jsonb,'Reply','Yes, tell me more.',now())`, [dup, dupConversation, dupEmail]);
        }
        return tx.query(text, params);
      },
    } as DbClient)) as never);
    const actor = { actorType: "chatgpt" as const, actorKeyId: `oauth:${crypto.randomUUID()}` };
    const result = await saveAgentFollowUpDrafts({ drafts: [{ prospectId: canonical, expectedSequence: 1,
      subject: "A short follow-up", body: "Would a brief discussion about Nomeriq be useful for your team?" }], actor });
    expect(injected).toBe(true);
    expect(result.results[0]).toMatchObject({ status: "refused", code: "eligibility_changed" });
    expect((await db.query(`SELECT 1 FROM drafts WHERE prospect_id=$1 AND kind='follow_up'`, [canonical])).rows).toHaveLength(0);
  });

  it("the linked-duplicate stop policy is shared SQL, not copied conditions", () => {
    const src = (file: string) => readFileSync(new URL(`../src/lib/services/${file}`, import.meta.url), "utf8");
    const policy = src("linked-contact-policy.ts");
    expect(policy).toContain("'replied','interested','demo','proposal','won','lost'");
    expect(policy).toContain("'unsubscribe','not_interested'");
    const candidates = src("agent-followups.ts");
    expect(candidates).toContain("linkedDuplicateFollowUpStopSql(");
    expect(candidates).not.toContain("'replied','interested'");
    expect(src("email-sending.ts")).toContain("linkedDuplicateFollowUpStopSql(");
    const guard = src("duplicate-contact.ts");
    expect(guard).toContain("linkedContactHoldSql(");
    expect(guard).not.toContain("previous_state #>>");
  });
});
