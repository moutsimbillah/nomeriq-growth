import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, closeDb, type DbClient } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { saveAgentFollowUpDrafts, type AgentFollowUpDraftInput } from "@/lib/services/agent-followups";
import { listFollowUpCandidates, prepareFollowUpDraftOutcome } from "@/lib/services/followups";
import { generateFollowUp } from "@/lib/ai/writer";
import { draftProvenance } from "@/lib/ai/provenance";

vi.mock("@/lib/ai/writer", () => ({ generateFollowUp: vi.fn() }));
const actor = { actorType: "chatgpt" as const, actorKeyId: `oauth:${crypto.randomUUID()}`,
  sourceAgent: "chatgpt" as const, sourceChannel: "mcp_oauth" as const, sourceClient: "ChatGPT" };
let db: DbClient;
let userId: string;
let settings: Record<string, unknown>;
let dailyBaseline = 0;
const leads: string[] = [];
const suppressions: string[] = [];
const marker = crypto.randomUUID();
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
const draftInput = (prospectId: string, expectedSequence = 1): AgentFollowUpDraftInput => ({
  prospectId, expectedSequence, subject: "A short follow-up", body: "Would a brief discussion about Nomeriq be useful for your team?",
});
const save = (...ids: string[]) => saveAgentFollowUpDrafts({ drafts: ids.map((id) => draftInput(id)), actor });

async function seed(): Promise<{id:string; conversationId:string; email:string}> {
  const id = crypto.randomUUID(); const conversationId = crypto.randomUUID();
  const email = `${id}@example.test`; leads.push(id);
  await db.query(`INSERT INTO prospects (id,business_name,name_key,status,created_by_type)
    VALUES ($1,'Agent follow-up fixture',$2,'contacted','legacy')`,[id,`${marker}-${id}`]);
  await db.query(`INSERT INTO prospect_emails (id,prospect_id,email,normalized_email,source_url,source_type,is_primary)
    VALUES (gen_random_uuid(),$1,$2,$2,'https://example.test','official_website',true)`,[id,email]);
  await db.query(`INSERT INTO conversations (id,prospect_id,subject,last_outbound_at) VALUES ($1,$2,'Original',$3)`,[conversationId,id,daysAgo(20)]);
  await db.query(`INSERT INTO drafts (id,prospect_id,kind,sequence,status,subject,body,recipient_email,created_by_type,sent_at,created_at)
    VALUES (gen_random_uuid(),$1,'first_contact',0,'sent','Original','Original message',$2,'legacy',$3,$3)`,[id,email,daysAgo(20)]);
  return {id,conversationId,email};
}
async function message(id: string | null, conversationId: string | null, direction: string, actual: string, imported = daysAgo(0), useOtherTimestamp = false) {
  await db.query(`INSERT INTO messages (id,prospect_id,conversation_id,direction,source,from_email,subject,body_text,sent_at,received_at,created_at)
    VALUES (gen_random_uuid(),$1,$2,$3,'imap','fixture@example.test','Fixture','Fixture',$4,$5,$6)`,
    [id,conversationId,direction, direction === 'outbound' !== useOtherTimestamp ? actual : null,
      direction === 'inbound' !== useOtherTimestamp ? actual : null,imported]);
}
async function addSuppression(email: string, active = true) {
  const id=crypto.randomUUID(); suppressions.push(id);
  await db.query(`INSERT INTO suppressions (id,email,normalized_email,reason,source,active) VALUES ($1,$2,$2,'manual','founder',$3)`,[id,email,active]);
}
async function cleanOwnRows() {
  await db.query(`DELETE FROM audit_log WHERE action='follow_up.draft_saved' AND entity_id IN (SELECT id::text FROM drafts WHERE prospect_id=ANY($1::uuid[]))`,[leads]);
  await db.query(`DELETE FROM messages WHERE prospect_id=ANY($1::uuid[]) OR conversation_id IN (SELECT id FROM conversations WHERE prospect_id=ANY($1::uuid[]))`,[leads]);
  await db.query(`DELETE FROM drafts WHERE prospect_id=ANY($1::uuid[])`,[leads]);
  await db.query(`DELETE FROM conversations WHERE prospect_id=ANY($1::uuid[])`,[leads]);
  await db.query(`DELETE FROM prospect_emails WHERE prospect_id=ANY($1::uuid[])`,[leads]);
  await db.query(`DELETE FROM prospects WHERE id=ANY($1::uuid[])`,[leads]);
  await db.query(`DELETE FROM suppressions WHERE id=ANY($1::uuid[])`,[suppressions]);
  leads.length=0; suppressions.length=0;
}

