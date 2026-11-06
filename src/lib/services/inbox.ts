import { getDb } from "@/lib/db/client";
import { iso } from "@/lib/utils";
import type { AgentTag, ChannelTag } from "@/lib/types";
import { FOLDERS, folderFor, type FolderKey } from "./folders";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The folder inbox (email item 2): every verified lead sits in exactly one folder — the plan's
 * eleven plus On hold (the founder's own do-not-contact, approved 6 Nov 2026) —
 * computed by `folderFor` — the same precedence the folder tests pin — so a lead cannot be in two
 * folders or in none. Any lead with a conversation or email is included regardless of qualification;
 * only never-contacted unverified leads stay on Research. Archived
 * leads only appear in the Archived view.
 *
 * Counts are over all leads that match the filters (sender, agent, search), never over the loaded
 * window, and the list is newest activity first.
 */

export type InboxFolder = FolderKey | "archived";

export const INBOX_PAGE_SIZE = 50;

export interface InboxFilters {
  folder?: string | null;
  /** Business name, domain or any contact address. */
  query?: string | null;
  /** A sending profile id, or "none" for leads without one. */
  sender?: string | null;
  /** An agent tag, or "unknown". */
  agent?: string | null;
  limit?: number;
  /** API traversal uses bounded pages instead of a growing prefix. */
  offset?: number;
  /** Counts-only tools must not fetch message snippets or return lead rows. */
  countsOnly?: boolean;
  /** The open lead: returned even when it is outside the selected folder (e.g. just moved to Won). */
  focus?: string | null;
}

export interface InboxRow {
  prospectId: string;
  businessName: string;
  domain: string | null;
  contactEmail: string | null;
  status: string;
  folder: InboxFolder;
  conversationId: string | null;
  subject: string | null;
  snippet: string | null;
  snippetDirection: "inbound" | "outbound" | null;
  unread: number;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastActivityAt: string | null;
  draftWaiting: { id: string; kind: "first_contact" | "follow_up"; sequence: number; status: string } | null;
  sendingProfileId: string | null;
  sourceAgent: AgentTag | null;
  sourceChannel: ChannelTag | null;
  sourceClient: string | null;
  suppressionReason: string | null;
}

export interface FolderInbox {
  folder: InboxFolder;
  counts: Record<InboxFolder, number>;
  /** Leads in the selected folder (matching the filters), before the window. */
  total: number;
  rows: InboxRow[];
  limit: number;
  hasMore: boolean;
  /** The lead named by `focus`, if it matches the filters; null otherwise. */
  focused: InboxRow | null;
}

export function isInboxFolder(value: string | null | undefined): value is InboxFolder {
  return value === "archived" || FOLDERS.some((folder) => folder.key === value);
}

/** The folder an inbox opens on: the first active folder with work in it, else Needs reply. */
export function defaultFolder(counts: Record<InboxFolder, number>): InboxFolder {
  const order: FolderKey[] = ["needs_reply", "to_approve", "meeting", "in_conversation", "waiting", "new_leads"];
  return order.find((key) => counts[key] > 0) ?? "needs_reply";
}

function emptyCounts(): Record<InboxFolder, number> {
  return Object.fromEntries([...FOLDERS.map((folder) => folder.key), "archived"].map((key) => [key, 0])) as Record<InboxFolder, number>;
}

function latest(...values: (string | null)[]): string | null {
  const times = values.filter((value): value is string => Boolean(value)).map((value) => Date.parse(value)).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

export async function getFolderInbox(filters: InboxFilters = {}): Promise<FolderInbox> {
  const db = await getDb();
  // Qualification governs never-contacted research, not whether an existing email thread exists.
  const conditions = [`(p.qualification_status = 'verified'
    OR EXISTS (SELECT 1 FROM conversations ic WHERE ic.prospect_id = p.id)
    OR EXISTS (SELECT 1 FROM messages im WHERE im.prospect_id = p.id)
    OR EXISTS (SELECT 1 FROM drafts sd WHERE sd.prospect_id = p.id AND sd.status = 'sent'))`];
  const params: unknown[] = [];
  const query = filters.query?.trim();
  if (query) {
    params.push(`%${query}%`);
    const at = params.length;
    conditions.push(`(p.business_name ILIKE $${at} OR coalesce(p.domain_key, '') ILIKE $${at} OR EXISTS (
      SELECT 1 FROM prospect_emails pe WHERE pe.prospect_id = p.id AND pe.email ILIKE $${at}))`);
  }
  if (filters.sender === "none") conditions.push("p.sending_profile_id IS NULL");
  else if (filters.sender) {
    params.push(filters.sender);
    conditions.push(`p.sending_profile_id::text = $${params.length}`);
  }
  if (filters.agent === "unknown") conditions.push("coalesce(p.source_agent, 'unknown') = 'unknown'");
  else if (filters.agent) {
    params.push(filters.agent);
    conditions.push(`p.source_agent = $${params.length}`);
  }

  // One row per lead with everything folderFor needs. The lead's latest conversation is the one
  // shown; suppression is matched on any of the lead's addresses.
  const result = await db.query<any>(
    `SELECT p.id, p.business_name, p.domain_key, p.status, p.archived_at, p.do_not_contact,
        p.sending_profile_id, p.source_agent, p.source_channel, p.source_client, p.updated_at,
        (SELECT pe.email FROM prospect_emails pe WHERE pe.prospect_id = p.id
          ORDER BY pe.is_primary DESC LIMIT 1) AS contact_email,
        (SELECT s.reason FROM suppressions s
          JOIN prospect_emails pe ON pe.normalized_email = s.normalized_email
          WHERE pe.prospect_id = p.id AND s.active = true
          ORDER BY CASE s.reason WHEN 'unsubscribe' THEN 0 WHEN 'opt_out' THEN 1 WHEN 'complaint' THEN 2
            WHEN 'bounce' THEN 3 ELSE 4 END LIMIT 1) AS suppression_reason,
        d.id AS draft_id, d.kind AS draft_kind, d.sequence AS draft_sequence, d.status AS draft_status, d.updated_at AS draft_updated_at,
        c.id AS conversation_id, c.subject, c.unread_count, c.last_inbound_at, c.last_outbound_at,
        (SELECT max(coalesce(m.received_at, m.created_at)) FROM messages m
          LEFT JOIN conversations mc ON mc.id = m.conversation_id
          WHERE coalesce(m.prospect_id, mc.prospect_id) = p.id AND m.direction = 'inbound') AS message_inbound_at,
        (SELECT max(coalesce(m.sent_at, m.created_at)) FROM messages m
          LEFT JOIN conversations mc ON mc.id = m.conversation_id
          WHERE coalesce(m.prospect_id, mc.prospect_id) = p.id AND m.direction = 'outbound') AS message_outbound_at,
        (SELECT max(sd.sent_at) FROM drafts sd WHERE sd.prospect_id = p.id AND sd.status = 'sent') AS draft_sent_at,
        EXISTS (SELECT 1 FROM conversations c2 WHERE c2.prospect_id = p.id AND c2.last_inbound_at IS NOT NULL) AS has_replied
       FROM prospects p
       LEFT JOIN LATERAL (
         SELECT id, kind, sequence, status, updated_at FROM drafts
          WHERE prospect_id = p.id AND status IN ('draft', 'approved')
          ORDER BY updated_at DESC LIMIT 1) d ON true
       LEFT JOIN LATERAL (
         SELECT id, subject, unread_count, last_inbound_at, last_outbound_at FROM conversations
          WHERE prospect_id = p.id
          ORDER BY coalesce(last_message_at, created_at) DESC LIMIT 1) c ON true
      WHERE ${conditions.join(" AND ")}`,
    params,
  );

  const counts = emptyCounts();
  const all: InboxRow[] = result.rows.map((row) => {
    const reason = row.suppression_reason ?? null;
    const lastInboundAt = latest(iso(row.last_inbound_at), iso(row.message_inbound_at));
    const lastOutboundAt = latest(iso(row.last_outbound_at), iso(row.message_outbound_at), iso(row.draft_sent_at));
    const folder = folderFor({
      status: row.status,
      archivedAt: row.archived_at,
      suppressionReason: reason,
      doNotContact: row.do_not_contact === true,
      hasDraftWaiting: Boolean(row.draft_status),
      lastInboundAt,
      lastOutboundAt,
      hasReplied: row.has_replied === true || Boolean(lastInboundAt),
      hasOutbound: Boolean(lastOutboundAt),
    });
    counts[folder] += 1;
    return {
      prospectId: row.id,
      businessName: row.business_name,
      domain: row.domain_key ?? null,
      contactEmail: row.contact_email ?? null,
      status: row.status,
      folder,
      conversationId: row.conversation_id ?? null,
      subject: row.subject ?? null,
      snippet: null,
      snippetDirection: null,
      unread: Number(row.unread_count ?? 0),
      lastInboundAt,
      lastOutboundAt,
      // Email activity first; the lead record's own edit time only when nothing was ever written.
      lastActivityAt: latest(lastInboundAt, lastOutboundAt, iso(row.draft_updated_at)) ?? iso(row.updated_at),
      draftWaiting: row.draft_status
        ? { id: row.draft_id, kind: row.draft_kind, sequence: Number(row.draft_sequence ?? 0), status: row.draft_status }
        : null,
      sendingProfileId: row.sending_profile_id ?? null,
      sourceAgent: row.source_agent ?? null,
      sourceChannel: row.source_channel ?? null,
      sourceClient: row.source_client ?? null,
      suppressionReason: reason,
    };
  });

  const requested = isInboxFolder(filters.folder) ? filters.folder : defaultFolder(counts);
  const inFolder = all
    .filter((row) => row.folder === requested)
    .sort((a, b) => (Date.parse(b.lastActivityAt ?? "") || 0) - (Date.parse(a.lastActivityAt ?? "") || 0) || a.prospectId.localeCompare(b.prospectId));
  const limit = Number.isFinite(filters.limit) && filters.limit! > 0 ? Math.floor(filters.limit!) : INBOX_PAGE_SIZE;
  const offset = Number.isFinite(filters.offset) && filters.offset! > 0 ? Math.floor(filters.offset!) : 0;
  const rows = filters.countsOnly ? [] : inFolder.slice(offset, offset + limit);
  const focused = !filters.countsOnly && filters.focus ? all.find((row) => row.prospectId === filters.focus) ?? null : null;
  const withSnippets = focused && !rows.includes(focused) ? [...rows, focused] : rows;

  // The latest message line for the visible rows only.
  const conversationIds = withSnippets.map((row) => row.conversationId).filter((id): id is string => Boolean(id));
  if (conversationIds.length) {
    const snippets = await db.query<any>(
      `SELECT DISTINCT ON (m.conversation_id) m.conversation_id, m.snippet, m.direction
         FROM messages m WHERE m.conversation_id = ANY($1::uuid[])
        ORDER BY m.conversation_id, coalesce(m.received_at, m.sent_at, m.created_at) DESC`,
      [conversationIds],
    );
    const byConversation = new Map(snippets.rows.map((row) => [row.conversation_id, row]));
    for (const row of withSnippets) {
      const found = row.conversationId ? byConversation.get(row.conversationId) : null;
      if (found) {
        row.snippet = found.snippet ?? null;
        row.snippetDirection = found.direction === "inbound" ? "inbound" : "outbound";
      }
    }
  }

  return { folder: requested, counts, total: inFolder.length, rows, limit, hasMore: inFolder.length > offset + rows.length, focused };
}
