import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '@/lib/db/client';
import { getRecipientPolicy, setReplyRecipient, isRealProspectMessage } from '@/lib/services/recipient-policy';
import { AppError } from '@/lib/utils';
import * as session from '@/lib/auth/session';
import { GET, POST } from '@/app/api/leads/[id]/reply-recipient/route';

const leads: string[] = [];
const addresses: string[] = [];
async function fixture() {
  const db = await getDb(); const id = crypto.randomUUID(); leads.push(id);
  await db.query(`INSERT INTO prospects (id, business_name, name_key, domain_key, created_by_type) VALUES ($1::uuid, 'Policy fixture', $1::text, $1::text, 'founder')`, [id]);
  const emailIds = [crypto.randomUUID(), crypto.randomUUID()];
  const emails = [`first-${id}@policy.test`, `latest-${id}@policy.test`]; addresses.push(...emails);
  for (let n = 0; n < 2; n++) await db.query(`INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type, is_primary)
    VALUES ($1, $2, $3, $3, 'https://policy.test', 'official_website', $4)`, [emailIds[n], id, emails[n], n === 0]);
  const conversationId = crypto.randomUUID();
  await db.query(`INSERT INTO conversations (id, prospect_id, subject) VALUES ($1, $2, 'Policy')`, [conversationId, id]);
  await db.query(`INSERT INTO messages (id, conversation_id, prospect_id, direction, from_email, to_emails, sent_at)
    VALUES ($1,$2,$3,'outbound','founder@policy.test',$4::jsonb,'2026-01-01')`, [crypto.randomUUID(), conversationId, id, JSON.stringify([emails[1]])]);
  await db.query(`INSERT INTO messages (id, conversation_id, prospect_id, direction, from_email, received_at)
    VALUES ($1,$2,$3,'inbound',$4,'2026-01-02')`, [crypto.randomUUID(), conversationId, id, emails[1]]);
  return { id, emailIds, emails, conversationId };
}
async function suppress(email: string, reason: string, prospectId: string | null) {
  const db = await getDb(); addresses.push(email);
  await db.query(`INSERT INTO suppressions (id, normalized_email, email, reason, prospect_id) VALUES ($1,$2,$2,$3,$4)`, [crypto.randomUUID(), email, reason, prospectId]);
}
beforeAll(async () => { await getDb(); });
afterAll(async () => {
  vi.restoreAllMocks(); const db = await getDb();
  await db.query(`DELETE FROM audit_log WHERE entity_id = ANY($1::text[])`, [leads]);
  await db.query(`DELETE FROM suppressions WHERE normalized_email = ANY($1::text[])`, [addresses]);
  await db.query(`DELETE FROM messages WHERE prospect_id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM conversations WHERE prospect_id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM prospect_emails WHERE prospect_id = ANY($1::uuid[])`, [leads]);
  await db.query(`DELETE FROM prospects WHERE id = ANY($1::uuid[])`, [leads]); await closeDb();
});
describe('transaction-compatible recipient policy', () => {
  it('derives first contact from first outbound, not primary, and latest real linked sender', async () => {
    const f = await fixture(); const db = await getDb();
    await db.query(`INSERT INTO messages (id, conversation_id, prospect_id, direction, from_email, subject, received_at)
      VALUES ($1,$2,$3,'inbound','mailer-daemon@policy.test','Delivery status notification','2026-01-03')`, [crypto.randomUUID(), f.conversationId, f.id]);
    await db.transaction(async tx => {
      const policy = await getRecipientPolicy(f.id, tx);
      expect(policy).toMatchObject({ firstContact: f.emails[1], currentWritingFrom: f.emails[1], recipient: f.emails[1], blocked: false });
    });
  });
  it('bounce blocks only that address and default can choose a viable alternative with a reason', async () => {
    const f = await fixture(); await suppress(f.emails[1], 'bounce', f.id);
    expect(await getRecipientPolicy(f.id)).toMatchObject({ recipient: f.emails[0], blocked: false, reason: expect.stringContaining('alternative') });
  });
  it('never silently switches an explicitly preferred address after a bounce', async () => {
    const f = await fixture(); await setReplyRecipient(f.id, f.emailIds[1], 'fixture-founder');
    await suppress(f.emails[1], 'bounce', f.id);
    expect(await getRecipientPolicy(f.id)).toMatchObject({ recipient: null, blocked: true, reason: expect.stringContaining('explicitly selected') });
    expect((await setReplyRecipient(f.id, null, 'fixture-founder')).recipient).toBe(f.emails[0]);
  });
  for (const reason of ['opt_out','unsubscribe','complaint','manual']) it(`whole-lead ${reason} holds across all linked addresses`, async () => {
    const f = await fixture(); await suppress(f.emails[0], reason, null);
    expect((await getRecipientPolicy(f.id)).blocked).toBe(true);
    await expect(setReplyRecipient(f.id, f.emailIds[1], 'fixture-founder')).rejects.toMatchObject({ status: 409 });
  });
  it('suppression by prospect id applies even when the address is not stored', async () => {
    const f = await fixture(); await suppress(`${f.id}@not-stored.test`, 'unsubscribe', f.id);
    expect((await getRecipientPolicy(f.id)).recipient).toBeNull();
  });
  it('DNC and archive cannot be bypassed by selecting another address', async () => {
    for (const column of ['do_not_contact = true','archived_at = now()']) {
      const f = await fixture(); await (await getDb()).query(`UPDATE prospects SET ${column} WHERE id = $1`, [f.id]);
      expect((await getRecipientPolicy(f.id)).blocked).toBe(true);
    }
  });
  it('latest explicit founder decision wins and foreign stored IDs are refused', async () => {
    const f = await fixture(); const other = await fixture();
    await expect(setReplyRecipient(f.id, other.emailIds[0], 'fixture-founder')).rejects.toMatchObject({ status: 409 });
    await setReplyRecipient(f.id, f.emailIds[0], 'fixture-founder');
    expect((await setReplyRecipient(f.id, f.emailIds[1], 'fixture-founder')).recipient).toBe(f.emails[1]);
  });
  it('unlisted latest inbound is not a stored now-writing-from or reply target', async () => {
    const f = await fixture(); await (await getDb()).query(`INSERT INTO messages (id, conversation_id, prospect_id, direction, from_email, received_at)
      VALUES ($1,$2,$3,'inbound','unlinked@policy.test','2026-01-04')`, [crypto.randomUUID(), f.conversationId, f.id]);
    const policy = await getRecipientPolicy(f.id); expect(policy.currentWritingFrom).toBe(f.emails[1]); expect(policy.recipient).toBe(f.emails[1]);
  });
  it('excludes OOO, DSN, self and stored auto-reply facts', () => {
    for (const patch of [{subject:'Out of office'}, {raw_headers:{autoReply:true}}, {raw_headers:{deliveryReport:true}}, {raw_headers:{'Auto-Submitted':'auto-replied'}}, {from_email:'ours@policy.test'}])
      expect(isRealProspectMessage({ direction:'inbound', from_email:'person@policy.test', subject:'Hello', ...patch }, ['ours@policy.test'])).toBe(false);
  });
});
describe('founder-only recipient adapter', () => {
  it('persists an explicit owned recipient through POST and verifies it through GET', async () => {
    const f = await fixture();
    const spy = vi.spyOn(session,'requireFounder').mockResolvedValue({id:'fixture-founder',role:'founder',email:'f@policy.test',name:'F'});
    try {
      const context = {params:Promise.resolve({id:f.id})};
      const url = `http://localhost:3100/api/leads/${f.id}/reply-recipient`;
      expect((await POST(new Request(url,{method:'POST',headers:{origin:'http://localhost:3100'},body:JSON.stringify({emailRowId:f.emailIds[0]})}),context)).status).toBe(200);
      const response = await GET(new Request(url),context);
      expect((await response.json()).data).toMatchObject({recipient:f.emails[0],preferredEmailId:f.emailIds[0]});
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect((await GET(new Request(`${url}?auto=true`),context)).status).toBe(400);
    } finally { spy.mockRestore(); }
  });
  it('rejects missing authentication for GET', async () => {
    const spy = vi.spyOn(session, 'requireFounder').mockRejectedValue(new AppError('Sign in',401));
    expect((await GET(new Request('http://localhost:3100'), {params:Promise.resolve({id:crypto.randomUUID()})})).status).toBe(401); spy.mockRestore();
  });
  it('rejects unknown fields, scalars and arrays; no API-key fallback', async () => {
    const spy = vi.spyOn(session,'requireFounder').mockResolvedValue({id:'fixture-founder',role:'founder',email:'f@policy.test',name:'F'});
    for (const body of [{ emailRowId:null, send:true }, [], null, 'x']) {
      const response = await POST(new Request('http://localhost:3100/api/leads/x/reply-recipient', {method:'POST',headers:{origin:'http://localhost:3100','content-type':'application/json'},body:JSON.stringify(body)}), {params:Promise.resolve({id:crypto.randomUUID()})});
      expect(response.status).toBe(400);
    } spy.mockRestore();
  });
  it('requires exact same origin including scheme', async () => {
    for (const origin of ['', 'https://localhost:3100','http://outside.test']) {
      const response = await POST(new Request('http://localhost:3100/api/leads/x/reply-recipient', {method:'POST',headers: origin ? {origin} : {},body:'{}'}), {params:Promise.resolve({id:crypto.randomUUID()})});
      expect(response.status).toBe(403);
    }
  });
});
