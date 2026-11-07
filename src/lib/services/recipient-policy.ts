import { getDb, type DbClient } from "@/lib/db/client";
import { AppError, isEmail, json, normalizeEmail } from "@/lib/utils";
import { getLeadOutreachBlock, getLeadOutreachBlocksBatch, type LeadOutreachBlock } from "./lead-outreach-guard";
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

/**
 * The data `getRecipientPolicy` needs for one lead. Both the single-lookup path and the batch
 * path assemble this same shape and hand it to {@link buildRecipientPolicy}, so the decision
 * logic itself exists in exactly one place and cannot drift between the two call paths.
 */
interface PolicyInputs {
  prospect: Row; stored: Row[]; decisions: Row[]; suppressions: Row[];
  unsubscribed: boolean; outreachBlock: LeadOutreachBlock | null;
  rejectionHolds: string[]; ownAddresses: string[]; messages: Row[];
}

/** Pure decision logic, byte-identical to the original single-lead implementation. */
function buildRecipientPolicy(input: PolicyInputs): RecipientPolicy {
  const { prospect, stored, decisions, suppressions, unsubscribed, outreachBlock, rejectionHolds, ownAddresses: own, messages } = input;
  const linked = (id: string) => decisions.find(d => ['lead.email_linked','lead.email_unlinked'].includes(d.action) && json<Row>(d.metadata, {}).emailRowId === id)?.action !== 'lead.email_unlinked';
  const messageAllowed = (id: string) => {
    const decision = decisions.find(d => ['message.linked','message.unlinked','message.rejected'].includes(d.action) && json<Row>(d.metadata, {}).messageId === id);
    return !decision || decision.action === 'message.linked';
  };
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

export async function getRecipientPolicy(prospectId: string, client?: DbClient): Promise<RecipientPolicy> {
  const db = client ?? await getDb();
  const prospect = (await db.query<Row>(`SELECT id, do_not_contact, archived_at FROM prospects WHERE id = $1`, [prospectId])).rows[0];
  if (!prospect) throw new AppError("Lead not found.", 404);
  const stored = (await db.query<Row>(`SELECT * FROM prospect_emails WHERE prospect_id = $1 ORDER BY is_primary DESC, created_at, id`, [prospectId])).rows;
  const decisions = (await db.query<Row>(`SELECT action, metadata FROM audit_log WHERE actor_type = 'founder' AND
    ((entity_type = 'prospect' AND entity_id = $1 AND action IN ('lead.reply_recipient_set','lead.email_linked','lead.email_unlinked'))
      OR (action IN ('message.linked','message.unlinked','message.rejected') AND metadata->>'prospectId' = $1))
    ORDER BY created_at DESC, id DESC`, [prospectId])).rows;
  const suppressions = (await db.query<Row>(`SELECT * FROM suppressions WHERE active = true AND
    (prospect_id = $1 OR normalized_email = ANY($2::text[]))`, [prospectId, stored.map(e => e.normalized_email)])).rows;
  const unsubscribed = (await db.query(`SELECT 1 FROM conversations WHERE prospect_id = $1 AND classification = 'unsubscribe' LIMIT 1`, [prospectId])).rows.length > 0;
  const outreachBlock = await getLeadOutreachBlock(prospectId, db);
  const rejectionHolds = await rejectionHeldAddresses(stored.map(e=>e.normalized_email), db);
  const own = (await db.query<{ email_address: string }>(`SELECT email_address FROM email_accounts`)).rows.map(a => normalizeEmail(a.email_address));
  const messages = (await db.query<Row>(`SELECT m.* FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id
    WHERE m.prospect_id = $1 OR (m.prospect_id IS NULL AND c.prospect_id = $1)
    ORDER BY COALESCE(m.sent_at, m.received_at, m.created_at) DESC, m.id DESC`, [prospectId])).rows;
  return buildRecipientPolicy({ prospect, stored, decisions, suppressions, unsubscribed, outreachBlock, rejectionHolds, ownAddresses: own, messages });
}

/**
 * Same result as calling {@link getRecipientPolicy} once per id, but a fixed number of queries
 * instead of one full set per lead. Built for list scans (the follow-up candidate reader) where
 * calling the single-lead function in a loop turned a 300-lead page into thousands of round
 * trips and exhausted the database connection pool. Every per-lead decision is still made by the
 * same {@link buildRecipientPolicy}, so this cannot diverge from the single-lead answer.
 */
export async function getRecipientPoliciesBatch(prospectIds: string[], client?: DbClient): Promise<Map<string, RecipientPolicy>> {
  const result = new Map<string, RecipientPolicy>();
  if (!prospectIds.length) return result;
  const db = client ?? await getDb();
  const ids = [...new Set(prospectIds)];
  const textIds = ids.map(String);

  const prospects = (await db.query<Row>(`SELECT id, do_not_contact, archived_at FROM prospects WHERE id = ANY($1::uuid[])`, [ids])).rows;
  const prospectById = new Map(prospects.map(p => [String(p.id), p]));

  const storedRows = (await db.query<Row>(
    `SELECT * FROM prospect_emails WHERE prospect_id = ANY($1::uuid[]) ORDER BY prospect_id, is_primary DESC, created_at, id`,
    [ids],
  )).rows;
  const storedByProspect = new Map<string, Row[]>();
  for (const row of storedRows) {
    const key = String(row.prospect_id);
    (storedByProspect.get(key) ?? storedByProspect.set(key, []).get(key)!).push(row);
  }
  const allNormalizedEmails = storedRows.map(r => r.normalized_email);

  const decisionRows = (await db.query<Row>(
    `SELECT action, metadata, entity_id,
        CASE WHEN entity_type = 'prospect' AND action IN ('lead.reply_recipient_set','lead.email_linked','lead.email_unlinked') THEN entity_id
             ELSE metadata->>'prospectId' END AS group_prospect_id
      FROM audit_log
      WHERE actor_type = 'founder' AND (
        (entity_type = 'prospect' AND entity_id = ANY($1::text[]) AND action IN ('lead.reply_recipient_set','lead.email_linked','lead.email_unlinked'))
        OR (action IN ('message.linked','message.unlinked','message.rejected') AND metadata->>'prospectId' = ANY($1::text[])))
      ORDER BY created_at DESC, id DESC`,
    [textIds],
  )).rows;
  const decisionsByProspect = new Map<string, Row[]>();
  for (const row of decisionRows) {
    const key = row.group_prospect_id;
    if (!key) continue;
    (decisionsByProspect.get(key) ?? decisionsByProspect.set(key, []).get(key)!).push(row);
  }

  const suppressionRows = (await db.query<Row>(
    `SELECT * FROM suppressions WHERE active = true AND (prospect_id = ANY($1::uuid[]) OR normalized_email = ANY($2::text[]))`,
    [ids, allNormalizedEmails],
  )).rows;

  const unsubscribedRows = (await db.query<{ prospect_id: string }>(
    `SELECT DISTINCT prospect_id FROM conversations WHERE prospect_id = ANY($1::uuid[]) AND classification = 'unsubscribe'`,
    [ids],
  )).rows;
  const unsubscribedSet = new Set(unsubscribedRows.map(r => String(r.prospect_id)));

  const outreachBlocks = await getLeadOutreachBlocksBatch(ids, db);
  const heldAddresses = new Set(await rejectionHeldAddresses(allNormalizedEmails, db));
  const own = (await db.query<{ email_address: string }>(`SELECT email_address FROM email_accounts`)).rows.map(a => normalizeEmail(a.email_address));

  const messageRows = (await db.query<Row>(
    `SELECT m.*, COALESCE(m.prospect_id, c.prospect_id) AS resolved_prospect_id
       FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id
      WHERE m.prospect_id = ANY($1::uuid[]) OR (m.prospect_id IS NULL AND c.prospect_id = ANY($1::uuid[]))
      ORDER BY resolved_prospect_id, COALESCE(m.sent_at, m.received_at, m.created_at) DESC, m.id DESC`,
    [ids],
  )).rows;
  const messagesByProspect = new Map<string, Row[]>();
  for (const row of messageRows) {
    const key = String(row.resolved_prospect_id);
    (messagesByProspect.get(key) ?? messagesByProspect.set(key, []).get(key)!).push(row);
  }

  for (const id of ids) {
    const prospect = prospectById.get(id);
    if (!prospect) continue; // Not found: absent from the map, same as a lookup miss.
    const stored = storedByProspect.get(id) ?? [];
    const rejectionHolds = stored.map(e => e.normalized_email).filter(email => heldAddresses.has(email));
    result.set(id, buildRecipientPolicy({
      prospect, stored,
      decisions: decisionsByProspect.get(id) ?? [],
      suppressions: suppressionRows.filter(s => String(s.prospect_id) === id || stored.some(e => e.normalized_email === s.normalized_email)),
      unsubscribed: unsubscribedSet.has(id),
      outreachBlock: outreachBlocks.get(id) ?? null,
      rejectionHolds,
      ownAddresses: own,
      messages: messagesByProspect.get(id) ?? [],
    }));
  }
  return result;
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
