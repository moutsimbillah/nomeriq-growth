import { getDb, type DbClient } from "@/lib/db/client";
import { AppError, isEmail, json, normalizeEmail } from "@/lib/utils";
import { getLeadOutreachBlock } from "./lead-outreach-guard";
import { rejectionHeldAddresses } from "./lead-rejections";

/** Data only: never creates address associations or clears historical suppressions. */
export interface RecipientEmail {
  id: string; email: string; sourceType: string; sourceUrl: string;
  isPrimary: boolean; linked: boolean; blocked: boolean; reason: string | null;
}
export interface RecipientPolicy {
  recipient: string | null; blocked: boolean; reason: string | null;
  firstContact: string | null; currentWritingFrom: string | null;
  emails: RecipientEmail[]; preferredEmailId: string | null;
}
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Stored inbound facts only; reports, automatic responses and our own accounts are not prospects. */
export function isRealProspectMessage(message: Row, ownAddresses: string[]): boolean {
  if (message.direction !== "inbound" || !isEmail(message.from_email ?? "")) return false;
  if (ownAddresses.includes(normalizeEmail(message.from_email))) return false;
  if (/^(mailer-daemon|postmaster|no-?reply)@/i.test(message.from_email)) return false;
  const headers = json<Record<string, unknown>>(message.raw_headers, {});
  if (headers.deliveryReport === true || headers.deliveryReport === 'true' || headers.autoReply === true || headers.autoReply === 'true') return false;
  const header = (key: string) => String(Object.entries(headers).find(([k]) => k.toLowerCase() === key)?.[1] ?? "");
  if (/report-type\s*=\s*(delivery-status|feedback-report)/i.test(header("content-type"))) return false;
  if (/auto-replied|auto-generated/i.test(header("auto-submitted"))) return false;
  return !/\b(out of (the )?office|automatic reply|auto.?reply|vacation|delivery status notification|undeliverable|delivery failure)\b/i.test(message.subject ?? "");
}

