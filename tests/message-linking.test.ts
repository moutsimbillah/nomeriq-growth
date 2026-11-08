import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '@/lib/db/client';
import { decideMessageLink, getMessageLinkSuggestions, mayAssociateMessage, associateCertainThreadAddress } from '@/lib/services/message-linking';
import { getRecipientPolicy } from '@/lib/services/recipient-policy';
import { getConversation } from '@/lib/services/conversations';
import * as session from '@/lib/auth/session';
import { AppError } from '@/lib/utils';
import { GET, POST } from '@/app/api/email/messages/[id]/link/route';

const leads: string[] = []; const messages: string[] = []; const addresses: string[] = []; const accounts: string[] = [];
async function lead() {
  const db = await getDb(); const id = crypto.randomUUID(); leads.push(id);
  await db.query(`INSERT INTO prospects (id, business_name, name_key, domain_key, created_by_type) VALUES ($1::uuid, $2, $1::text, $1::text, 'founder')`, [id, `Link fixture ${id}`]); return id;
}
async function message(email?: string, subject = 'Hello') {
  const db = await getDb(); const id = crypto.randomUUID(); messages.push(id);
  // A distinct sender domain per message: linking two different leads to one business email domain
  // is held for review under strict deduplication.
  const from = email ?? `person-${id}@${id}.link.test`; addresses.push(from);
  await db.query(`INSERT INTO messages (id, direction, source, from_email, subject, body_text, received_at) VALUES ($1, 'inbound', 'imap', $2, $3, 'Fixture message text', '2026-01-05')`, [id, from, subject]); return id;
}
afterAll(async () => {
  vi.restoreAllMocks(); const db = await getDb();
  await db.query(`DELETE FROM audit_log WHERE entity_id = ANY($1::text[]) OR entity_id = ANY($2::text[])`, [leads,messages]);
  await db.query(`DELETE FROM suppressions WHERE normalized_email = ANY($1::text[])`, [addresses]);
  await db.query(`DELETE FROM messages WHERE id = ANY($1::uuid[])`, [messages]);
  await db.query(`DELETE FROM conversations WHERE prospect_id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM prospect_emails WHERE prospect_id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM prospects WHERE id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM email_accounts WHERE id = ANY($1::uuid[])`, [accounts]); await closeDb();
});
describe('append-only founder message linking', () => {
  it('uses unique same-account thread evidence before hints; other-mailbox IDs and rejected associations do not match', async () => {
    const db = await getDb(); const p = await lead(); const other = await lead();
    // Synthetic account metadata only; no credentials or connections.
    for (let n = 0; n < 2; n++) {
      const id = crypto.randomUUID(); accounts.push(id);
      await db.query(`INSERT INTO email_accounts (id,name,provider,email_address,normalized_email,from_name,is_default)
        VALUES ($1,'Link fixture','sandbox',$2,$2,'Fixture',false)`, [id,`${id}@ours.link.test`]);
    }
    const a = accounts.at(-2)!; const b = accounts.at(-1)!;
    const threadId = `<${crypto.randomUUID()}@thread.test>`;
    const origin = await message(); await decideMessageLink(origin,{action:'link',prospectId:p},'fixture-founder');
    await db.query(`UPDATE messages SET account_id = $1, message_id = $2 WHERE id = $3`,[a,threadId,origin]);
    const second = await message(); await decideMessageLink(second,{action:'link',prospectId:other},'fixture-founder');
    await db.query(`UPDATE messages SET account_id = $1, message_id = $2 WHERE id = $3`,[b,threadId,second]);
    const reply = await message(); await db.query(`UPDATE messages SET account_id = $1, in_reply_to = $2 WHERE id = $3`,[a,threadId,reply]);
    const suggestions = await getMessageLinkSuggestions(reply);
    expect(suggestions.suggestions[0]).toMatchObject({id:p,reason:expect.stringContaining('Unique thread')});
    expect(suggestions.suggestions.some(s => s.id === other && s.reason.startsWith('Unique thread'))).toBe(false);
    expect((await getRecipientPolicy(p)).emails).toHaveLength(1);
    await decideMessageLink(reply,{action:'reject',prospectId:p},'fixture-founder');
    expect((await getMessageLinkSuggestions(reply)).suggestions.some(s => s.id === p)).toBe(false);
  });
  it('links real message and stores truthful founder evidence, never published research', async () => {
    const p = await lead(); const m = await message();
    const result = await decideMessageLink(m, {action:'link',prospectId:p}, 'fixture-founder');
    const db = await getDb();
    const email = (await db.query(`SELECT * FROM prospect_emails WHERE id = $1`,[result.emailRowId])).rows[0];
    expect(email).toMatchObject({ prospect_id:p, source_type:'founder_entered', source_url:`Linked by founder from message ${m}`, is_primary:false });
    const stored = (await db.query<{conversation_id:string}>(`SELECT conversation_id FROM messages WHERE id = $1`,[m])).rows[0];
    const conversation = await getConversation(stored.conversation_id);
    expect(conversation?.messages.find(row => row.id === m)?.addressLinkStatus).toBe(true);
    expect(conversation?.replyTo).toBe((email as {email:string}).email);
    const audit = (await db.query<{metadata:object}>(`SELECT metadata FROM audit_log WHERE entity_id = $1`,[m])).rows[0];
    expect(JSON.stringify(audit.metadata)).not.toContain('Fixture message text');
  });
  it('unlink retains message history, email evidence and suppressions; vetoes rematching until explicit relink', async () => {
    const p = await lead(); const m = await message(); const db = await getDb();
    const link = await decideMessageLink(m,{action:'link',prospectId:p},'fixture-founder');
    const email = (await getRecipientPolicy(p)).emails[0].email;
    await db.query(`INSERT INTO suppressions (id,normalized_email,email,reason,prospect_id) VALUES ($1,$2,$2,'opt_out',$3)`, [crypto.randomUUID(),email,p]);
    await decideMessageLink(m,{action:'unlink',prospectId:p,detachAddress:true},'fixture-founder');
    expect(await mayAssociateMessage(db,m,p)).toBe(false);
    expect((await db.query(`SELECT body_text FROM messages WHERE id = $1`,[m])).rows[0]).toEqual({body_text:'Fixture message text'});
    expect((await db.query(`SELECT 1 FROM prospect_emails WHERE id = $1`,[link.emailRowId])).rows).toHaveLength(1);
    expect((await getRecipientPolicy(p)).emails[0].linked).toBe(false);
    expect((await getRecipientPolicy(p)).blocked).toBe(true);
    await decideMessageLink(m,{action:'link',prospectId:p},'fixture-founder');
    expect(await mayAssociateMessage(db,m,p)).toBe(true); expect((await getRecipientPolicy(p)).blocked).toBe(true);
  });
  it('separates message unlink from address-book detach', async () => {
    const p = await lead(); const m = await message();
    await decideMessageLink(m,{action:'link',prospectId:p},'fixture-founder');
    await decideMessageLink(m,{action:'unlink',prospectId:p},'fixture-founder');
    expect((await getRecipientPolicy(p)).emails[0].linked).toBe(true);
    expect((await getRecipientPolicy(p)).recipient).toBeNull();
    const db = await getDb(); expect((await db.query<{last_inbound_at:unknown}>(`SELECT last_inbound_at FROM conversations WHERE prospect_id = $1`,[p])).rows[0].last_inbound_at).toBeNull();
  });
  it('Not this lead remains a negative decision without deleting or associating the message', async () => {
    const p = await lead(); const m = await message();
    await decideMessageLink(m,{action:'reject',prospectId:p},'fixture-founder');
    expect(await mayAssociateMessage(await getDb(),m,p)).toBe(false);
    expect((await getMessageLinkSuggestions(m)).currentProspectId).toBeNull();
  });
  it('refuses cross-lead message ownership instead of moving silently', async () => {
    const p = await lead(); const other = await lead(); const m = await message();
    await decideMessageLink(m,{action:'link',prospectId:p},'fixture-founder');
    await expect(decideMessageLink(m,{action:'link',prospectId:other},'fixture-founder')).rejects.toMatchObject({status:409,code:'ownership_conflict'});
  });
  it('refuses non-generic address ownership collisions with a 409', async () => {
    const key = crypto.randomUUID(); const p = await lead(); const other = await lead(); const email = `unique-${key}@${key}.link.test`;
    await decideMessageLink(await message(email),{action:'link',prospectId:p},'fixture-founder');
    const m = await message(email);
    await expect(decideMessageLink(m,{action:'link',prospectId:other},'fixture-founder')).rejects.toMatchObject({status:409,code:'address_conflict'});
    expect((await getMessageLinkSuggestions(m)).currentProspectId).toBeNull();
  });
  it('a role mailbox on one business domain is refused for a second lead even with confirmation', async () => {
    // Founder rule (strict deduplication, migration 034): the old "generic address may be shared"
    // allowance no longer lets two different leads own support@/info@ on one business domain.
    const p = await lead(); const other = await lead(); const email = `info@${crypto.randomUUID()}.link.test`;
    await decideMessageLink(await message(email),{action:'link',prospectId:p},'fixture-founder');
    const m = await message(email);
    await expect(decideMessageLink(m,{action:'link',prospectId:other},'fixture-founder')).rejects.toMatchObject({status:409,code:'shared_address_confirmation'});
    await expect(decideMessageLink(m,{action:'link',prospectId:other,confirmSharedAddress:true},'fixture-founder')).rejects.toMatchObject({status:409,code:'link_conflict'});
    const db = await getDb(); expect((await db.query(`SELECT DISTINCT prospect_id FROM prospect_emails WHERE normalized_email = $1`,[email])).rows).toEqual([{prospect_id:p}]);
    expect((await getMessageLinkSuggestions(m)).currentProspectId).toBeNull();
  });
  it('a free-mail role mailbox needs explicit confirmation and never merges leads', async () => {
    const p = await lead(); const other = await lead(); const email = 'contact@tuta.com';
    await decideMessageLink(await message(email),{action:'link',prospectId:p},'fixture-founder');
    const m = await message(email);
    await expect(decideMessageLink(m,{action:'link',prospectId:other},'fixture-founder')).rejects.toMatchObject({status:409,code:'shared_address_confirmation'});
    await decideMessageLink(m,{action:'link',prospectId:other,confirmSharedAddress:true},'fixture-founder');
    const db = await getDb(); expect((await db.query(`SELECT DISTINCT prospect_id FROM prospect_emails WHERE normalized_email = $1`,[email])).rows).toHaveLength(2);
  });
  it('excludes DSNs and OOO from suggestions/address-linking', async () => {
    const p = await lead();
    for (const m of [await message('mailer-daemon@link.test'),await message(undefined,'Out of office')]) {
      expect((await getMessageLinkSuggestions(m)).suggestions).toEqual([]);
      await expect(decideMessageLink(m,{action:'link',prospectId:p},'fixture-founder')).rejects.toMatchObject({status:409});
    }
  });
  it('read/search and default future-helper calls do not write associations', async () => {
    const p = await lead(); const m = await message();
    await getMessageLinkSuggestions(m, 'Link fixture');
    await expect(associateCertainThreadAddress(m,p,'fixture-founder')).rejects.toMatchObject({code:'approval_required'});
    expect((await getRecipientPolicy(p)).emails).toEqual([]);
  });
  it('thread ownership alone never claims the message address is linked', async () => {
    const p = await lead(); const m = await message(); const db = await getDb(); const c = crypto.randomUUID();
    await db.query(`INSERT INTO conversations (id,prospect_id,subject) VALUES ($1,$2,'Thread')`,[c,p]);
    await db.query(`UPDATE messages SET conversation_id = $1, prospect_id = $2 WHERE id = $3`,[c,p,m]);
    const conversation = await getConversation(c);
    expect(conversation?.messages[0].addressLinkStatus).toBe(false); expect(conversation?.sendable).toBe(false);
  });
});
describe('strict founder manual link adapter', () => {
  it('links through POST and reads exact persisted ownership back through GET', async () => {
    const p = await lead(); const m = await message();
    const spy = vi.spyOn(session,'requireFounder').mockResolvedValue({id:'fixture-founder',role:'founder',email:'f@link.test',name:'F'});
    try {
      const context = {params:Promise.resolve({id:m})};
      expect((await POST(new Request(`http://localhost:3100/api/email/messages/${m}/link`,{method:'POST',headers:{origin:'http://localhost:3100'},body:JSON.stringify({action:'link',prospectId:p})}),context)).status).toBe(200);
      const response = await GET(new Request(`http://localhost:3100/api/email/messages/${m}/link`),context);
      expect((await response.json()).data.currentProspectId).toBe(p);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect((await GET(new Request(`http://localhost:3100/api/email/messages/${m}/link?limit=999`),context)).status).toBe(400);
    } finally { spy.mockRestore(); }
  });
  it('rejects unauthenticated and nonfounder readers/writers', async () => {
    for (const status of [401,403]) {
      const spy = vi.spyOn(session,'requireFounder').mockRejectedValue(new AppError('Not allowed',status));
      const context = {params:Promise.resolve({id:crypto.randomUUID()})};
      expect((await GET(new Request('http://localhost:3100'),context)).status).toBe(status);
      expect((await POST(new Request('http://localhost:3100',{method:'POST',headers:{origin:'http://localhost:3100'},body:'{}'}),context)).status).toBe(status);
      spy.mockRestore();
    }
  });
  it('rejects unknown actions/fields, bad IDs, arrays, null and scalars', async () => {
    const spy = vi.spyOn(session,'requireFounder').mockResolvedValue({id:'fixture-founder',role:'founder',email:'f@link.test',name:'F'});
    for (const body of [{action:'link',prospectId:crypto.randomUUID(),auto:true},{action:'delete'},{action:'reject',prospectId:'bad'},[],null,'link']) {
      expect((await POST(new Request('http://localhost:3100',{method:'POST',headers:{origin:'http://localhost:3100'},body:JSON.stringify(body)}),{params:Promise.resolve({id:crypto.randomUUID()})})).status).toBe(400);
    } spy.mockRestore();
  });
  it('requires strict same origin, not just matching host', async () => {
    for (const origin of ['', 'https://localhost:3100', 'http://elsewhere.test'])
      expect((await POST(new Request('http://localhost:3100',{method:'POST',headers:origin?{origin}:{},body:'{}'}),{params:Promise.resolve({id:crypto.randomUUID()})})).status).toBe(403);
  });
});
