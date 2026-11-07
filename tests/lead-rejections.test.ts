import { afterAll, beforeAll, expect, it } from "vitest";
import { getDb, closeDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { saveProspect } from "@/lib/services/prospects";
import { classifyReply } from "@/lib/email/classify";
import { applyInboundEffect } from "@/lib/email/sync";
import { recordOfferRejection, latestOfferRejection } from "@/lib/services/lead-rejections";
import { listFollowUpCandidates } from "@/lib/services/followups";

const ids: string[] = [];
beforeAll(ensureWorkspaceDefaults);
afterAll(async () => {
  const db=await getDb();
  for(const table of ["prospect_rejection_recommendations","suppressions","messages","conversations","drafts","prospect_emails","prospect_sources","prospect_aliases"]) await db.query(`DELETE FROM ${table} WHERE prospect_id=ANY($1::uuid[])`,[ids]);
  await db.query("DELETE FROM prospects WHERE id=ANY($1::uuid[])",[ids]); await closeDb();
});
async function fixture(body: string) {
  const key=crypto.randomUUID().replaceAll("-",""); const email=`owner@${key}.example.test`;
  const saved=await saveProspect({ businessName:`Rejection fixture ${key}`,websiteUrl:`https://${key}.example.test`,categories:["crypto"],qualificationStatus:"candidate",email,emailSourceUrl:`https://${key}.example.test/contact`,actorType:"seed" });
  const id=saved.prospect.id; ids.push(id); const db=await getDb();
  await db.query("UPDATE prospects SET status='contacted',founder_notes='Preserve founder note' WHERE id=$1",[id]);
  const conversationId=crypto.randomUUID(),messageId=crypto.randomUUID(),draftId=crypto.randomUUID(); const receivedAt=new Date().toISOString();
  await db.query("INSERT INTO conversations (id,prospect_id,subject) VALUES ($1,$2,'Nomeriq question')",[conversationId,id]);
  await db.query(`INSERT INTO messages (id,prospect_id,conversation_id,direction,source,from_email,to_emails,subject,body_text,received_at)
    VALUES ($1,$2,$3,'inbound','imap',$4,'["founder@example.test"]','Re: Nomeriq question',$5,$6)`,[messageId,id,conversationId,email,body,receivedAt]);
  await db.query("INSERT INTO drafts (id,prospect_id,kind,sequence,status,subject,body,recipient_email) VALUES ($1,$2,'follow_up',1,'approved','Follow-up','Existing approved sequence message',$3)",[draftId,id,email]);
  return {id,conversationId,messageId,receivedAt,body,draftId,email};
}
it("CryptoAI Signal regression: explicit platform/partnership rejection recommends Lost, without setting Lost or unsubscribing",async()=>{
  // Synthetic reproduction of the rejection class, not a fabricated quote from the actual archive.
  const f=await fixture("We have our own platform and do not want new partnerships or integrations. Thanks.");
  expect(classifyReply(f.body).classification).toBe("not_interested");
  await applyInboundEffect(f.conversationId,f.id,f.body,"Re: Nomeriq question",f.receivedAt,f.messageId);
  const db=await getDb();
  expect((await db.query("SELECT status,do_not_contact,follow_up_excluded,founder_notes FROM prospects WHERE id=$1",[f.id])).rows[0]).toMatchObject({status:"replied",do_not_contact:false,follow_up_excluded:false,founder_notes:"Preserve founder note"});
  expect((await db.query("SELECT id FROM suppressions WHERE prospect_id=$1",[f.id])).rows).toHaveLength(0);
  const recommendation=await latestOfferRejection(f.id); expect(recommendation?.objection).toBe(f.body); expect(recommendation?.reason).toContain("founder confirmation");
  expect((await db.query<{body_text:string}>("SELECT body_text FROM messages WHERE id=$1",[f.messageId])).rows[0].body_text).toBe(f.body);
  expect((await db.query<{status:string}>("SELECT status FROM drafts WHERE id=$1",[f.draftId])).rows[0].status).toBe("cancelled");
  expect((await listFollowUpCandidates()).some(c=>c.prospectId===f.id)).toBe(false);
});
it("a real opt-out still suppresses contact, and quoted rejection does not turn a normal response into an opt-out",async()=>{
  const f=await fixture("Stop emailing us. Unsubscribe.");
  await applyInboundEffect(f.conversationId,f.id,f.body,"Re: Nomeriq question",f.receivedAt,f.messageId);
  const db=await getDb(); expect((await db.query("SELECT do_not_contact FROM prospects WHERE id=$1",[f.id])).rows[0]).toMatchObject({do_not_contact:true});
  expect((await db.query("SELECT reason,active FROM suppressions WHERE prospect_id=$1",[f.id])).rows[0]).toMatchObject({reason:"unsubscribe",active:true});
  expect(await latestOfferRejection(f.id)).toBeNull();
  expect(classifyReply("Could you show a demo?\nOn yesterday somebody wrote:\nWe do not want new partnerships.").classification).toBe("demo");
});
it("replaying a rejection is idempotent and never removes an existing suppression or founder hold",async()=>{
  const f=await fixture("We are not looking for new platforms."); const db=await getDb();
  await db.query("UPDATE prospects SET follow_up_excluded=true WHERE id=$1",[f.id]);
  await db.query("INSERT INTO suppressions (id,normalized_email,email,reason,source,prospect_id) VALUES ($1,$2,$2,'opt_out','founder',$3)",[crypto.randomUUID(),f.email,f.id]);
  await db.transaction(tx=>recordOfferRejection(tx,f.id,f.messageId)); await db.transaction(tx=>recordOfferRejection(tx,f.id,f.messageId));
  expect((await db.query("SELECT id FROM prospect_rejection_recommendations WHERE prospect_id=$1",[f.id])).rows).toHaveLength(1);
  expect((await db.query("SELECT active FROM suppressions WHERE prospect_id=$1",[f.id])).rows[0]).toMatchObject({active:true});
  expect((await db.query("SELECT follow_up_excluded FROM prospects WHERE id=$1",[f.id])).rows[0]).toMatchObject({follow_up_excluded:true});
});
it("an older rejection is recorded despite newer thread activity; automatic and delivery-report messages are not objections",async()=>{
  const f=await fixture("Not interested in integrations."); const db=await getDb();
  await db.query("UPDATE conversations SET last_message_at=now()+interval '1 day' WHERE id=$1",[f.conversationId]);
  await db.query("UPDATE prospects SET status='demo' WHERE id=$1",[f.id]);
  await applyInboundEffect(f.conversationId,f.id,f.body,"Re: Nomeriq question",f.receivedAt,f.messageId);
  expect(await latestOfferRejection(f.id)).not.toBeNull();
  expect((await db.query("SELECT status FROM prospects WHERE id=$1",[f.id])).rows[0]).toMatchObject({status:"demo"});
  const auto=await fixture("Not interested.");
  await db.query(`UPDATE messages SET raw_headers='{"autoReply":true}'::jsonb WHERE id=$1`,[auto.messageId]);
  expect(await db.transaction(tx=>recordOfferRejection(tx,auto.id,auto.messageId))).toBe(false);
  expect(await latestOfferRejection(auto.id)).toBeNull();
});
