import type { DbClient } from "@/lib/db/client";
import { AppError, normalizeEmail } from "@/lib/utils";
import { linkedContactHoldSql } from "./linked-contact-policy";

/**
 * Send-time cross-lead duplicate-contact guard.
 *
 * Identity keys come only from the shared SQL resolvers in migration 034
 * (`growth_identity_domain`, `growth_business_email_domain`), so this file holds no host lists:
 *  - the exact recipient address is always a key, free-mail included;
 *  - the recipient's business email domain (null for free/shared mail) and the sending lead's own
 *    website domain are domain-wide keys, matched exactly (no suffix collapse; .co.uk stays distinct).
 *
 * Another lead conflicts when it matches a key and is either
 *  - in contact: a non-failed outbound message, an inbound message, or an active send reservation
 *    (queued/sending/accepted/sandbox/uncertain) attached to that lead; this always refuses; or
 *  - an owner of the identity on record (website domain, stored email or its business domain); this
 *    refuses unless the sending lead itself already has contact history on those keys, so its own
 *    legitimate follow-ups and replies continue.
 * Leads the founder actively linked as duplicates OF the sending lead are excluded and their history
 * counts as the sending (canonical) lead's own for the exemption above — nothing is moved or merged;
 * a lead that is itself an active duplicate never sends. An unrelated contacted lead still holds the
 * canonical lead. Read-only: never creates or changes any association.
 */
export interface DuplicateContactConflict {
  kind: "duplicate_link" | "linked_hold" | "contact_history" | "identity";
  prospectId: string;
  businessName: string | null;
}

const ACTIVE_SEND_STATUSES = ["queued", "sending", "accepted", "sandbox", "uncertain"];

export async function findDuplicateContactConflict(
  input: { prospectId: string; recipient: string; draftId?: string | null },
  db: DbClient,
): Promise<DuplicateContactConflict | null> {
  const recipient = normalizeEmail(input.recipient);
  const link = await db.query<{ canonical_prospect_id: string; business_name: string | null }>(
    `SELECT l.canonical_prospect_id, p.business_name FROM prospect_duplicate_links l
       LEFT JOIN prospects p ON p.id = l.canonical_prospect_id
      WHERE l.prospect_id = $1 AND l.restored_at IS NULL LIMIT 1`,
    [input.prospectId],
  );
  if (link.rows[0]) {
    return { kind: "duplicate_link", prospectId: String(link.rows[0].canonical_prospect_id), businessName: link.rows[0].business_name };
  }
  // Marking a copy is not permission to bypass its pre-existing do-not-contact/opt-out/rejection.
  // The mark's OWN new do_not_contact flag is intentionally not inherited; its saved prior flag is.
  // The hold conditions are the shared linked-contact policy, so they cannot drift from the
  // follow-up stop policy that reuses them.
  const held = await db.query<{id:string;business_name:string}>(`SELECT p.id,p.business_name
    FROM prospect_duplicate_links l JOIN prospects p ON p.id=l.prospect_id
    WHERE l.canonical_prospect_id=$1 AND l.restored_at IS NULL AND ${linkedContactHoldSql("l","p")}
    ORDER BY p.created_at,p.id LIMIT 1`,[input.prospectId]);
  if (held.rows[0]) return {kind:"linked_hold",prospectId:held.rows[0].id,businessName:held.rows[0].business_name};
  const result = await db.query<{ kind: "contact_history" | "identity"; prospect_id: string; business_name: string | null }>(
    `WITH target AS (
       SELECT array_remove(ARRAY[growth_business_email_domain($2::text),
         growth_identity_domain(p.domain_key), growth_identity_domain(p.website_url)], NULL) AS domains,
         array_remove(ARRAY[p.domain_key, p.website_url], NULL) AS site_values
       FROM prospects p WHERE p.id = $1
     ), excluded AS (
       SELECT l.prospect_id FROM prospect_duplicate_links l
        WHERE l.canonical_prospect_id = $1 AND l.restored_at IS NULL
     ), contacts AS (
       SELECT COALESCE(m.prospect_id, c.prospect_id) AS prospect_id, lower(trim(r.addr)) AS addr
         FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(m.to_emails) = 'array' THEN m.to_emails ELSE '[]'::jsonb END) r(addr)
        WHERE COALESCE(m.prospect_id, c.prospect_id) IS NOT NULL
          AND m.direction = 'outbound' AND m.delivery_status IS DISTINCT FROM 'failed'
       UNION ALL
       SELECT COALESCE(m.prospect_id, c.prospect_id), lower(trim(m.from_email))
         FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id
        WHERE COALESCE(m.prospect_id, c.prospect_id) IS NOT NULL
          AND m.direction = 'inbound' AND m.from_email IS NOT NULL
       UNION ALL
       SELECT COALESCE(s.prospect_id, d.prospect_id), lower(trim(COALESCE(s.recipient_email, d.recipient_email)))
         FROM outbound_sends s LEFT JOIN drafts d ON d.id = s.draft_id
        WHERE s.status = ANY($4::text[])
          AND ($3::uuid IS NULL OR s.draft_id IS NULL OR s.draft_id <> $3::uuid)
     ), matched_contacts AS (
       SELECT DISTINCT k.prospect_id FROM contacts k, target t
        WHERE k.prospect_id IS NOT NULL AND k.addr IS NOT NULL
          AND k.addr NOT IN (SELECT lower(trim(email_address)) FROM email_accounts)
          -- The normalized host is always a contiguous substring of the lowercased address.
          -- Reject obvious non-candidates cheaply before running the shared regex normalizer
          -- over history. CASE guarantees that evaluation order; the authoritative comparison
          -- still rejects suffix/subdomain/lookalike matches and excludes free-mail hosts.
          AND (k.addr = $2::text OR CASE WHEN EXISTS (
            SELECT 1 FROM unnest(t.domains) domain WHERE strpos(k.addr, domain) > 0
          ) THEN growth_business_email_domain(k.addr) = ANY(t.domains) ELSE false END)
     ), identity_owners AS (
       -- The shared save-time resolver (website/email domain collisions, archived leads included),
       -- plus the exact address on any lead: the resolver deliberately skips generic local parts.
       SELECT m.prospect_id FROM target t CROSS JOIN LATERAL growth_find_identity_matches(
         t.site_values, ARRAY[$2::text], ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
         ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[]) m
       UNION
       SELECT e.prospect_id FROM prospect_emails e WHERE e.normalized_email = $2::text
     ), conflicts AS (
       SELECT 'contact_history' AS kind, 0 AS rank, prospect_id FROM matched_contacts
       UNION ALL
       SELECT 'identity', 1, prospect_id FROM identity_owners
        WHERE NOT EXISTS (SELECT 1 FROM matched_contacts mc
          WHERE mc.prospect_id = $1 OR mc.prospect_id IN (SELECT prospect_id FROM excluded))
     )
     SELECT k.kind, k.prospect_id, p.business_name FROM conflicts k JOIN prospects p ON p.id = k.prospect_id
      WHERE k.prospect_id <> $1 AND k.prospect_id NOT IN (SELECT prospect_id FROM excluded)
      ORDER BY k.rank, p.created_at, p.id LIMIT 1`,
    [input.prospectId, recipient, input.draftId ?? null, ACTIVE_SEND_STATUSES],
  );
  const row = result.rows[0];
  return row ? { kind: row.kind, prospectId: String(row.prospect_id), businessName: row.business_name } : null;
}