beforeAll(async () => {
  db = await getDb(); await ensureWorkspaceDefaults();
  settings=(await db.query(`SELECT follow_up_max,follow_up_daily_limit,follow_up_auto_enabled,follow_up_delay_1_days,follow_up_delay_2_days,timezone FROM workspace_settings WHERE id='default'`)).rows[0]!;
  // Existing rows belong to other files; include them in the cap, never delete or alter them.
  dailyBaseline=Number((await db.query<{n:number}>(`SELECT count(*)::int n FROM drafts WHERE kind='follow_up' AND created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND created_at < (date_trunc('day',now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC'`)).rows[0]!.n);
  userId=crypto.randomUUID(); const email=`${marker}@example.test`;
  await db.query(`INSERT INTO users (id,email,normalized_email,name,password_hash,role) VALUES ($1,$2,$2,'Agent follow-up fixture',$3,'founder')`,[userId,email,hashPassword(crypto.randomUUID())]);
});
beforeEach(async () => {
  await db.query(`UPDATE workspace_settings SET follow_up_max=2,follow_up_daily_limit=$1,follow_up_auto_enabled=false,
    follow_up_delay_1_days=4,follow_up_delay_2_days=7,timezone='UTC' WHERE id='default'`,[dailyBaseline+10]);
  vi.mocked(generateFollowUp).mockReset();
  vi.mocked(generateFollowUp).mockResolvedValue({subject:"Founder follow-up",body:"Would you like to discuss this with the founder soon?",usedAi:false,model:"fixture"});
});
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await cleanOwnRows(); });
afterAll(async () => {
  await db.query(`UPDATE workspace_settings SET follow_up_max=$1,follow_up_daily_limit=$2,follow_up_auto_enabled=$3,
    follow_up_delay_1_days=$4,follow_up_delay_2_days=$5,timezone=$6 WHERE id='default'`,
    [settings.follow_up_max,settings.follow_up_daily_limit,settings.follow_up_auto_enabled,settings.follow_up_delay_1_days,settings.follow_up_delay_2_days,settings.timezone]);
  await db.query(`DELETE FROM users WHERE id=$1`,[userId]); await closeDb();
});

