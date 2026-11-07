import { afterAll, beforeAll, expect, it } from "vitest";
import { getDb, closeDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { saveProspect } from "@/lib/services/prospects";
import { classifyReply } from "@/lib/email/classify";
import { applyInboundEffect } from "@/lib/email/sync";
import { recordOfferRejection, latestOfferRejection } from "@/lib/services/lead-rejections";
import { listFollowUpCandidates } from "@/lib/services/followups";
import { sendDraft } from "@/lib/services/email-sending";
import { getRecipientPolicy } from "@/lib/services/recipient-policy";

const ids: string[] = [];
beforeAll(ensureWorkspaceDefaults);
afterAll(async () => {
  const db=await getDb();
  for(const table of ["outbound_sends","prospect_rejection_recommendations","suppressions","messages","conversations","drafts","prospect_emails","prospect_sources","prospect_aliases"]) await db.query(`DELETE FROM ${table} WHERE prospect_id=ANY($1::uuid[])`,[ids]);
  await db.query("DELETE FROM audit_log WHERE entity_type='prospect' AND entity_id=ANY($1::text[])",[ids]);
  await db.query("DELETE FROM prospects WHERE id=ANY($1::uuid[])",[ids]); await closeDb();
});
async function fixture(body: string) {
  const key=crypto.randomUUID().replaceAll("-",""); const email=`owner@${key}.example.test`;
  const saved=await saveProspect({ businessName:`Rejection fixture ${key}`,websiteUrl:`https://${key}.example.test`,categories:["crypto"],qualificationStatus:"candidate",email,emailSourceUrl:`https://${key}.example.test/contact`,actorType:"seed" });
  const id=saved.prospect.id; ids.push(id); const db=await getDb();
  await db.query("UPDATE prospects SET status='contacted',founder_notes='Preserve founder note' WHERE id=$1",[id]);
  const conversationId=crypto.randomUUID(),messageId=crypto.randomUUID(),draftId=crypto.randomUUID(),firstContactDraftId=crypto.randomUUID(); const receivedAt=new Date().toISOString();
  await db.query("INSERT INTO conversations (id,prospect_id,subject) VALUES ($1,$2,'Nomeriq question')",[conversationId,id]);
  await db.query(`INSERT INTO messages (id,prospect_id,conversation_id,direction,source,from_email,to_emails,subject,body_text,received_at)
    VALUES ($1,$2,$3,'inbound','imap',$4,'["founder@example.test"]','Re: Nomeriq question',$5,$6)`,[messageId,id,conversationId,email,body,receivedAt]);
  await db.query("INSERT INTO drafts (id,prospect_id,kind,sequence,status,subject,body,recipient_email) VALUES ($1,$2,'follow_up',1,'approved','Follow-up','Existing approved sequence message',$3)",[draftId,id,email]);
  // A first-contact (non-follow-up) draft: the hold must block a hand send here too, not only the
  // automatic follow-up path.
  await db.query("INSERT INTO drafts (id,prospect_id,kind,sequence,status,subject,body,recipient_email) VALUES ($1,$2,'first_contact',0,'approved','Hello','A complete hand-written message, not a follow-up.',$3)",[firstContactDraftId,id,email]);
  return {id,conversationId,messageId,receivedAt,body,draftId,firstContactDraftId,email};
}
it("CryptoAI Signal regression: explicit platform/partnership rejection recommends Lost, keeps the founder's hard hold, and blocks a hand send",async()=>{
  // Synthetic reproduction of the rejection class, not a fabricated quote from the actual archive.
  const f=await fixture("We have our own platform and do not want new partnerships or integrations. Thanks.");
  expect(classifyReply(f.body).classification).toBe("not_interested");
  await applyInboundEffect(f.conversationId,f.id,f.body,"Re: Nomeriq question",f.receivedAt,f.messageId);
  const db=await getDb();
  // Founder decision (7 Nov 2026): an ordinary offer rejection stays a hard send block — do_not_contact —
  // same strength as an opt-out, until the founder clears it. It is not relabelled a formal
  // unsubscribe/opt-out: no suppression row, no automatic Lost.
  expect((await db.query("SELECT status,do_not_contact,follow_up_excluded,founder_notes FROM prospects WHERE id=$1",[f.id])).rows[0]).toMatchObject({status:"replied",do_not_contact:true,follow_up_excluded:false,founder_notes:"Preserve founder note"});
  expect((await db.query("SELECT id FROM suppressions WHERE prospect_id=$1",[f.id])).rows).toHaveLength(0);
  const recommendation=await latestOfferRejection(f.id); expect(recommendation?.objection).toBe(f.body); expect(recommendation?.reason).toContain("founder confirmation");
  expect((await db.query<{body_text:string}>("SELECT body_text FROM messages WHERE id=$1",[f.messageId])).rows[0].body_text).toBe(f.body);
  expect((await db.query<{status:string}>("SELECT status FROM drafts WHERE id=$1",[f.draftId])).rows[0].status).toBe("cancelled");
  expect((await listFollowUpCandidates()).some(c=>c.prospectId===f.id)).toBe(false);
  // The regression itself: a hand-typed send to a first-contact draft, not a follow-up, must still
  // be refused by the real send gate — not merely by a recommendation row nothing else reads.
  expect((await getRecipientPolicy(f.id)).blocked).toBe(true);
  await expect(sendDraft({ draftId: f.firstContactDraftId, actorUserId: crypto.randomUUID(), allowFounderRecipient: true })).rejects.toMatchObject({ code: "do_not_contact" });
  expect((await db.query<{status:string}>("SELECT status FROM drafts WHERE id=$1",[f.firstContactDraftId])).rows[0].status).toBe("approved");
  expect((await db.query("SELECT id FROM outbound_sends WHERE draft_id=$1",[f.firstContactDraftId])).rows).toHaveLength(0);
  // The overwritten prior values (do_not_contact, next_action) and the cancelled follow-up draft's
  // prior status are both recorded, so this is undoable without restoring a backup.
  const holdAudit=(await db.query<{metadata:Record<string,unknown>}>("SELECT metadata FROM audit_log WHERE action='lead.rejection_hold_set' AND entity_id=$1",[f.id])).rows[0];
  expect(holdAudit?.metadata).toMatchObject({ previousDoNotContact:false });
  const draftAudit=(await db.query<{metadata:Record<string,unknown>}>("SELECT metadata FROM audit_log WHERE action='draft.rejection_cancelled' AND entity_id=$1",[f.draftId])).rows[0];
  expect(draftAudit?.metadata).toMatchObject({ previousStatus:"approved" });
});
it("the founder's own doNotContact clear releases a rejection hold for the next hand send",async()=>{
  const f=await fixture("We have no need for this right now, but thanks.");
  await applyInboundEffect(f.conversationId,f.id,f.body,"Re: Nomeriq question",f.receivedAt,f.messageId);
  const db=await getDb();
  expect((await db.query("SELECT do_not_contact FROM prospects WHERE id=$1",[f.id])).rows[0]).toMatchObject({do_not_contact:true});
  await db.query("UPDATE prospects SET do_not_contact=false WHERE id=$1",[f.id]);
  // The specific hold is gone: the next refusal is unrelated (no sending profile configured in this
  // fixture), never the "do_not_contact" code this test exists to prove is released.
  await expect(sendDraft({ draftId: f.firstContactDraftId, actorUserId: crypto.randomUUID(), allowFounderRecipient: true })).rejects.not.toMatchObject({ code: "do_not_contact" });
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
  // Idempotent draft-cancel audit too: replaying never writes a second snapshot for the same draft.
  expect((await db.query("SELECT id FROM audit_log WHERE action='draft.rejection_cancelled' AND entity_id=$1",[f.draftId])).rows).toHaveLength(1);
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
