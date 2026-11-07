import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { getFolderInbox } from "@/lib/services/inbox";
import { folderFor } from "@/lib/services/folders";
import { getPipelineCards } from "@/lib/services/pipeline";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

const ids: string[] = [];
const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`;
beforeAll(async () => { await ensureWorkspaceDefaults(); });
afterAll(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM audit_log WHERE entity_id = ANY($1::text[])`, [ids]);
  for (const table of ['messages', 'conversations', 'suppressions', 'prospect_emails']) {
    await db.query(`DELETE FROM ${table} WHERE prospect_id = ANY($1::uuid[])`, [ids]);
  }
  await db.query(`DELETE FROM prospects WHERE id = ANY($1::uuid[])`, [ids]);
});
async function lead() {
  const db = await getDb();
  const id = crypto.randomUUID(); ids.push(id);
  await db.query(`INSERT INTO prospects (id, business_name, name_key, status, qualification_status, created_by_type)
    VALUES ($1,$2,$2,'contacted','verified','founder')`, [id, `mailbox-folders-${id}`]);
  const cid = crypto.randomUUID();
  await db.query(`INSERT INTO conversations (id, prospect_id, subject, last_inbound_at, last_outbound_at)
    VALUES ($1,$2,'Fixture', $3, $4)`, [cid,id,at(30),at(29)]);
  return { id, cid };
}
async function address(id: string, key: string, reason?: string) {
  const db = await getDb(); const eid = crypto.randomUUID();
  const email = `${key}-${id}@mailbox-folders.example.test`;
  await db.query(`INSERT INTO prospect_emails (id,prospect_id,email,normalized_email,source_type,source_url,is_primary)
    VALUES ($1,$2,$3,$3,'official_website','https://example.test', $4)`, [eid,id,email,key === 'primary']);
  if (reason) await db.query(`INSERT INTO suppressions (id, prospect_id,email,normalized_email,reason)
    VALUES (gen_random_uuid(),$1,$2,$2,$3)`, [id,email,reason]);
  return eid;
}
async function message(l: {id: string; cid: string}, direction: string, day: number, options: {source?: string; flag?: string; delivery?: string} = {}) {
  const db = await getDb();
  await db.query(`INSERT INTO messages (id,prospect_id,conversation_id,direction,source,from_email,subject,snippet,body_text,sent_at,received_at,raw_headers,delivery_status)
    VALUES (gen_random_uuid(),$1,$2,$3,$4,'human@example.test','Fixture',$5,$5,$6,$7,$8::jsonb,$9)`,
  [l.id,l.cid,direction,options.source ?? 'imap',`${direction}-${day}`,direction === 'outbound' ? at(day) : null,
    direction === 'inbound' ? at(day) : null,JSON.stringify(options.flag ? {[options.flag]:true} : {}),options.delivery ?? 'accepted']);
}
async function projections(id: string) {
  const inbox = await getFolderInbox({focus:id, countsOnly:false});
  const card = (await getPipelineCards()).find(c => c.prospectId === id)!;
  expect(inbox.focused).not.toBeNull(); expect(card).toBeDefined();
  return {row:inbox.focused!, card};
}
describe('recovered mailbox folder and pipeline facts', () => {
  it('answered real replies are In conversation regardless of webmail origin, still Engaged and never follow-up due', async () => {
    const l = await lead(); await message(l,'inbound',17); await message(l,'outbound',24);
    const {row,card} = await projections(l.id);
    expect(row.folder).toBe('in_conversation'); expect(row.lastInboundAt).toBe(at(17)); expect(row.lastOutboundAt).toBe(at(24));
    expect(card.column).toBe('engaged'); expect(card.replyWaitingSince).toBeNull(); expect(card.followUpDue).toBe(false);
    expect(card.followUpLine).toBe('Stopped: they replied');
  });
  it('a genuine later inbound is Needs reply', async () => {
    const l = await lead(); await message(l,'outbound',24); await message(l,'inbound',25);
    const {row,card} = await projections(l.id);
    expect(row.folder).toBe('needs_reply'); expect(card.replyWaitingSince).toBe(at(25));
  });
  it.each(['deliveryReport','autoReply'])('later %s does not change In conversation or the snippet', async flag => {
    const l = await lead(); await message(l,'inbound',17); await message(l,'outbound',24); await message(l,'inbound',28,{flag});
    const {row,card} = await projections(l.id);
    expect(row.folder).toBe('in_conversation'); expect(row.snippet).toBe('outbound-24'); expect(row.lastActivityAt).toBe(at(24));
    expect(card.replyWaitingSince).toBeNull(); expect(card.followUpDue).toBe(false);
  });
  it.each(['failed','bounced','uncertain'])('%s outbound cannot fake an answer', async delivery => {
    const l = await lead(); await message(l,'inbound',17); await message(l,'outbound',24,{delivery});
    expect((await projections(l.id)).row.folder).toBe('needs_reply');
  });
  it.each(['smtp','imap'])('the same answered-reply rule applies to %s', async source => {
    const l = await lead(); await message(l,'inbound',17); await message(l,'outbound',24,{source});
    expect((await projections(l.id)).row.folder).toBe('in_conversation');
  });
  it.each(['smtp','imap'])('a lead who never replied stays Waiting after a %s send', async source => {
    const l = await lead(); await message(l,'outbound',24,{source});
    expect((await projections(l.id)).row.folder).toBe('waiting');
  });
  it('preserves explicit stages and founder holds', () => {
    const facts = {lastInboundAt:at(17),lastOutboundAt:at(24),hasReplied:true};
    for (const [status,folder] of [['interested','in_conversation'],['demo','meeting'],['proposal','meeting'],['won','won'],['lost','closed_lost']]) {
      expect(folderFor({...facts,status})).toBe(folder);
    }
    expect(folderFor({...facts,status:'contacted',doNotContact:true})).toBe('on_hold');
  });
  it('only dead address projects Failed and Closed', async () => {
    const l = await lead(); await address(l.id,'primary','bounce');
    const {row,card} = await projections(l.id); expect(row.folder).toBe('failed'); expect(card.column).toBe('closed');
  });
  it('bounced primary with healthy linked alternate is not whole-lead failed', async () => {
    const l = await lead(); await address(l.id,'primary','bounce'); await address(l.id,'alternate');
    const {row,card} = await projections(l.id); expect(row.suppressionReason).toBeNull(); expect(row.folder).not.toBe('failed'); expect(card.column).not.toBe('closed');
  });
  it('opted-out alias beats a healthy alternate', async () => {
    const l = await lead(); await address(l.id,'primary','unsubscribe'); await address(l.id,'alternate');
    const {row,card} = await projections(l.id); expect(row.folder).toBe('opted_out'); expect(card.column).toBe('closed');
  });
  it('prospect-level manual suppression is absolute without an address match', async () => {
    const l = await lead(); await address(l.id,'primary');
    const db = await getDb();
    await db.query(`INSERT INTO suppressions(id,prospect_id,email,normalized_email,reason) VALUES(gen_random_uuid(),$1,'elsewhere@example.test','elsewhere@example.test','manual')`,[l.id]);
    expect((await projections(l.id)).row.folder).toBe('on_hold');
  });
  it('founder-unlinked healthy alternate cannot rescue a bounced address', async () => {
    const l = await lead(); await address(l.id,'primary','bounce'); const eid = await address(l.id,'alternate');
    const db = await getDb();
    await db.query(`INSERT INTO audit_log(id,actor_type,action,entity_type,entity_id,metadata)
      VALUES(gen_random_uuid(),'founder','lead.email_unlinked','prospect',$1,$2::jsonb)`,[l.id,JSON.stringify({emailRowId:eid})]);
    expect((await projections(l.id)).row.folder).toBe('failed');
  });
  it('a report-only thread cannot manufacture engagement from stale replied status or cached clocks', async () => {
    const l = await lead(); await message(l,'inbound',28,{flag:'deliveryReport'});
    const db = await getDb(); await db.query(`UPDATE prospects SET status = 'replied' WHERE id = $1`,[l.id]);
    const {row,card} = await projections(l.id);
    expect(row.lastInboundAt).toBeNull(); expect(row.snippet).toBeNull();
    expect(row.folder).toBe('new_leads'); expect(card.column).toBe('research');
  });
  it('latest founder link decision restores eligibility without clearing the primary bounce', async () => {
    const l = await lead(); await address(l.id,'primary','bounce'); const eid = await address(l.id,'alternate');
    const db = await getDb();
    for (const [action,day] of [['lead.email_unlinked',17],['lead.email_linked',24]] as const) {
      await db.query(`INSERT INTO audit_log(id,actor_type,action,entity_type,entity_id,metadata,created_at)
        VALUES(gen_random_uuid(),'founder',$1,'prospect',$2,$3::jsonb,$4)`,[action,l.id,JSON.stringify({emailRowId:eid}),at(day)]);
    }
    expect((await projections(l.id)).row.suppressionReason).toBeNull();
    expect((await db.query(`SELECT 1 FROM suppressions WHERE prospect_id = $1 AND reason = 'bounce' AND active = true`,[l.id])).rows).toHaveLength(1);
  });
});