export async function getRecipientPolicy(prospectId: string, client?: DbClient): Promise<RecipientPolicy> {
  const db = client ?? await getDb();
  const prospect = (await db.query<Row>(`SELECT id, do_not_contact, archived_at FROM prospects WHERE id = $1`, [prospectId])).rows[0];
  if (!prospect) throw new AppError("Lead not found.", 404);
  const stored = (await db.query<Row>(`SELECT * FROM prospect_emails WHERE prospect_id = $1 ORDER BY is_primary DESC, created_at, id`, [prospectId])).rows;
  const decisions = (await db.query<Row>(`SELECT action, metadata FROM audit_log WHERE actor_type = 'founder' AND
    ((entity_type = 'prospect' AND entity_id = $1 AND action IN ('lead.reply_recipient_set','lead.email_linked','lead.email_unlinked'))
      OR (action IN ('message.linked','message.unlinked','message.rejected') AND metadata->>'prospectId' = $1))
    ORDER BY created_at DESC, id DESC`, [prospectId])).rows;
  const linked = (id: string) => decisions.find(d => ['lead.email_linked','lead.email_unlinked'].includes(d.action) && json<Row>(d.metadata, {}).emailRowId === id)?.action !== 'lead.email_unlinked';
  const messageAllowed = (id: string) => {
    const decision = decisions.find(d => ['message.linked','message.unlinked','message.rejected'].includes(d.action) && json<Row>(d.metadata, {}).messageId === id);
    return !decision || decision.action === 'message.linked';
  };
  const suppressions = (await db.query<Row>(`SELECT * FROM suppressions WHERE active = true AND
    (prospect_id = $1 OR normalized_email = ANY($2::text[]))`, [prospectId, stored.map(e => e.normalized_email)])).rows;
  const unsubscribed = (await db.query(`SELECT 1 FROM conversations WHERE prospect_id = $1 AND classification = 'unsubscribe' LIMIT 1`, [prospectId])).rows.length > 0;
  const outreachBlock = await getLeadOutreachBlock(prospectId, db);
  const rejectionHolds = await rejectionHeldAddresses(stored.map(e=>e.normalized_email), db);
  const wholeStop = prospect.archived_at ? 'This lead is archived.' : prospect.do_not_contact ? 'Sending is suppressed: this lead is marked do not contact.'
    : rejectionHolds.length ? 'This address is blocked by an offer-rejection hold, including across linked leads.'
    : unsubscribed || suppressions.some(s => s.reason !== 'bounce') ? 'This lead has an active opt-out, complaint or manual suppression.' : outreachBlock?.reason ?? null;
  const emails: RecipientEmail[] = stored.map(e => {
    const addressStop = suppressions.some(s => s.normalized_email === e.normalized_email);
    const active = linked(e.id);
    return { id: e.id, email: e.email, sourceType: e.source_type, sourceUrl: e.source_url, isPrimary: e.is_primary,
      linked: active, blocked: Boolean(wholeStop || addressStop || !active),
      reason: wholeStop ?? (!active ? 'Address association removed by founder.' : addressStop ? 'This address is suppressed (including bounced addresses).' : null) };
  });
  const own = (await db.query<{ email_address: string }>(`SELECT email_address FROM email_accounts`)).rows.map(a => normalizeEmail(a.email_address));
  const messages = (await db.query<Row>(`SELECT m.* FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id
    WHERE m.prospect_id = $1 OR (m.prospect_id IS NULL AND c.prospect_id = $1)
    ORDER BY COALESCE(m.sent_at, m.received_at, m.created_at) DESC, m.id DESC`, [prospectId])).rows;
  const real = messages.filter(m => isRealProspectMessage(m, own) && messageAllowed(m.id));
  const currentWritingFrom = real.find(m => emails.some(e => e.linked && normalizeEmail(e.email) === normalizeEmail(m.from_email)))?.from_email ?? null;
  const first = [...messages].reverse().find(m => m.direction === 'outbound' && m.delivery_status !== 'failed' && json<string[]>(m.to_emails, []).length);
  const firstContact = first ? json<string[]>(first.to_emails, [])[0] ?? null : null;
  const preference = decisions.find(d => d.action === 'lead.reply_recipient_set');
  const preferredEmailId = preference ? json<Row>(preference.metadata, {}).emailRowId ?? null : null;
  const preferred = preferredEmailId ? emails.find(e => e.id === preferredEmailId) : null;
  let recipient: string | null = null;
  let reason: string | null = wholeStop;
  if (!wholeStop && preferredEmailId) {
    if (!preferred || preferred.blocked) reason = 'The explicitly selected reply address is unavailable or suppressed. Choose another stored address explicitly.';
    else recipient = preferred.email;
  } else if (!wholeStop) {
    // Address-book evidence is retained after unlink; a message-only address must not become the
    // default again merely because it remains stored. Explicit address-book detach is separate.
    const defaultEligible = (e: RecipientEmail) => {
      if (e.blocked) return false;
      if (e.sourceType !== 'founder_entered' || !e.sourceUrl.startsWith('Linked by founder from message ')) return true;
      const sourceMessageId = e.sourceUrl.slice('Linked by founder from message '.length);
      const latest = decisions.find(d => {
        const meta = json<Row>(d.metadata, {});
        return (d.action === 'lead.email_linked' && meta.emailRowId === e.id)
          || (['message.linked','message.unlinked','message.rejected'].includes(d.action) && meta.messageId === sourceMessageId);
      });
      return !latest || !['message.unlinked','message.rejected'].includes(latest.action);
    };
    for (const m of real) {
      const eligible = emails.find(e => defaultEligible(e) && normalizeEmail(e.email) === normalizeEmail(m.from_email));
      if (eligible) { recipient = eligible.email; break; }
    }
    recipient ??= emails.find(defaultEligible)?.email ?? null;
    if (!recipient) reason = 'No eligible linked address. Link a confirmed message address or select a stored address.';
    else if (emails.some(e => e.blocked)) reason = 'Using an eligible linked alternative; suppressed or removed addresses remain blocked.';
  }
  return { recipient, blocked: !recipient || Boolean(wholeStop), reason, firstContact, currentWritingFrom, emails, preferredEmailId };
}

/** Null explicitly restores the default policy; an address must already belong to this lead. */
export async function setReplyRecipient(prospectId: string, emailRowId: string | null, actorUserId: string): Promise<RecipientPolicy> {
  const db = await getDb();
  return db.transaction(async tx => {
    const lead = await tx.query(`SELECT id FROM prospects WHERE id = $1 FOR UPDATE`, [prospectId]);
    if (!lead.rows.length) throw new AppError('Lead not found.', 404);
    const before = await getRecipientPolicy(prospectId, tx);
    if (emailRowId) {
      const selected = before.emails.find(e => e.id === emailRowId);
      if (!selected) throw new AppError('The recipient must be a stored address owned by this lead.', 409);
      if (selected.blocked) throw new AppError(selected.reason ?? 'This recipient is blocked.', 409, 'suppressed');
    }
    await tx.query(`INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, metadata, created_at)
      VALUES ($1, 'founder', $2, 'lead.reply_recipient_set', 'prospect', $3, $4::jsonb, clock_timestamp())`,
      [crypto.randomUUID(), actorUserId, prospectId, JSON.stringify({ emailRowId })]);
    return getRecipientPolicy(prospectId, tx);
  });
}
