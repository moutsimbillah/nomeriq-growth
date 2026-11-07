/** Pure shared recovery policy. Adapters may SELECT, never create conversations. */
export interface RecoveryInput {
  direction: "inbound" | "outbound";
  fromEmail: string; toEmails: string[]; inReplyTo: string | null;
  references: string[]; subject: string;
}
export interface RecoveryOwner { prospectId: string | null; conversationId: string | null; matchedBy: string }
export interface RecoveryLookups {
  threads(ids: string[]): Promise<{ prospectId: string; conversationId: string }[]>;
  prospects(emails: string[]): Promise<string[]>;
  conversations(prospectId: string): Promise<{ id: string; subject: string }[]>;
}
export function recoverySubject(value: string): string {
  return value.replace(/^(\s*(re|fw|fwd)\s*:\s*)+/gi, "").trim().toLowerCase();
}
export async function matchRecoveryOwner(input: RecoveryInput, lookup: RecoveryLookups): Promise<RecoveryOwner> {
  const unmatched = (matchedBy = "unmatched"): RecoveryOwner => ({ prospectId: null, conversationId: null, matchedBy });
  // Message-IDs are case-sensitive opaque identifiers. Do not normalize them.
  const ids = [...new Set([input.inReplyTo, ...input.references].filter((v): v is string => !!v))];
  if (ids.length) {
    const threads = await lookup.threads(ids);
    const unique = new Map(threads.map(t => [t.conversationId, t]));
    if (unique.size > 1) return unmatched("ambiguous_thread_headers");
    if (unique.size === 1) return { ...[...unique.values()][0], matchedBy: "thread_headers" };
  }
  const emails = (input.direction === "inbound" ? [input.fromEmail] : input.toEmails)
    .map(v => v.trim().toLowerCase()).filter(v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(v));
  const prospects = [...new Set(await lookup.prospects(emails))];
  if (prospects.length !== 1) return unmatched();
  const prior = await lookup.conversations(prospects[0]);
  const subject = recoverySubject(input.subject);
  if (prior.length !== 1 || !subject || subject === "(no subject)" || recoverySubject(prior[0].subject) !== subject) return unmatched();
  return { prospectId: prospects[0], conversationId: prior[0].id, matchedBy: "unique_address_subject" };
}
/** SELECT-only adapter, usable with the existing raw PG or application client. */
export function recoverySqlLookups(db: { query(sql: string, values?: any[]): Promise<{ rows: any[] }> }): RecoveryLookups {
  return {
    async threads(ids) {
      const result = await db.query(`SELECT DISTINCT c.id AS conversation_id, c.prospect_id FROM messages m
        JOIN conversations c ON c.id = m.conversation_id WHERE m.message_id = ANY($1::text[])
        AND (m.prospect_id IS NULL OR m.prospect_id = c.prospect_id) LIMIT 2`, [ids]);
      return result.rows.map(r => ({ conversationId: r.conversation_id, prospectId: r.prospect_id }));
    },
    async prospects(emails) {
      return (await db.query(`SELECT DISTINCT p.id FROM prospects p JOIN prospect_emails pe ON pe.prospect_id = p.id
        WHERE pe.normalized_email = ANY($1::text[]) AND p.archived_at IS NULL LIMIT 2`, [emails])).rows.map(r => r.id);
    },
    async conversations(id) {
      return (await db.query(`SELECT id, subject FROM conversations WHERE prospect_id = $1`, [id])).rows;
    },
  };
}