describe("agent supplied follow-up saving",()=>{
  it("stores only supplied text, stored recipient, actor/source, initial revision and Product Truth warnings; no other side effects",async()=>{
    const lead=await seed();
    const before=(await db.query(`SELECT * FROM prospects WHERE id=$1`,[lead.id])).rows[0];
    const settingsBefore=(await db.query(`SELECT * FROM workspace_settings WHERE id='default'`)).rows;
    const countsBefore=(await db.query(`SELECT (SELECT count(*) FROM outbound_sends) sends,(SELECT count(*) FROM campaigns) campaigns,(SELECT count(*) FROM research_events) events`)).rows;
    const fetch=vi.fn(); vi.stubGlobal("fetch",fetch);
    const input={...draftInput(lead.id),body:"Nomeriq guarantees risk-free results. Would you like a discussion?"};
    const result=await saveAgentFollowUpDrafts({drafts:[input],actor});
    expect(result).toEqual({results:[{prospectId:lead.id,status:"saved",draftId:expect.any(String)}],saved:1,preserved:0,refused:0});
    const row=(await db.query(`SELECT * FROM drafts WHERE id=$1`,[result.results[0]!.draftId])).rows[0]!;
    expect(row).toMatchObject({subject:input.subject,body:input.body,recipient_email:lead.email,kind:"follow_up",sequence:1,
      status:"draft",created_by_type:"chatgpt",created_by_user_id:null,source_agent:"chatgpt",source_channel:"mcp_oauth",source_client:"ChatGPT",
      ai_generated:true,ai_model:null,ai_provider:null,founder_edited:false,approved_at:null,approved_by:null,sent_at:null});
    expect(row.product_truth_version).toBe((await db.query(`SELECT version FROM product_truth ORDER BY version DESC LIMIT 1`)).rows[0]!.version);
    expect(row.warnings).toEqual(expect.arrayContaining([expect.objectContaining({code:"unsupported_claim"})]));
    expect((await db.query(`SELECT * FROM draft_revisions WHERE draft_id=$1`,[row.id])).rows).toEqual([expect.objectContaining({subject:input.subject,body:input.body,recipient_email:lead.email,edited_by:null,edited_by_type:"chatgpt"})]);
    const audit=(await db.query(`SELECT * FROM audit_log WHERE entity_id=$1`,[row.id])).rows;
    expect(audit).toEqual([expect.objectContaining({actor_type:"chatgpt",actor_id:actor.actorKeyId,metadata:{prospectId:lead.id,sequence:1,sourceAgent:"chatgpt",sourceChannel:"mcp_oauth"}})]);
    for(const value of [input.subject,input.body,lead.email]) {expect(JSON.stringify(result)).not.toContain(value);expect(JSON.stringify(audit)).not.toContain(value);}
    expect((await db.query(`SELECT * FROM prospects WHERE id=$1`,[lead.id])).rows[0]).toEqual(before);
    expect((await db.query(`SELECT * FROM workspace_settings WHERE id='default'`)).rows).toEqual(settingsBefore);
    expect((await db.query(`SELECT (SELECT count(*) FROM outbound_sends) sends,(SELECT count(*) FROM campaigns) campaigns,(SELECT count(*) FROM research_events) events`)).rows).toEqual(countsBefore);
    expect(fetch).not.toHaveBeenCalled(); expect(generateFollowUp).not.toHaveBeenCalled();
  });
  it.each(['draft','approved','sent','cancelled','discarded'])("preserves ANY existing %s sequence, even founder edited and now ineligible",async(status)=>{
    const lead=await seed(); const first=await save(lead.id); const draftId=first.results[0]!.draftId!;
    await db.query(`UPDATE drafts SET status=$1,founder_edited=true WHERE id=$2`,[status,draftId]);
    await db.query(`UPDATE prospects SET do_not_contact=true WHERE id=$1`,[lead.id]);
    const before=(await db.query(`SELECT * FROM drafts WHERE id=$1`,[draftId])).rows[0];
    const result=await save(lead.id); expect(result.preserved).toBe(1); expect(result.results[0]!.draftId).toBe(draftId);
    expect((await db.query(`SELECT * FROM drafts WHERE id=$1`,[draftId])).rows[0]).toEqual(before);
    expect((await db.query(`SELECT * FROM draft_revisions WHERE draft_id=$1`,[draftId])).rows).toHaveLength(1);
  });
  it("repeat and concurrent same-lead saves produce one draft and one history row",async()=>{
    const {id}=await seed(); const results=await Promise.all([save(id),save(id),save(id)]);
    expect(results.map(r=>r.saved).reduce((a,b)=>a+b,0)).toBe(1);
    expect(results.map(r=>r.preserved).reduce((a,b)=>a+b,0)).toBe(2);
    expect(new Set(results.map(r=>r.results[0]!.draftId)).size).toBe(1);
  });
  it("rolls back draft and initial history together if audit recording fails",async()=>{
    const lead=await seed();const transaction=db.transaction.bind(db);
    vi.spyOn(db,'transaction').mockImplementationOnce((fn)=>transaction(async(tx)=>{
      const query=tx.query.bind(tx);
      tx.query=async <T>(sql:string,params?:unknown[])=>{
        if(sql.startsWith('INSERT INTO audit_log')) throw new Error('Fixture audit failure');
        return query<T>(sql,params);
      };
      return fn(tx);
    }));
    await expect(save(lead.id)).rejects.toThrow('Fixture audit failure');
    expect((await db.query(`SELECT id FROM drafts WHERE kind='follow_up' AND prospect_id=$1`,[lead.id])).rows).toHaveLength(0);
    expect((await db.query(`SELECT r.id FROM draft_revisions r JOIN drafts d ON d.id=r.draft_id WHERE d.prospect_id=$1`,[lead.id])).rows).toHaveLength(0);
  });
  it("all preparers share an atomic cap across concurrent agent and founder runs",async()=>{
    const a=await seed(), b=await seed(), c=await seed();
    await db.query(`UPDATE workspace_settings SET follow_up_daily_limit=$1 WHERE id='default'`,[dailyBaseline+1]);
    const result=await Promise.all([save(a.id),save(b.id),prepareFollowUpDraftOutcome({userId,prospectIds:[c.id],trigger:'founder'})]);
    expect(result[0].saved+result[1].saved+result[2].drafts.length).toBe(1);
    expect((await db.query(`SELECT id FROM drafts WHERE kind='follow_up' AND prospect_id=ANY($1::uuid[])`,[leads])).rows).toHaveLength(1);
  });
  it("founder generation stays outside tx; agent consuming the last slot during generation prevents the founder insert",async()=>{
    const a=await seed(),b=await seed();
    await db.query(`UPDATE workspace_settings SET follow_up_daily_limit=$1 WHERE id='default'`,[dailyBaseline+1]);
    vi.mocked(generateFollowUp).mockImplementationOnce(async()=>{
      expect((await save(a.id)).saved).toBe(1);
      return {subject:"Founder follow-up",body:"Would you like to discuss this with the founder soon?",usedAi:false,model:"fixture"};
    });
    expect((await prepareFollowUpDraftOutcome({userId,prospectIds:[b.id],trigger:'founder'})).drafts).toHaveLength(0);
    expect((await save(b.id)).results[0]!.code).toBe('daily_limit');
  });
  it.each(['chatgpt','claude','deepseek','api'] as const)("attributes %s without a user foreign key or founder channel",async(actorType)=>{
    const {id}=await seed(); const result=await saveAgentFollowUpDrafts({drafts:[draftInput(id)],actor:{actorType}});
    const row=(await db.query(`SELECT created_by_type,created_by_user_id,source_channel FROM drafts WHERE id=$1`,[result.results[0]!.draftId])).rows[0]!;
    expect(row.created_by_type).toBe(actorType);expect(row.created_by_user_id).toBeNull();expect(row.source_channel).not.toBe('founder');
  });
});

