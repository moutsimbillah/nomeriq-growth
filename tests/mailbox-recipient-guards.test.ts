import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, type DbClient } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { createEmailAccount } from "@/lib/email/accounts";
import { sendDraft } from "@/lib/services/email-sending";
import { saveAgentFollowUpDrafts } from "@/lib/services/agent-followups";
import { listFollowUpCandidates } from "@/lib/services/followups";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/** Whole-lead recipient policy across send, final send guard and follow-up preparation. */
let db: DbClient;
let userId = "";
let accountId = "";
let settings: Record<string, unknown>;
const leads: string[] = [];
const suppressions: string[] = [];
const marker = `recipient-guards-${crypto.randomUUID()}`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
const actor = { actorType: "claude" as const, sourceAgent: "claude" as const, sourceChannel: "mcp_oauth" as const };

async function lead(opts: { contacted?: boolean } = {}) {
  const id = crypto.randomUUID(); const conversationId = crypto.randomUUID();
  const primary = `primary-${id}@guards.example`; const alt = `alt-${id}@guards.example`;
  leads.push(id);
  await db.query(`INSERT INTO prospects (id,business_name,name_key,status,created_by_type)
    VALUES ($1,'Recipient guard fixture',$2,$3,'legacy')`, [id, `${marker}-${id}`, opts.contacted === false ? "verified" : "contacted"]);
  await db.query(`INSERT INTO prospect_emails (id,prospect_id,email,normalized_email,source_url,source_type,is_primary,created_at)
    VALUES (gen_random_uuid(),$1,$2,$2,'https://guards.example','official_website',true,now()-interval '2 days'),
           (gen_random_uuid(),$1,$3,$3,'https://guards.example/team','official_website',false,now()-interval '1 day')`, [id, primary, alt]);
  if (opts.contacted !== false) {
    await db.query(`INSERT INTO conversations (id,prospect_id,subject,last_outbound_at) VALUES ($1,$2,'Original',$3)`, [conversationId, id, daysAgo(20)]);
    await db.query(`INSERT INTO drafts (id,prospect_id,kind,sequence,status,subject,body,recipient_email,created_by_type,sent_at,created_at)
      VALUES (gen_random_uuid(),$1,'first_contact',0,'sent','Original','Original message',$2,'legacy',$3,$3)`, [id, primary, daysAgo(20)]);
    await db.query(`INSERT INTO messages (id,prospect_id,conversation_id,direction,source,from_email,to_emails,subject,body_text,sent_at,delivery_status)
      VALUES (gen_random_uuid(),$1,$2,'outbound','smtp','founder@nomeriq.example',$3::jsonb,'Original','Original',$4,'accepted')`,
      [id, conversationId, JSON.stringify([primary]), daysAgo(20)]);
  }
  return { id, conversationId, primary, alt };
}
async function suppress(email: string, reason: string, prospectId: string | null = null) {
  const id = crypto.randomUUID(); suppressions.push(id);
  await db.query(`INSERT INTO suppressions (id,email,normalized_email,reason,source,prospect_id,active)
    VALUES ($1,$2,$2,$3,'founder',$4,true)`, [id, email, reason, prospectId]);
}
async function draft(prospectId: string, recipient: string, kind = "first_contact", sequence = 0) {
  const id = crypto.randomUUID();
  await db.query(`INSERT INTO drafts (id,prospect_id,kind,sequence,status,subject,body,recipient_email,ai_generated,warnings,created_by_type,approved_at)
    VALUES ($1,$2,$3,$4,'approved','A question','Hello, a short question about your signals.\n\nBest,',$5,false,'[]'::jsonb,'founder',now())`,
    [id, prospectId, kind, sequence, recipient]);
  return id;
}
async function code(fn: () => Promise<unknown>) {
  try { await fn(); return "sent"; } catch (error) { return (error as { code?: string }).code ?? String(error); }
}
async function inbound(conversationId: string, from: string, at: string, headers: Record<string, unknown> = {}, subject = "Re: Original") {
  await db.query(`INSERT INTO messages (id,conversation_id,direction,source,from_email,subject,body_text,received_at,sent_at,raw_headers)
    VALUES (gen_random_uuid(),$1,'inbound','imap',$2,$3,'Body',$4,$4,$5::jsonb)`, [conversationId, from, subject, at, JSON.stringify(headers)]);
}
const save = (id: string, expectedSequence = 1) => saveAgentFollowUpDrafts({ drafts: [{ prospectId: id, expectedSequence,
  subject: "A short follow-up", body: "Would a brief discussion about Nomeriq be useful for your team?" }], actor });
