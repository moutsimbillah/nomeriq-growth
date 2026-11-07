import { getDb, type DbClient } from '@/lib/db/client';
import { AppError, isGenericBusinessEmail, json, normalizeEmail } from '@/lib/utils';
import { isRealProspectMessage } from './recipient-policy';
import { recomputeConversationChronology } from '@/lib/email/conversation-chronology';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface LinkDecision {
  action: 'link' | 'unlink' | 'reject'; prospectId?: string;
  confirmSharedAddress?: boolean; detachAddress?: boolean;
}

/** Latest per-message/lead founder decision is an append-only veto on future rematching. */
export async function mayAssociateMessage(db: DbClient, messageId: string, prospectId: string): Promise<boolean> {
  const decision = (await db.query<{ action: string }>(`SELECT action FROM audit_log
    WHERE actor_type = 'founder' AND entity_type = 'message' AND entity_id = $1
      AND metadata->>'prospectId' = $2 AND action IN ('message.linked','message.unlinked','message.rejected')
    ORDER BY created_at DESC, id DESC LIMIT 1`, [messageId, prospectId])).rows[0];
  return !decision || decision.action === 'message.linked';
}

async function audit(db: DbClient, actor: string, action: string, entityType: string, entityId: string, metadata: object) {
  await db.query(`INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, metadata, created_at)
    VALUES ($1, 'founder', $2, $3, $4, $5, $6::jsonb, clock_timestamp())`,
    [crypto.randomUUID(), actor, action, entityType, entityId, JSON.stringify(metadata)]);
}

