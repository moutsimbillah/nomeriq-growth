import { afterAll, beforeAll, expect, it } from "vitest";
import { getDb, closeDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { saveProspect } from "@/lib/services/prospects";
import { classifyReply } from "@/lib/email/classify";
import { applyInboundEffect, AUTO_OPT_OUT_ON_CLASSIFIED_UNSUBSCRIBE, SUSPECTED_OPT_OUT_NEXT_ACTION } from "@/lib/email/sync";
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
it("a rejection retains address-wide protection across shared-address leads and newly typed recipients",async()=>{
  const first=await fixture("Not interested in integrations.");
  const second=await fixture("A different business using the same generic contact.");
  const typed=await fixture("Another separate business.");
  const db=await getDb();
  // Founder rule (strict deduplication, migration 034): two different leads may no longer share a
  // role mailbox on one business domain; the database refuses it for review instead of storing it.
  const corporate=`info@${crypto.randomUUID()}.example.test`;
  await db.query("UPDATE prospect_emails SET email=$2,normalized_email=$2 WHERE prospect_id=$1",[first.id,corporate]);
  await expect(db.query("UPDATE prospect_emails SET email=$2,normalized_email=$2 WHERE prospect_id=$1",[second.id,corporate])).rejects.toMatchObject({code:"23505",constraint:"growth_identity_conflict"});
  // A role mailbox on a free-mail host is the shared address that can still sit on two leads, so the
  // address-wide rejection protection must still hold across them.
  const shared="info@fastmail.com";
  for(const f of [first,second]) {
    await db.query("UPDATE prospect_emails SET email=$2,normalized_email=$2 WHERE prospect_id=$1",[f.id,shared]);
    await db.query("UPDATE drafts SET recipient_email=$2 WHERE id=$1",[f.firstContactDraftId,shared]);
  }
  await db.query("UPDATE messages SET from_email=$2 WHERE id=$1",[first.messageId,shared]);
  await applyInboundEffect(first.conversationId,first.id,first.body,"Re: Nomeriq question",first.receivedAt,first.messageId);
  expect((await getRecipientPolicy(second.id)).blocked).toBe(true);
  await expect(sendDraft({draftId:second.firstContactDraftId,actorUserId:crypto.randomUUID(),allowFounderRecipient:true})).rejects.toMatchObject({code:"rejection_hold"});
  await db.query("UPDATE drafts SET recipient_email=$2 WHERE id=$1",[typed.firstContactDraftId,shared]);
  await expect(sendDraft({draftId:typed.firstContactDraftId,actorUserId:crypto.randomUUID(),allowFounderRecipient:true})).rejects.toMatchObject({code:"rejection_hold"});
  expect((await db.query("SELECT id FROM prospect_emails WHERE prospect_id=$1 AND normalized_email=$2",[typed.id,shared])).rows).toHaveLength(0);
  expect((await db.query("SELECT id FROM outbound_sends WHERE prospect_id=ANY($1::uuid[])",[[first.id,second.id,typed.id]])).rows).toHaveLength(0);
  // Only the founder clearing the original rejection hold releases its address-wide projection.
  await db.query("UPDATE prospects SET do_not_contact=false WHERE id=$1",[first.id]);
  expect((await getRecipientPolicy(second.id)).blocked).toBe(false);
});
// Founder decision (21 Nov 2026) replaced the detector's automatic opt-out with a review flag.
// This case used to assert the automatic behaviour — status='lost', do_not_contact=true and an
// 'unsubscribe' suppression. It now asserts the review behaviour instead.
it("a classified opt-out flags the prospect for review instead of suppressing contact automatically",async()=>{
  expect(AUTO_OPT_OUT_ON_CLASSIFIED_UNSUBSCRIBE).toBe(false); // default is flag-for-review
  const f=await fixture("Stop emailing us. Unsubscribe.");
  expect(classifyReply(f.body).classification).toBe("unsubscribe");
  await applyInboundEffect(f.conversationId,f.id,f.body,"Re: Nomeriq question",f.receivedAt,f.messageId);
  const db=await getDb();
  const prospect=(await db.query<{status:string;do_not_contact:boolean;next_action:string|null}>("SELECT status,do_not_contact,next_action FROM prospects WHERE id=$1",[f.id])).rows[0]!;
  // The marker is the only thing the detected opt-out writes.
  expect(prospect.next_action).toBe(SUSPECTED_OPT_OUT_NEXT_ACTION);
  // The reply still marks the lead replied; it is NOT closed and NOT marked do-not-contact.
  expect(prospect.status).toBe("replied");
  expect(prospect.do_not_contact).toBe(false);
  // Nothing is suppressed — not for this lead, not for the address.
  expect((await db.query("SELECT id FROM suppressions WHERE prospect_id=$1 OR normalized_email=lower($2)",[f.id,f.email])).rows).toHaveLength(0);
  // An unsubscribe is not an offer rejection, and quoted history still cannot turn a demo into an opt-out.
  expect(await latestOfferRejection(f.id)).toBeNull();
  expect(classifyReply("Could you show a demo?\nOn yesterday somebody wrote:\nWe do not want new partnerships.").classification).toBe("demo");
});
it("records the unsubscribe classification and journals the suspicion, so nothing happens silently",async()=>{
  const f=await fixture("Please remove me from your list.");
  expect(classifyReply(f.body).classification).toBe("unsubscribe");
  await applyInboundEffect(f.conversationId,f.id,f.body,"Re: Nomeriq question",f.receivedAt,f.messageId);
  const db=await getDb();
  // The message-level classification and confidence are still recorded on the conversation.
  const conversation=(await db.query<{classification:string;classification_source:string;classification_confidence:string}>("SELECT classification,classification_source,classification_confidence FROM conversations WHERE id=$1",[f.conversationId])).rows[0]!;
  expect(conversation.classification).toBe("unsubscribe");
  expect(conversation.classification_source).toBe("rules");
  expect(Number(conversation.classification_confidence)).toBeCloseTo(0.98,2);
  // The suspicion is journalled against the prospect, with the message it came from.
  const audit=(await db.query<{metadata:Record<string,unknown>}>("SELECT metadata FROM audit_log WHERE action='lead.opt_out_suspected' AND entity_type='prospect' AND entity_id=$1",[f.id])).rows;
  expect(audit).toHaveLength(1);
  expect(audit[0]!.metadata).toMatchObject({classification:"unsubscribe",confidence:0.98,messageId:f.messageId,reviewMarker:SUSPECTED_OPT_OUT_NEXT_ACTION});
});
it("the review flag is inert: it neither cancels queued follow-ups nor blocks a later send",async()=>{
  // The marker is a note for the founder, not a switch any gate reads. A lead carrying only the
  // marker — no suppression, no do_not_contact, no unsubscribe classification — stays a due
  // follow-up candidate and stays sendable, so flagging never silently removes a lead from work.
  const db=await getDb();
  const id=crypto.randomUUID(), conversationId=crypto.randomUUID(); const email=`owner@${crypto.randomUUID()}.example.test`; ids.push(id);
  const when=new Date(Date.now()-20*86400000).toISOString();
  await db.query("INSERT INTO prospects (id,business_name,name_key,status,created_by_type) VALUES ($1,$2,$3,'contacted','legacy')",[id,`Review flag fixture ${id}`,`review-flag-${id}`]);
  await db.query("INSERT INTO prospect_emails (id,prospect_id,email,normalized_email,source_url,source_type,is_primary) VALUES (gen_random_uuid(),$1,$2,$2,$3,'official_website',true)",[id,email,`https://${id}.example.test`]);
  await db.query("INSERT INTO conversations (id,prospect_id,subject,last_outbound_at) VALUES ($1,$2,'Original',$3)",[conversationId,id,when]);
  const draftId=crypto.randomUUID();
  await db.query("INSERT INTO drafts (id,prospect_id,kind,sequence,status,subject,body,recipient_email) VALUES ($1,$2,'first_contact',0,'approved','Hello','A complete hand-written message.',$3)",[draftId,id,email]);
  // Set exactly what a suspected opt-out now leaves behind — only the marker.
  await db.query("UPDATE prospects SET next_action=$2 WHERE id=$1",[id,SUSPECTED_OPT_OUT_NEXT_ACTION]);

  // (1) The marker does not cancel or exclude queued follow-up work.
  expect((await listFollowUpCandidates()).some(c=>c.prospectId===id)).toBe(true);
  // (2) The marker does not block a manual send: the lead is not suppressed and the send is not
  //     refused as an opt-out. (No account is configured here, so a refusal for another reason
  //     still proves the send gate never treated the marker as an opt-out.)
  expect((await getRecipientPolicy(id)).blocked).toBe(false);
  const outcome=await sendDraft({ draftId, actorUserId: crypto.randomUUID(), allowFounderRecipient: true }).then(()=>null,(e:{code?:string})=>e);
  expect(outcome?.code).not.toBe("do_not_contact");
  expect(outcome?.code).not.toBe("suppressed");
});
it("leaves the rest of the classification pipeline alone",async()=>{
  // The regex patterns and every other class are untouched by the review-flag change.
  expect(classifyReply("We're interested, tell me more.").classification).toBe("interested");
  expect(classifyReply("Can you show a demo?").classification).toBe("demo");
  expect(classifyReply("What does it cost?").classification).toBe("pricing");
  expect(classifyReply("Do you offer white-label?").classification).toBe("features");
  expect(classifyReply("What about your API?").classification).toBe("technical");
  expect(classifyReply("No thanks, not interested.").classification).toBe("not_interested");
  expect(classifyReply("Thanks for the note, I'll take a look.").classification).toBe("other");
  const db=await getDb();
  // An interested reply is still just a reply — no marker, no opt-out journal.
  const interested=await fixture("We're interested, tell me more.");
  await applyInboundEffect(interested.conversationId,interested.id,interested.body,"Re: Nomeriq question",interested.receivedAt,interested.messageId);
  expect((await db.query<{status:string;do_not_contact:boolean;next_action:string|null}>("SELECT status,do_not_contact,next_action FROM prospects WHERE id=$1",[interested.id])).rows[0]).toMatchObject({status:"replied",do_not_contact:false,next_action:"Read and respond to the reply"});
  expect((await db.query("SELECT 1 FROM audit_log WHERE action='lead.opt_out_suspected' AND entity_id=$1",[interested.id])).rows).toHaveLength(0);
  // A not_interested reply still takes the rejection-hold path, never the opt-out marker.
  const rejected=await fixture("No thanks, not interested.");
  await applyInboundEffect(rejected.conversationId,rejected.id,rejected.body,"Re: Nomeriq question",rejected.receivedAt,rejected.messageId);
  const rejectedProspect=(await db.query<{status:string;do_not_contact:boolean;next_action:string|null}>("SELECT status,do_not_contact,next_action FROM prospects WHERE id=$1",[rejected.id])).rows[0]!;
  expect(rejectedProspect.do_not_contact).toBe(true);
  expect(rejectedProspect.next_action).toContain("Review rejection");
  expect((await db.query("SELECT 1 FROM audit_log WHERE action='lead.opt_out_suspected' AND entity_id=$1",[rejected.id])).rows).toHaveLength(0);
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
  expect((await db.query("SELECT status,do_not_contact FROM prospects WHERE id=$1",[f.id])).rows[0]).toMatchObject({status:"demo",do_not_contact:true});
  expect((await getRecipientPolicy(f.id)).blocked).toBe(true);
  await expect(sendDraft({ draftId:f.firstContactDraftId, actorUserId:crypto.randomUUID(), allowFounderRecipient:true })).rejects.toMatchObject({code:"do_not_contact"});
  expect((await db.query("SELECT id FROM outbound_sends WHERE draft_id=$1",[f.firstContactDraftId])).rows).toHaveLength(0);
  await applyInboundEffect(f.conversationId,f.id,f.body,"Re: Nomeriq question",f.receivedAt,f.messageId);
  expect((await db.query("SELECT metadata FROM audit_log WHERE action='lead.rejection_hold_set' AND entity_id=$1",[f.id])).rows).toHaveLength(1);
  // A replay cannot silently overturn a founder's subsequent clear.
  await db.query("UPDATE prospects SET do_not_contact=false WHERE id=$1",[f.id]);
  await applyInboundEffect(f.conversationId,f.id,f.body,"Re: Nomeriq question",f.receivedAt,f.messageId);
  expect((await db.query("SELECT do_not_contact FROM prospects WHERE id=$1",[f.id])).rows[0]).toMatchObject({do_not_contact:false});
  const auto=await fixture("Not interested.");
  await db.query(`UPDATE messages SET raw_headers='{"autoReply":true}'::jsonb WHERE id=$1`,[auto.messageId]);
  expect(await db.transaction(tx=>recordOfferRejection(tx,auto.id,auto.messageId))).toBe(false);
  expect(await latestOfferRejection(auto.id)).toBeNull();
});