const listed = async (id: string) => (await listFollowUpCandidates()).find((c) => c.prospectId === id);

beforeAll(async () => {
  db = await getDb(); await ensureWorkspaceDefaults();
  settings = (await db.query(`SELECT follow_up_max,follow_up_daily_limit,follow_up_auto_enabled,follow_up_delay_1_days,follow_up_delay_2_days,timezone FROM workspace_settings WHERE id='default'`)).rows[0]!;
  userId = crypto.randomUUID();
  await db.query(`INSERT INTO users (id,email,normalized_email,name,password_hash,role) VALUES ($1,$2,$2,'Guard fixture',$3,'founder')`,
    [userId, `${marker}@test.example`, hashPassword(crypto.randomUUID())]);
  const account = await createEmailAccount({ provider: "sandbox", emailAddress: `${marker}@sender.example`, fromName: "Guard",
    name: "Guard", dailySendLimit: 500, minIntervalSeconds: 5 }, userId);
  accountId = account.id;
});
beforeEach(async () => {
  await db.query(`UPDATE workspace_settings SET follow_up_max=2,follow_up_daily_limit=50,follow_up_auto_enabled=false,
    follow_up_delay_1_days=4,follow_up_delay_2_days=7,timezone='UTC' WHERE id='default'`);
});
afterAll(async () => {
  await db.query(`UPDATE workspace_settings SET follow_up_max=$1,follow_up_daily_limit=$2,follow_up_auto_enabled=$3,
    follow_up_delay_1_days=$4,follow_up_delay_2_days=$5,timezone=$6 WHERE id='default'`,
    [settings.follow_up_max, settings.follow_up_daily_limit, settings.follow_up_auto_enabled, settings.follow_up_delay_1_days, settings.follow_up_delay_2_days, settings.timezone]);
  await db.query(`DELETE FROM audit_log WHERE metadata->>'prospectId'=ANY($1::text[]) OR entity_id=ANY($1::text[])`, [leads]);
  await db.query(`DELETE FROM outbound_sends WHERE prospect_id=ANY($1::uuid[]) OR account_id=$2::uuid`, [leads, accountId || null]);
  await db.query(`DELETE FROM unsubscribe_tokens WHERE prospect_id=ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM messages WHERE prospect_id=ANY($1::uuid[]) OR conversation_id IN (SELECT id FROM conversations WHERE prospect_id=ANY($1::uuid[]))`, [leads]);
  await db.query(`DELETE FROM drafts WHERE prospect_id=ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM conversations WHERE prospect_id=ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM prospect_emails WHERE prospect_id=ANY($1::uuid[])`, [leads]);
  await db.query(`UPDATE prospects SET sending_account_id=null WHERE id=ANY($1::uuid[])`, [leads]).catch(() => undefined);
  await db.query(`DELETE FROM prospects WHERE id=ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM suppressions WHERE id=ANY($1::uuid[])`, [suppressions]);
  await db.query(`DELETE FROM email_accounts WHERE id=$1::uuid`, [accountId || null]);
  await db.query(`DELETE FROM users WHERE id=$1`, [userId]);
  await closeDb();
});