export async function decideMessageLink(messageId: string, input: LinkDecision, actorUserId: string) {
  const db = await getDb();
  try {
    return await db.transaction(async tx => {
      // Serialize decisions for the same message before inspecting ownership.
      const m = (await tx.query<Row>(`SELECT m.*, c.prospect_id AS conversation_owner FROM messages m
        LEFT JOIN conversations c ON c.id = m.conversation_id WHERE m.id = $1 FOR UPDATE OF m`, [messageId])).rows[0];
      if (!m) throw new AppError('Message not found.', 404);
      const owner = m.prospect_id ?? m.conversation_owner ?? null;
      if (m.prospect_id && m.conversation_owner && m.prospect_id !== m.conversation_owner)
        throw new AppError('Message ownership conflicts with its conversation. Resolve explicitly before linking.', 409);
      const prospectId = input.prospectId ?? owner;
      if (!prospectId) throw new AppError('Choose a lead.', 400);
      const p = (await tx.query<Row>(`SELECT id FROM prospects WHERE id = $1 FOR UPDATE`, [prospectId])).rows[0];
      if (!p) throw new AppError('Lead not found.', 404);
      if (owner && owner !== prospectId) throw new AppError('Message already belongs to another lead. Unlink it first.', 409, 'ownership_conflict');
      const address = normalizeEmail(m.from_email);
      let emailRowId: string | null = null;
      if (input.action === 'link') {
        const own = (await tx.query<{ email_address: string }>(`SELECT email_address FROM email_accounts`)).rows.map(a => normalizeEmail(a.email_address));
        if (!isRealProspectMessage(m, own)) throw new AppError('Delivery reports, automatic replies and self messages cannot establish a prospect address.', 409);
        const existing = (await tx.query<Row>(`SELECT * FROM prospect_emails WHERE normalized_email = $1 FOR UPDATE`, [address])).rows;
        const shared = existing.some(e => e.prospect_id !== prospectId);
        if (shared && !isGenericBusinessEmail(address)) throw new AppError('This address is owned by another lead.', 409, 'address_conflict');
        if (shared && !input.confirmSharedAddress) throw new AppError('This generic address is shared. Explicitly confirm the association.', 409, 'shared_address_confirmation');
        emailRowId = existing.find(e => e.prospect_id === prospectId)?.id ?? crypto.randomUUID();
        if (!existing.some(e => e.prospect_id === prospectId)) {
          await tx.query(`INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_type, source_url, is_primary)
            VALUES ($1, $2, $3, $3, 'founder_entered', $4, false)`,
            [emailRowId, prospectId, address, `Linked by founder from message ${messageId}`]);
        }
        await audit(tx, actorUserId, 'lead.email_linked', 'prospect', prospectId, { emailRowId, messageId });
        const conversation = (await tx.query<{ id: string }>(`INSERT INTO conversations (id, prospect_id, subject)
          VALUES ($1, $2, $3) ON CONFLICT (prospect_id) DO UPDATE SET prospect_id = EXCLUDED.prospect_id RETURNING id`,
          [crypto.randomUUID(), prospectId, m.subject])).rows[0];
        await tx.query(`UPDATE messages SET prospect_id = $1, conversation_id = $2, matched_by = 'founder' WHERE id = $3`, [prospectId, conversation.id, messageId]);
      } else {
        if (input.action === 'unlink' && !owner) throw new AppError('Message is not linked to a lead.', 409);
        if (owner) await tx.query(`UPDATE messages SET prospect_id = null, conversation_id = null, matched_by = null WHERE id = $1`, [messageId]);
        if (input.detachAddress) {
          const email = (await tx.query<{ id: string }>(`SELECT id FROM prospect_emails WHERE prospect_id = $1 AND normalized_email = $2 FOR UPDATE`, [prospectId, address])).rows[0];
          if (email) {
            emailRowId = email.id;
            await audit(tx, actorUserId, 'lead.email_unlinked', 'prospect', prospectId, { emailRowId, messageId });
          }
        }
      }
      await audit(tx, actorUserId, `message.${input.action === 'link' ? 'linked' : input.action === 'unlink' ? 'unlinked' : 'rejected'}`, 'message', messageId,
        { messageId, prospectId, emailRowId, detachAddress: input.detachAddress === true, sharedAddressConfirmed: input.confirmSharedAddress === true });
      await recomputeConversationChronology(tx, prospectId);
      return { messageId, prospectId: input.action === 'link' ? prospectId : null, emailRowId, action: input.action };
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new AppError('The address or ownership changed concurrently. Reload and review the association.', 409, 'link_conflict');
    throw error;
  }
}

export interface LinkCandidate { id: string; businessName: string; reason: string; }
/** Bounded read-only suggestions: thread identity is account-aware; domain/name evidence is only a hint. */
export async function getMessageLinkSuggestions(messageId: string, query = '') {
  const db = await getDb();
  const m = (await db.query<Row>(`SELECT m.*, c.prospect_id AS conversation_owner FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id WHERE m.id = $1`, [messageId])).rows[0];
  if (!m) throw new AppError('Message not found.', 404);
  const own = (await db.query<{ email_address: string }>(`SELECT email_address FROM email_accounts`)).rows.map(a => normalizeEmail(a.email_address));
  const eligible = isRealProspectMessage(m, own);
  const candidates: LinkCandidate[] = [];
  const refs = [...json<string[]>(m.references_json, []), m.in_reply_to].filter(Boolean);
  if (eligible && refs.length && m.account_id) {
    const thread = (await db.query<Row>(`SELECT DISTINCT p.id, p.business_name FROM messages t
      JOIN conversations c ON c.id = t.conversation_id JOIN prospects p ON p.id = COALESCE(t.prospect_id, c.prospect_id)
      WHERE t.account_id = $1 AND t.message_id = ANY($2::text[]) LIMIT 2`, [m.account_id, refs])).rows;
    if (thread.length === 1 && await mayAssociateMessage(db, messageId, thread[0].id)) candidates.push({ id: thread[0].id, businessName: thread[0].business_name, reason: 'Unique thread in the same mailbox — confirm the address' });
  }
  if (eligible) {
    const domain = normalizeEmail(m.from_email).split('@')[1];
    const hints = (await db.query<Row>(`SELECT DISTINCT p.id, p.business_name FROM prospects p
      LEFT JOIN prospect_emails pe ON pe.prospect_id = p.id WHERE p.archived_at IS NULL AND
      (p.domain_key = $1 OR split_part(pe.normalized_email, '@', 2) = $1 OR
        (length(p.business_name) >= 5 AND position(lower(p.business_name) in lower($2)) > 0))
      ORDER BY p.business_name, p.id LIMIT 10`, [domain, String(m.body_text ?? '').slice(-4000)])).rows;
    for (const p of hints) if (!candidates.some(c => c.id === p.id) && await mayAssociateMessage(db, messageId, p.id)) candidates.push({ id: p.id, businessName: p.business_name, reason: 'Domain or signature/name hint only — review manually' });
  }
  const search = query.trim() ? (await db.query<Row>(`SELECT id, business_name FROM prospects WHERE business_name ILIKE $1 ORDER BY business_name, id LIMIT 20`, [`%${query.trim().slice(0, 100)}%`])).rows.map(p => ({ id: p.id, businessName: p.business_name, reason: 'Manual search result' })) : [];
  return { messageId, currentProspectId: m.prospect_id ?? m.conversation_owner ?? null, eligible, suggestions: candidates, search };
}

/** Reserved for a separately approved sync caller. No reads/deploys call this automatically. */
export async function associateCertainThreadAddress(messageId: string, prospectId: string, actorUserId: string, approved = false) {
  if (!approved) throw new AppError('Automatic address linking requires explicit future approval.', 409, 'approval_required');
  const db = await getDb();
  if (!await mayAssociateMessage(db, messageId, prospectId)) throw new AppError('Founder rejected or unlinked this association.', 409);
  const data = await getMessageLinkSuggestions(messageId);
  if (data.suggestions[0]?.id !== prospectId || !data.suggestions[0]?.reason.startsWith('Unique thread')) throw new AppError('No unique account-aware thread evidence.', 409);
  return decideMessageLink(messageId, { action: 'link', prospectId }, actorUserId);
}