describe("shared final eligibility and actual message chronology",()=>{
  it("refuses an inbound message with no actual date rather than silently ignoring a possible reply",async()=>{
    const lead=await seed();
    await db.query(`INSERT INTO messages(id,conversation_id,direction,source,from_email) VALUES(gen_random_uuid(),$1,'inbound','imap','fixture@example.test')`,[lead.conversationId]);
    expect((await listFollowUpCandidates()).some(c=>c.prospectId===lead.id)).toBe(false);
    expect((await save(lead.id)).results[0]!.code).toBe('not_eligible');
  });
  it("founder preparation retains actual provider/model provenance, not a false founder author",async()=>{
    const lead=await seed();
    vi.mocked(generateFollowUp).mockResolvedValueOnce({subject:'A recorded follow-up',body:'Would a discovery discussion help clarify your requirements?',usedAi:true,model:'fixture-model',provider:'Synthetic provider'});
    const result=await prepareFollowUpDraftOutcome({userId,prospectIds:[lead.id],trigger:'founder'});
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]!.sourceAgent).toBeNull();
    expect(draftProvenance(result.drafts[0]!)).toBe('Written by Synthetic provider · fixture-model');
  });
  it.each(['do_not_contact','follow_up_excluded','archived','unsubscribe','not_interested','interested','demo','proposal','won','lost','replied','suppression','secondary_suppression','reply'])("rechecks %s after a due listing",async(kind)=>{
    const lead=await seed(); expect((await listFollowUpCandidates()).some(c=>c.prospectId===lead.id && c.due)).toBe(true);
    if(kind==='do_not_contact'||kind==='follow_up_excluded') await db.query(`UPDATE prospects SET ${kind}=true WHERE id=$1`,[lead.id]);
    else if(kind==='archived') await db.query(`UPDATE prospects SET archived_at=now() WHERE id=$1`,[lead.id]);
    else if(kind==='unsubscribe'||kind==='not_interested') await db.query(`UPDATE conversations SET classification=$1 WHERE id=$2`,[kind,lead.conversationId]);
    else if(kind==='suppression') await addSuppression(lead.email);
    else if(kind==='secondary_suppression') {
      const email=`other-${lead.email}`;
      await db.query(`INSERT INTO prospect_emails (id,prospect_id,email,normalized_email,source_url,source_type,is_primary) VALUES (gen_random_uuid(),$1,$2,$2,'https://example.test','official_website',false)`,[lead.id,email]);
      await addSuppression(email);
    } else if(kind==='reply') await message(null,lead.conversationId,'inbound',daysAgo(1),daysAgo(100));
    else await db.query(`UPDATE prospects SET status=$1 WHERE id=$2`,[kind,lead.id]);
    expect((await save(lead.id)).refused).toBe(1);
    expect((await listFollowUpCandidates()).some(c=>c.prospectId===lead.id)).toBe(false);
  });
  it.each(['do_not_contact','follow_up_excluded','suppression','reply','recipient'])("final INSERT snapshot refuses a late %s mutation after the initial transaction check",async(kind)=>{
    const lead=await seed();
    const transaction=db.transaction.bind(db);
    // Inject at the exact boundary before the INSERT executes, using the supplied tx rather than
    // the root client (a root-client query while PGlite owns the tx would deadlock).
    vi.spyOn(db,'transaction').mockImplementationOnce((fn)=>transaction(async(tx)=>{
      const query=tx.query.bind(tx);
      let injected=false;
      tx.query=async <T>(sql:string,params?:unknown[])=>{
        if(!injected && sql.startsWith('WITH eligible AS')) {
          injected=true;
          if(kind==='do_not_contact'||kind==='follow_up_excluded') await query(`UPDATE prospects SET ${kind}=true WHERE id=$1`,[lead.id]);
          else if(kind==='suppression') {
            const id=crypto.randomUUID(); suppressions.push(id);
            await query(`INSERT INTO suppressions (id,email,normalized_email,reason,source,active) VALUES ($1,$2,$2,'manual','founder',true)`,[id,lead.email]);
          } else if(kind==='reply') await query(`INSERT INTO messages (id,conversation_id,direction,source,from_email,received_at)
            VALUES (gen_random_uuid(),$1,'inbound','imap','fixture@example.test',now())`,[lead.conversationId]);
          else await query(`UPDATE prospect_emails SET email=$1,normalized_email=$1 WHERE prospect_id=$2`,[`changed-${lead.email}`,lead.id]);
        }
        return query<T>(sql,params);
      };
      return fn(tx);
    }));
    expect((await save(lead.id)).results[0]).toMatchObject({status:'refused',code:'eligibility_changed'});
    expect((await db.query(`SELECT id FROM drafts WHERE kind='follow_up' AND prospect_id=$1`,[lead.id])).rows).toHaveLength(0);
    expect((await db.query(`SELECT id FROM audit_log WHERE metadata->>'prospectId'=$1`,[lead.id])).rows).toHaveLength(0);
  });
  it("ignores inactive suppression and takes the current stored recipient rather than stale listing data",async()=>{
    const lead=await seed(); await addSuppression(lead.email,false); await listFollowUpCandidates();
    const email=`changed-${lead.email}`;
    await db.query(`UPDATE prospect_emails SET email=$1,normalized_email=$1 WHERE prospect_id=$2`,[email,lead.id]);
    const result=await save(lead.id);expect(result.saved).toBe(1);
    expect((await db.query(`SELECT recipient_email FROM drafts WHERE id=$1`,[result.results[0]!.draftId])).rows[0]!.recipient_email).toBe(email);
  });
  // Founder rule (7 Nov 2026): no follow-up for a lead whose real reply was already answered — however
  // old the reply, and whether its import time or its message date is the one stored.
  it.each([false,true])("an old, freshly imported real reply that was answered stops follow-ups (fallback timestamp=%s)",async(fallback)=>{
    const lead=await seed();await message(null,lead.conversationId,'inbound',daysAgo(30),daysAgo(0),fallback);
    expect((await save(lead.id)).results[0]).toMatchObject({status:'refused',code:'not_eligible'});
    expect((await db.query(`SELECT id FROM drafts WHERE kind='follow_up' AND prospect_id=$1`,[lead.id])).rows).toHaveLength(0);
  });
  it.each([false,true])("uses latest outbound actual timestamp, including own rows without conversation (fallback timestamp=%s)",async(fallback)=>{
    const lead=await seed();await message(lead.id,null,'outbound',daysAgo(0),daysAgo(100),fallback);
    const candidate=(await listFollowUpCandidates()).find(c=>c.prospectId===lead.id)!;
    expect(candidate.due).toBe(false);expect((await save(lead.id)).results[0]!.code).toBe('not_due');
  });
  it("counts null-prospect messages through conversation, and old imported outbound does not reset the delay",async()=>{
    const lead=await seed();await message(null,lead.conversationId,'outbound',daysAgo(20),daysAgo(0));
    expect((await save(lead.id)).saved).toBe(1);
  });
  it("newer actual sent drafts beat older outbound message rows, not cached imports",async()=>{
    const lead=await seed();
    await message(null,lead.conversationId,'outbound',daysAgo(20));
    await db.query(`UPDATE drafts SET sent_at=$1 WHERE prospect_id=$2 AND kind='first_contact'`,[daysAgo(0),lead.id]);
    await db.query(`UPDATE conversations SET last_outbound_at=$1 WHERE id=$2`,[daysAgo(100),lead.conversationId]);
    expect((await listFollowUpCandidates()).find(c=>c.prospectId===lead.id)!.due).toBe(false);
    expect((await save(lead.id)).results[0]!.code).toBe('not_due');
  });
  it("checks own inbound messages even when linked to a different conversation",async()=>{
    const a=await seed(),b=await seed();
    await message(a.id,b.conversationId,'inbound',daysAgo(1),daysAgo(100));
    expect((await save(a.id)).refused).toBe(1);
    expect((await save(b.id)).refused).toBe(1);
  });
  it("rechecks maximum and second delay after the list, and does not create a third sequence",async()=>{
    const lead=await seed(); const first=await save(lead.id);
    await db.query(`UPDATE drafts SET status='sent',sent_at=$1 WHERE id=$2`,[daysAgo(1),first.results[0]!.draftId]);
    expect((await saveAgentFollowUpDrafts({drafts:[draftInput(lead.id,2)],actor})).results[0]!.code).toBe('not_due');
    await db.query(`UPDATE drafts SET sent_at=$1 WHERE id=$2`,[daysAgo(10),first.results[0]!.draftId]);
    expect((await listFollowUpCandidates()).find(c=>c.prospectId===lead.id)!.nextSequence).toBe(2);
    await db.query(`UPDATE workspace_settings SET follow_up_max=1 WHERE id='default'`);
    expect((await saveAgentFollowUpDrafts({drafts:[draftInput(lead.id,2)],actor})).refused).toBe(1);
    await db.query(`UPDATE workspace_settings SET follow_up_max=2 WHERE id='default'`);
    const second=await saveAgentFollowUpDrafts({drafts:[draftInput(lead.id,2)],actor});expect(second.saved).toBe(1);
    await db.query(`UPDATE drafts SET status='sent',sent_at=$1 WHERE id=$2`,[daysAgo(10),second.results[0]!.draftId]);
    expect((await listFollowUpCandidates()).some(c=>c.prospectId===lead.id)).toBe(false);
  });
  it("refuses a stale expected sequence, honours final delay/max changes, and permits valid sequence two",async()=>{
    const lead=await seed();expect((await saveAgentFollowUpDrafts({drafts:[draftInput(lead.id,2)],actor})).results[0]!.code).toBe('stale_sequence');
    await db.query(`UPDATE workspace_settings SET follow_up_delay_1_days=30 WHERE id='default'`);
    expect((await save(lead.id)).results[0]!.code).toBe('not_due');
    await db.query(`UPDATE workspace_settings SET follow_up_delay_1_days=4,follow_up_max=0 WHERE id='default'`);
    expect((await save(lead.id)).refused).toBe(1);
    await db.query(`UPDATE workspace_settings SET follow_up_max=2 WHERE id='default'`);
    const first=await save(lead.id);await db.query(`UPDATE drafts SET status='sent',sent_at=$1 WHERE id=$2`,[daysAgo(10),first.results[0]!.draftId]);
    const second=await saveAgentFollowUpDrafts({drafts:[draftInput(lead.id,2)],actor});expect(second.saved).toBe(1);
    expect((await db.query(`SELECT sequence FROM drafts WHERE id=$1`,[second.results[0]!.draftId])).rows[0]!.sequence).toBe(2);
  });
  it("rechecks a reply received during founder generation and the scheduler switch",async()=>{
    const lead=await seed();
    vi.mocked(generateFollowUp).mockImplementationOnce(async()=>{
      await message(null,lead.conversationId,'inbound',daysAgo(0));
      return {subject:'Founder follow-up',body:'Would a discussion be useful for your team?',usedAi:false,model:'fixture'};
    });
    expect((await prepareFollowUpDraftOutcome({userId,prospectIds:[lead.id],trigger:'founder'})).drafts).toHaveLength(0);
    expect((await prepareFollowUpDraftOutcome({userId})).reason).toMatch(/switched off/);
  });
});