describe("whole-lead recipient policy at send", () => {
  it("an unsubscribe on ANY linked alias refuses a newly typed founder address and records nothing", async () => {
    const l = await lead({ contacted: false });
    await suppress(l.alt, "unsubscribe");
    const typed = `typed-${l.id}@guards.example`;
    const draftId = await draft(l.id, typed);
    expect(await code(() => sendDraft({ draftId, accountId, actorUserId: userId, allowFounderRecipient: true }))).toBe("suppressed");
    expect((await db.query(`SELECT 1 FROM prospect_emails WHERE prospect_id=$1 AND normalized_email=$2`, [l.id, typed])).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM messages WHERE draft_id=$1`, [draftId])).rows).toHaveLength(0);
  });
  it("a prospect-scoped manual suppression stops every stored recipient", async () => {
    const l = await lead({ contacted: false });
    await suppress(`elsewhere-${l.id}@other.example`, "manual", l.id);
    expect(await code(async () => sendDraft({ draftId: await draft(l.id, l.primary), accountId, actorUserId: userId }))).toBe("suppressed");
  });
  it("a bounce blocks only the dead address; the founder may explicitly send to the viable stored alternate", async () => {
    const l = await lead({ contacted: false });
    await suppress(l.primary, "bounce");
    const draftId = await draft(l.id, l.primary);
    expect(await code(() => sendDraft({ draftId, accountId, actorUserId: userId }))).toBe("suppressed");
    await db.query(`UPDATE drafts SET recipient_email=$1 WHERE id=$2`, [l.alt, draftId]);
    const ok = await sendDraft({ draftId, accountId, actorUserId: userId });
    expect("queued" in ok ? "queued" : ok.status).toBe("sandbox");
  });
  it("refuses a stored address the founder unlinked, even with founder override", async () => {
    const l = await lead({ contacted: false });
    const row = (await db.query<{ id: string }>(`SELECT id FROM prospect_emails WHERE prospect_id=$1 AND email=$2`, [l.id, l.alt])).rows[0]!;
    await db.query(`INSERT INTO audit_log (id,actor_type,actor_id,action,entity_type,entity_id,metadata)
      VALUES (gen_random_uuid(),'founder',$1,'lead.email_unlinked','prospect',$2,$3::jsonb)`, [userId, l.id, JSON.stringify({ emailRowId: row.id })]);
    const draftId = await draft(l.id, l.alt);
    expect(await code(() => sendDraft({ draftId, accountId, actorUserId: userId, allowFounderRecipient: true }))).toBe("unverified_recipient");
  });
  it("conversation-owned outbound with a null prospect_id to an alias still counts as prior contact", async () => {
    const l = await lead({ contacted: false });
    const conversationId = crypto.randomUUID();
    await db.query(`INSERT INTO conversations (id,prospect_id,subject) VALUES ($1,$2,'Imported')`, [conversationId, l.id]);
    await db.query(`INSERT INTO messages (id,conversation_id,direction,source,from_email,to_emails,subject,body_text,sent_at)
      VALUES (gen_random_uuid(),$1,'outbound','imap','founder@nomeriq.example',$2::jsonb,'Imported','Body',$3)`,
      [conversationId, JSON.stringify([l.alt]), daysAgo(3)]);
    expect(await code(async () => sendDraft({ draftId: await draft(l.id, l.primary), accountId, actorUserId: userId }))).toBe("already_contacted");
  });
  it("outbound to a linked alias recorded under no conversation is also prior contact", async () => {
    const l = await lead({ contacted: false });
    await db.query(`INSERT INTO messages (id,direction,source,from_email,to_emails,subject,body_text,sent_at)
      VALUES (gen_random_uuid(),'outbound','imap','founder@nomeriq.example',$1::jsonb,'Webmail','Body',$2)`,
      [JSON.stringify([l.alt.toUpperCase()]), daysAgo(3)]);
    expect(await code(async () => sendDraft({ draftId: await draft(l.id, l.primary), accountId, actorUserId: userId }))).toBe("already_contacted");
    await db.query(`DELETE FROM messages WHERE to_emails @> $1::jsonb`, [JSON.stringify([l.alt.toUpperCase()])]);
  });
  it("re-reads policy at the final pre-transport guard and refuses a late opt-out", async () => {
    const l = await lead({ contacted: false });
    const draftId = await draft(l.id, l.primary);
    await db.query(`UPDATE outbound_sends SET completed_at=now()-interval '1 hour' WHERE account_id=$1`, [accountId]);
    const query = db.query.bind(db);
    let injected = false;
    (db as { query: DbClient["query"] }).query = (async (sql: string, params?: unknown[]) => {
      if (!injected && sql.includes("INSERT INTO unsubscribe_tokens")) {
        injected = true;
        await query(`INSERT INTO suppressions (id,email,normalized_email,reason,source,prospect_id,active) VALUES ($1,$2,$2,'complaint','founder',$3,true)`,
          [(() => { const s = crypto.randomUUID(); suppressions.push(s); return s; })(), l.alt, l.id]);
      }
      return query(sql, params as never);
    }) as DbClient["query"];
    try {
      expect(await code(() => sendDraft({ draftId, accountId, actorUserId: userId }))).toBe("suppressed");
    } finally { (db as { query: DbClient["query"] }).query = query; }
    expect(injected).toBe(true);
    expect((await db.query(`SELECT status FROM outbound_sends WHERE draft_id=$1`, [draftId])).rows[0]?.status).toBe("blocked");
    expect((await db.query(`SELECT 1 FROM messages WHERE draft_id=$1`, [draftId])).rows).toHaveLength(0);
  });
});

describe("follow-up candidates use the recipient policy", () => {
  it("bounced primary with a viable alternate and no reply: drafts to the alternate", async () => {
    const l = await lead();
    await suppress(l.primary, "bounce");
    expect((await listed(l.id))?.contactEmail).toBe(l.alt);
    const result = await save(l.id);
    expect(result.saved).toBe(1);
    expect((await db.query(`SELECT recipient_email FROM drafts WHERE id=$1`, [result.results[0]!.draftId])).rows[0]!.recipient_email).toBe(l.alt);
  });
  it("a DSN (deliveryReport) is not a reply and does not stop the alternate follow-up", async () => {
    const l = await lead();
    await suppress(l.primary, "bounce");
    await inbound(l.conversationId, "mailer-daemon@guards.example", daysAgo(19), { deliveryReport: true }, "Undeliverable");
    await inbound(l.conversationId, l.primary, daysAgo(18), { autoReply: true }, "Out of office");
    expect((await save(l.id)).saved).toBe(1);
  });
  it("an unsubscribe on any alias blocks all follow-ups with a clear reason", async () => {
    const l = await lead();
    await suppress(l.alt, "unsubscribe");
    expect(await listed(l.id)).toBeUndefined();
    expect((await save(l.id)).results[0]).toMatchObject({ status: "refused", code: "recipient_blocked" });
  });
  it("an externally answered real reply never gets another follow-up", async () => {
    const l = await lead();
    await inbound(l.conversationId, l.primary, daysAgo(15));
    await db.query(`INSERT INTO messages (id,conversation_id,direction,source,from_email,to_emails,subject,body_text,sent_at)
      VALUES (gen_random_uuid(),$1,'outbound','imap','founder@nomeriq.example',$2::jsonb,'Re: Original','External answer',$3)`,
      [l.conversationId, JSON.stringify([l.primary]), daysAgo(10)]);
    expect(await listed(l.id)).toBeUndefined();
    expect((await save(l.id)).refused).toBe(1);
  });
  it("an undated inbound still fails closed", async () => {
    const l = await lead();
    await db.query(`INSERT INTO messages (id,conversation_id,direction,source,from_email) VALUES (gen_random_uuid(),$1,'inbound','imap','x@guards.example')`, [l.conversationId]);
    expect((await save(l.id)).refused).toBe(1);
  });
  it("a follow-up send is refused at the send gate after any real reply, even an older one", async () => {
    const l = await lead();
    await inbound(l.conversationId, l.primary, daysAgo(15));
    const draftId = await draft(l.id, l.primary, "follow_up", 1);
    expect(await code(() => sendDraft({ draftId, accountId, actorUserId: userId }))).toBe("prospect_replied");
  });
});