export function duplicateContactError(conflict: DuplicateContactConflict): AppError {
  const name = conflict.businessName ? `"${conflict.businessName}"` : "another lead";
  const message = conflict.kind === "duplicate_link"
    ? `This lead is linked as a duplicate of ${name}. Send from that lead instead, or restore the link first.`
    : conflict.kind === "linked_hold"
      ? `The linked duplicate ${name} has a recorded contact restriction. Marking a duplicate does not clear opt-outs or holds.`
    : conflict.kind === "contact_history"
      ? `Another lead, ${name}, is already in contact with this address or business domain. Review it or link the duplicate before sending.`
      : `Another lead, ${name}, already owns this address, business domain or website. Review it or link the duplicate before sending.`;
  return new AppError(message, 409, "duplicate_contact");
}

export async function assertNoDuplicateContact(
  input: { prospectId: string; recipient: string; draftId?: string | null },
  db: DbClient,
): Promise<void> {
  const conflict = await findDuplicateContactConflict(input, db);
  if (conflict) throw duplicateContactError(conflict);
}

/**
 * Serializes send reservations: hold this inside the transaction that re-checks the guard and writes
 * the 'sending' row, so two leads sharing an identity cannot both pass the check before either row
 * exists. Lock order is the prospects table, the sending lead's row, then outbound_sends — the same
 * order as the founder's duplicate mark — so a mark and a reservation for the same
 * lead serialize instead of deadlocking: whichever commits first is seen by the other. The table
 * lock is self-conflicting and conflicts with every concurrent outbound_sends write.
 */
export async function lockSendReservations(tx: DbClient, prospectId: string): Promise<void> {
  // Also covers a newly typed address's identity trigger. Never hold these locks across SMTP.
  await tx.query("LOCK TABLE prospects IN SHARE ROW EXCLUSIVE MODE");
  const lead = await tx.query<{ archived_at: string | null; do_not_contact: boolean }>(
    `SELECT archived_at, do_not_contact FROM prospects WHERE id = $1 FOR UPDATE`,
    [prospectId],
  );
  if (!lead.rows[0]) throw new AppError("Prospect not found.", 404);
  if (lead.rows[0].archived_at || lead.rows[0].do_not_contact) {
    throw new AppError("This prospect is archived or marked do not contact.", 409, "do_not_contact");
  }
  await tx.query(`LOCK TABLE outbound_sends IN SHARE ROW EXCLUSIVE MODE`);
}