describe("strict bounded batch validation",()=>{
  it("rejects unknown fields, addresses, duplicate IDs, invalid text/sequence, empty and >50 batches before saving anything",async()=>{
    const lead=await seed(), valid=draftInput(lead.id);
    const invalid:unknown[]=[
      {drafts:[],actor}, {drafts:Array.from({length:51},()=>valid),actor}, {drafts:[valid,valid],actor},
      {drafts:[valid],actor,force:true}, {drafts:[{...valid,recipientEmail:'elsewhere@example.test'}],actor},
      {drafts:[valid],actor:{...actor,actorUserId:userId}}, {drafts:[valid],actor:{actorType:'founder'}},
      {drafts:[valid],actor:{...actor,sourceChannel:'founder'}}, {drafts:[valid],actor:{...actor,sourceAgent:'founder'}},
      ...[0,3,1.5].map(expectedSequence=>({drafts:[{...valid,expectedSequence}],actor})),
      ...['x','x'.repeat(201)].map(subject=>({drafts:[{...valid,subject}],actor})),
      ...['short','x'.repeat(20001)].map(body=>({drafts:[{...valid,body}],actor})),
      {drafts:[{...valid,prospectId:'bad-id'}],actor},
    ];
    for(const input of invalid) await expect(saveAgentFollowUpDrafts(input as Parameters<typeof saveAgentFollowUpDrafts>[0])).rejects.toMatchObject({code:'invalid_follow_up_batch'});
    expect((await db.query(`SELECT id FROM drafts WHERE kind='follow_up' AND prospect_id=$1`,[lead.id])).rows).toHaveLength(0);
  });
  it("accepts the exact 50-item boundary and returns safe per-prospect refusals for unknown leads",async()=>{
    const drafts=Array.from({length:50},()=>draftInput(crypto.randomUUID()));
    const result=await saveAgentFollowUpDrafts({drafts,actor});
    expect(result).toMatchObject({saved:0,preserved:0,refused:50});expect(result.results).toHaveLength(50);
    expect(result.results.every(r=>r.code==='not_eligible')).toBe(true);
  });
  it("mixed batches report each verdict and totals without exposing draft content",async()=>{
    const a=await seed(),b=await seed(),c=await seed();await save(b.id);
    await db.query(`UPDATE prospects SET do_not_contact=true WHERE id=$1`,[c.id]);
    const result=await save(a.id,b.id,c.id);
    expect(result).toMatchObject({saved:1,preserved:1,refused:1});
    expect(result.results.map(r=>r.status)).toEqual(['saved','preserved','refused']);
    expect(result.results.every(r=>Object.keys(r).every(k=>['prospectId','status','draftId','code','reason'].includes(k)))).toBe(true);
  });
});
