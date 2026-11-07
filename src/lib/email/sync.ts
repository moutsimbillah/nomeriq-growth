import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { getDb } from "@/lib/db/client";
import { decryptSecret } from "@/lib/auth/crypto";
import {
  AppError,
  domainFromUrl,
  isEmail,
  normalizeEmail,
  truncate,
} from "@/lib/utils";
import type { Classification } from "@/lib/types";
import {
  getEmailAccountRecord,
  type EmailAccountRecord,
} from "./accounts";
import { classifyReply, stripQuotedReply } from "./classify";
import { recordOfferRejection } from "@/lib/services/lead-rejections";
import { translateOnArrival } from "@/lib/services/message-translations";
import { recordBounceIfAny } from "./bounce-handling";
import { mayAssociateMessage } from "@/lib/services/message-linking";
import { listUncopiedSentMessages, saveSentCopyForMessage } from "./sent-copy";
import { recomputeConversationChronology } from "./conversation-chronology";
import { getParsedBounceInput, isAutoReply, parseBounceReports } from "./bounces";
import { matchRecoveryOwner, recoverySqlLookups } from "./recovery-matching";

export interface SyncOptions {
  mode?: "incremental" | "backfill";
  founderUserId?: string;
  /** Explicit physical-folder stage; omitted retains legacy all-folder recovery. */
  recoveryFolder?: "Sent Items" | "INBOX";
  linkCertainAddresses?: boolean;
  processHistoricalBounces?: boolean;
}

const RECOVERY_PAGE_SIZE = 100;

/* eslint-disable @typescript-eslint/no-explicit-any */

const syncing = new Set<string>();
const MAX_PER_FOLDER = 40;
const INITIAL_DAYS = 30;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface SyncResult {
  /** Backfill coverage only: false on caps, missing folders or any failure. */
  complete?: boolean;
  mode?: "incremental" | "backfill";
  filled?: number;
  progress?: { folder: string; uidValidity: number; lastUid: number; remaining: number; complete: boolean }[];
  /** The inbound rows this run was able to attach to a lead, and how each was found. */
  rematched?: { scanned: number; matched: number; byAddress: number; byDomain: number } | null;
  /** The Sent-folder copies this run wrote, or confirmed. */
  sentCopies?: { attempted: number; saved: number; alreadyPresent: number } | null;
  /** True when this run paused the profile on its own bounce rate. */
  pausedByBounceRate?: boolean;
  accountId: string;
  imported: number;
  skipped: number;
  errors: string[];
  historyIncomplete: boolean;
  folders: { folder: string; imported: number; scanned: number }[];
  sandbox?: boolean;
  note?: string;
}

function emailDomain(email: string): string | null {
  const domain = email.split("@")[1]?.toLowerCase();
  return domain || null;
}

async function findThreadConversation(
  messageIds: string[],
): Promise<{ conversationId: string; prospectId: string } | null> {
  const ids = messageIds.filter(Boolean);
  if (!ids.length) return null;
  const threads = await recoverySqlLookups(await getDb()).threads(ids);
  if (threads.length > 1) return { conversationId: "", prospectId: "" };
  return threads.length === 1 && threads[0].prospectId ? threads[0] : null;
}

async function findProspectByEmail(email: string) {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT DISTINCT p.id FROM prospects p
     JOIN prospect_emails pe ON pe.prospect_id = p.id
     WHERE pe.normalized_email = $1 AND p.archived_at IS NULL LIMIT 2`,
    [normalizeEmail(email)],
  );
  // A shared generic inbox is ambiguous; only attach when exactly one prospect
  // owns it. Thread headers and domain matching still resolve the rest.
  return result.rows.length === 1 ? result.rows[0].id : null;
}

async function findProspectByDomain(domain: string | null) {
  if (!domain) return null;
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT id FROM prospects
     WHERE domain_key = $1 AND archived_at IS NULL LIMIT 2`,
    [domain],
  );
  return result.rows.length === 1 ? result.rows[0].id : null;
}

async function conversationForProspect(
  prospectId: string,
  subject: string,
  seedWhen: string,
): Promise<string> {
  const db = await getDb();
  const existing = await db.query<any>(
    `SELECT id FROM conversations WHERE prospect_id = $1 LIMIT 1`,
    [prospectId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const id = crypto.randomUUID();
  const inserted = await db.query<any>(
    `INSERT INTO conversations
      (id, prospect_id, subject, status, last_message_at)
     VALUES ($1, $2, $3, 'open', $4)
     ON CONFLICT (prospect_id) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [id, prospectId, subject || "(no subject)", seedWhen],
  );
  return inserted.rows[0]?.id ?? id;
}

async function resolveMessageOwner(input: {
  direction: "inbound" | "outbound";
  fromEmail: string;
  toEmails: string[];
  inReplyTo: string | null;
  references: string[];
  subject: string;
  when: string;
  recovery?: boolean;
}): Promise<{
  prospectId: string | null;
  conversationId: string | null;
  matchedBy: string;
}> {
  if (input.recovery) return matchRecoveryOwner(input, recoverySqlLookups(await getDb()));
  const threadMessageIds = [
    ...(input.inReplyTo ? [input.inReplyTo] : []),
    ...input.references,
  ];
  if (threadMessageIds.length) {
    const thread = await findThreadConversation(threadMessageIds);
    if (thread) {
      if (!thread.prospectId) return { prospectId: null, conversationId: null, matchedBy: "ambiguous_thread_headers" };
      return {
        prospectId: thread.prospectId,
        conversationId: thread.conversationId,
        matchedBy: "thread_headers",
      };
    }
  }

  const candidateEmails =
    input.direction === "inbound"
      ? [input.fromEmail]
      : input.toEmails.filter((email) => isEmail(email));
  const db = await getDb();
  const exact = await db.query<{ id: string }>(`SELECT DISTINCT p.id FROM prospects p
    JOIN prospect_emails pe ON pe.prospect_id = p.id
    WHERE pe.normalized_email = ANY($1::text[]) AND p.archived_at IS NULL LIMIT 2`,
    [candidateEmails.map(normalizeEmail)]);
  const candidates = new Set(exact.rows.map(row => row.id));
  if (candidates.size === 1) {
    const prospectId = [...candidates][0];
    const conversationId = await conversationForProspect(prospectId, input.subject, input.when);
    return { prospectId, conversationId, matchedBy: "exact_email" };
  }


  return { prospectId: null, conversationId: null, matchedBy: "unmatched" };
}

function normalizeReferences(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    return value
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function bodyText(parsed: ParsedMail): string {
  if (parsed.text?.trim()) return parsed.text.trim();
  if (parsed.html) {
    return String(parsed.html)
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

export async function applyInboundEffect(
  conversationId: string,
  prospectId: string,
  body: string,
  subject: string,
  receivedAt: string,
  messageDbId?: string,
): Promise<void> {
  const db = await getDb();
  const classification = classifyReply(body);
  await db.transaction(async (tx) => {
    // Record even an out-of-order genuine rejection. Chronology must not erase its objection/hold.
    if (messageDbId) await recordOfferRejection(tx, prospectId, messageDbId);
    const clock = await tx.query<{ last_message_at: string | null }>(
      `SELECT last_message_at FROM conversations WHERE id = $1 FOR UPDATE`, [conversationId]);
    if (clock.rows[0]?.last_message_at && new Date(clock.rows[0].last_message_at).getTime() > new Date(receivedAt).getTime()) {
      await recomputeConversationChronology(tx, prospectId);
      return;
    }
    await tx.query(
      `UPDATE conversations SET
        status = 'replied',
        classification = $1,
        classification_source = 'rules',
        classification_confidence = $2,
        last_message_at = $3,
        last_inbound_at = $3,
        unread_count = unread_count + 1,
        updated_at = now()
       WHERE id = $4`,
      [classification.classification, classification.confidence, receivedAt, conversationId],
    );
    await tx.query(
      `UPDATE drafts SET status = 'cancelled', updated_at = now()
       WHERE prospect_id = $1 AND kind = 'follow_up' AND status IN ('draft', 'approved')`,
      [prospectId],
    );
    await tx.query(
      `UPDATE prospects SET
        last_reply_at = $1,
        status = CASE
          WHEN status IN ('new', 'verified', 'draft_prepared', 'contacted', 'replied') THEN 'replied'
          ELSE status END,
        next_action = CASE
          WHEN status IN ('new', 'verified', 'draft_prepared', 'contacted', 'replied') THEN 'Read and respond to the reply'
          ELSE next_action END,
        updated_at = now()
       WHERE id = $2`,
      [receivedAt, prospectId],
    );

    if (classification.classification === "not_interested") {
      await tx.query(`UPDATE prospects SET next_action = 'Review rejection and confirm Closed/Lost; automatic follow-ups stopped', updated_at=now() WHERE id=$1`, [prospectId]);
    }
    if (classification.classification === "unsubscribe") {
      const emailResult = await tx.query<{ email: string }>(
        `SELECT email FROM prospect_emails WHERE prospect_id = $1
         ORDER BY is_primary DESC LIMIT 1`,
        [prospectId],
      );
      const email = emailResult.rows[0]?.email;
      if (email) {
        await tx.query(
          `INSERT INTO suppressions
            (id, normalized_email, email, reason, source, prospect_id, note)
           VALUES ($1, $2, $3, $4, 'inbound_reply', $5, $6)
           ON CONFLICT (normalized_email) DO UPDATE SET
             active = true, reason = excluded.reason, updated_at = now()`,
          [
            crypto.randomUUID(),
            normalizeEmail(email),
            email,
            "unsubscribe",
            prospectId,
            truncate(body, 400),
          ],
        );
      }
      await tx.query(
        `UPDATE prospects SET do_not_contact = true, status = 'lost',
          next_action = 'No further contact — opt-out recorded', updated_at = now()
         WHERE id = $1`,
        [prospectId],
      );
    }
  });
}

async function applyOutboundEffect(
  conversationId: string,
  prospectId: string,
  when: string,
): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const clock = await tx.query<{ last_message_at: string | null }>(
      `SELECT last_message_at FROM conversations WHERE id = $1 FOR UPDATE`, [conversationId]);
    if (clock.rows[0]?.last_message_at && new Date(clock.rows[0].last_message_at).getTime() > new Date(when).getTime()) {
      await recomputeConversationChronology(tx, prospectId);
      return;
    }
    await tx.query(
      `UPDATE conversations SET
        last_message_at = $1, last_outbound_at = $1, status = 'waiting',
        updated_at = now()
       WHERE id = $2`,
      [when, conversationId],
    );
    await tx.query(
      `UPDATE prospects SET last_contacted_at = $1,
        status = CASE WHEN status IN ('new', 'verified', 'draft_prepared') THEN 'contacted' ELSE status END,
        next_action = CASE WHEN status IN ('new', 'verified', 'draft_prepared') THEN 'Wait for a reply' ELSE next_action END,
        updated_at = now()
       WHERE id = $2`,
      [when, prospectId],
    );
    await tx.query(
      `UPDATE drafts SET status = 'cancelled', updated_at = now()
       WHERE prospect_id = $1 AND kind = 'follow_up' AND status IN ('draft', 'approved')`,
      [prospectId],
    );
  });
}

/**
 * Exported so the duplicate-and-fill behaviour can be tested without an IMAP server: it takes a parsed
 * message and does the database work, which is the part that can be wrong.
 */
export async function storeParsedMessage(input: {
  parsed: ParsedMail;
  account: EmailAccountRecord;
  direction: "inbound" | "outbound";
  folderPath: string;
  folderLabel: "INBOX" | "Sent";
  uid: number;
  uidValidity: number;
  isSeen: boolean;
  internalDate: Date | null;
}, options: SyncOptions = {}): Promise<{
  inserted: boolean;
  /** True when an existing row was given the body it was missing. */
  filled: boolean;
  conversationId: string | null;
  prospectId: string | null;
}> {
  const db = await getDb();
  const parsed = input.parsed;
  const fromEntry = parsed.from?.value?.[0];
  const fromEmail = normalizeEmail(fromEntry?.address || input.account.emailAddress);
  const toEmails = (parsed.to
    ? Array.isArray(parsed.to)
      ? parsed.to
      : [parsed.to]
    : []
  )
    .flatMap((entry) => entry.value ?? [])
    .map((value) => normalizeEmail(value.address ?? ""))
    .filter(Boolean);
  const ccEmails = (parsed.cc
    ? Array.isArray(parsed.cc)
      ? parsed.cc
      : [parsed.cc]
    : []
  )
    .flatMap((entry) => entry.value ?? [])
    .map((value) => normalizeEmail(value.address ?? ""))
    .filter(Boolean);
  const messageId = parsed.messageId?.trim() || null;
  const inReplyTo = parsed.inReplyTo?.trim() || null;
  const references = normalizeReferences(parsed.references);
  const subject = parsed.subject || "(no subject)";
  const parsedDate = parsed.date
    ? parsed.date instanceof Date
      ? parsed.date
      : new Date(parsed.date)
    : null;
  const date = parsedDate || input.internalDate || new Date();

  const bounceInput = getParsedBounceInput(parsed);
  const deliveryReport = input.direction === "inbound" && (
    parseBounceReports(bounceInput).length > 0 ||
    /multipart\/report|message\/delivery-status|feedback-report/i.test(bounceInput.contentType ?? ""));
  const autoReply = input.direction === "inbound" && isAutoReply(bounceInput);
  const rawMessageHeaders = JSON.stringify({
    deliveryReport,
    autoReply,
    ...(deliveryReport ? { bounceInput, historicalBouncePending: options.mode === "backfill" } : {}),
    returnPath: parsed.headers.get("return-path") || null,
    replyTo: parsed.headers.get("reply-to") || null,
    folderLabel: input.folderLabel,
  });

  const text = bodyText(parsed);
  const html = parsed.html ? String(parsed.html) : null;
  const snippet = truncate(stripQuotedReply(text), 220);

  const duplicate = await db.query<{ id: string; body_text: string | null; error: string | null; conversation_id: string | null; prospect_id: string | null }>(
    `SELECT id, body_text, error, conversation_id, prospect_id FROM messages
     WHERE (account_id = $1 AND folder = $2 AND uidvalidity = $3 AND uid = $4)
        OR (account_id = $1 AND message_id = $5)
     LIMIT 2`,
    [
      input.account.id,
      input.folderPath,
      input.uidValidity,
      input.uid,
      messageId,
    ],
  );
  if (duplicate.rows.length > 1) throw new AppError("Message-ID and UID identify different stored messages.", 409, "message_identity_conflict");
  const existing = duplicate.rows[0];
  if (existing) {
    if (options.mode === "backfill" && !existing.prospect_id && !existing.conversation_id && !deliveryReport && !autoReply) {
      const owner = await resolveMessageOwner({ direction: input.direction, fromEmail, toEmails,
        inReplyTo, references, subject, when: date.toISOString(), recovery: true });
      if (owner.prospectId && owner.conversationId && await mayAssociateMessage(db, existing.id, owner.prospectId)) {
        const linked = await db.query(`UPDATE messages SET prospect_id = $2, conversation_id = $3, matched_by = $4
          WHERE id = $1 AND prospect_id IS NULL AND conversation_id IS NULL`,
          [existing.id, owner.prospectId, owner.conversationId, owner.matchedBy]);
        if (linked.rowCount) { existing.prospect_id = owner.prospectId; existing.conversation_id = owner.conversationId; }
      }
    }
    // Only blank bodies or the exact known legacy excerpt marker are replaceable.
    // Unmarked nonblank bodies (including short ones) are authoritative and preserved.
    if (deliveryReport || autoReply) {
      await db.query(`UPDATE messages SET raw_headers = coalesce(raw_headers, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
        [existing.id, rawMessageHeaders]);
    }
    if (deliveryReport && options.mode === "backfill" && options.processHistoricalBounces === true) {
      await recordBounceIfAny({ accountId: input.account.id, messageDbId: existing.id, ...bounceInput });
      await db.query(`UPDATE messages SET raw_headers = raw_headers || '{"historicalBouncePending":false}'::jsonb WHERE id=$1`, [existing.id]);
    }
    if (options.mode === "backfill" && existing.prospect_id) {
      await db.transaction(tx => recomputeConversationChronology(tx, existing.prospect_id!));
    }
    if (!text.trim() || (existing.body_text?.trim() && existing.error !== "excerpt only, full body pending mailbox sync")) {
      return { inserted: false, filled: false, conversationId: existing.conversation_id, prospectId: existing.prospect_id };
    }
    const filled = await db.query<{ conversation_id: string | null; prospect_id: string | null }>(
      `UPDATE messages SET
         body_text = $2,
         body_html = $3,
         snippet = $4,
         error = CASE WHEN error = 'excerpt only, full body pending mailbox sync' THEN NULL ELSE error END,
         subject = CASE WHEN subject IS NULL OR subject = '' OR subject = '(no subject)'
                        THEN $5 ELSE subject END,
         cc_emails = CASE WHEN cc_emails IS NULL OR cc_emails = '[]'::jsonb
                          THEN $6::jsonb ELSE cc_emails END,
         from_name = coalesce(nullif(from_name, ''), $7),
         raw_headers = coalesce(raw_headers, '{}'::jsonb) || $8::jsonb
       WHERE id = $1 AND (body_text IS NULL OR btrim(body_text) = '' OR error = 'excerpt only, full body pending mailbox sync')
       RETURNING conversation_id, prospect_id`,
      [
        existing.id,
        text,
        html,
        snippet,
        subject,
        JSON.stringify(ccEmails),
        fromEntry?.name || null,
        rawMessageHeaders,
      ],
    );
    const row = filled.rows[0];
    if (row?.prospect_id) await db.transaction(tx => recomputeConversationChronology(tx, row.prospect_id!));
    return {
      inserted: false,
      filled: Boolean(row),
      conversationId: row?.conversation_id ?? null,
      prospectId: row?.prospect_id ?? null,
    };
  }

  const owner = await resolveMessageOwner({
    direction: input.direction,
    fromEmail,
    toEmails,
    inReplyTo,
    references,
    subject,
    when: date.toISOString(),
    recovery: options.mode === "backfill",
  });

  const messageDbId = crypto.randomUUID();
  const attachmentMetadata = (parsed.attachments ?? []).map((attachment) => ({
    id: crypto.randomUUID(),
    filename: attachment.filename || "attachment",
    contentType: attachment.contentType || "application/octet-stream",
    size: attachment.size || attachment.content?.length || 0,
  }));
  const insert = await db.query(
    `INSERT INTO messages (
      id, conversation_id, prospect_id, account_id, direction, source, folder,
      uidvalidity, uid, message_id, in_reply_to, references_json, from_email,
      from_name, to_emails, cc_emails, subject, body_text, body_html, snippet,
      sent_at, received_at, is_read, is_sandbox, delivery_status, attachments,
      external, matched_by, raw_headers
    ) VALUES (
      $1, $2, $3, $4, $5, 'imap', $6, $7, $8, $9, $10, $11::jsonb, $12, $13,
      $14::jsonb, $15::jsonb, $16, $17, $18, $19, $20, $21, $22, false, 'accepted',
      $23::jsonb, $24, $25, $26::jsonb
    ) ON CONFLICT DO NOTHING`,
    [
      messageDbId,
      owner.conversationId,
      owner.prospectId,
      input.account.id,
      input.direction,
      input.folderPath,
      input.uidValidity,
      input.uid,
      messageId,
      inReplyTo,
      JSON.stringify(references),
      fromEmail,
      fromEntry?.name || null,
      JSON.stringify(toEmails),
      JSON.stringify(ccEmails),
      subject,
      text,
      html,
      truncate(stripQuotedReply(text), 220),
      input.direction === "outbound" ? date.toISOString() : null,
      input.direction === "inbound" ? date.toISOString() : null,
      input.direction === "outbound" ? true : input.isSeen,
      attachmentMetadata.length ? JSON.stringify(attachmentMetadata) : "[]",
      input.direction === "outbound",
      owner.matchedBy,
      rawMessageHeaders,
    ],
  );
  if (!insert.rowCount) {
    return { inserted: false, filled: false, conversationId: null, prospectId: null };
  }

  let storedBytes = 0;
  for (const [index, attachment] of (parsed.attachments ?? []).entries()) {
    const content = attachment.content;
    if (
      !content ||
      storedBytes + content.length > MAX_ATTACHMENT_BYTES ||
      content.length > MAX_ATTACHMENT_BYTES
    ) {
      continue;
    }
    storedBytes += content.length;
    await db.query(
      `INSERT INTO message_attachments
        (id, message_id, filename, content_type, size, content)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        attachmentMetadata[index]?.id ?? crypto.randomUUID(),
        messageDbId,
        attachment.filename || "attachment",
        attachment.contentType || "application/octet-stream",
        content.length,
        new Uint8Array(content),
      ],
    );
  }

  // A delivery report is checked BEFORE anything treats the message as a reply. A bounce is a
  // transport fact about one address: it must not mark the thread answered, and it must not cancel a
  // follow-up as though the prospect had written back. `recordBounceIfAny` answers `isBounce: false`
  // for ordinary mail, which then takes the reply path unchanged.
  const bounce =
    input.direction === "inbound" && (options.mode !== "backfill" || options.processHistoricalBounces === true)
      ? await recordBounceIfAny({
          accountId: input.account.id,
          messageDbId,
          ...bounceInput,
        }).catch((error) => { if (options.mode === "backfill") throw error; return null; })
      : null;

  if (deliveryReport && bounce?.isBounce) await db.query(
    `UPDATE messages SET raw_headers = raw_headers || '{"historicalBouncePending":false}'::jsonb WHERE id=$1`, [messageDbId]);

  if (deliveryReport || autoReply || bounce?.isBounce) {
    // Recorded against the report itself, not the thread: the row keeps its owner when the headers
    // found one, and stays unmatched (and therefore out of every reply count) when they did not.
    return {
      inserted: true,
      filled: false,
      conversationId: owner.conversationId,
      prospectId: owner.prospectId,
    };
  }

  if (owner.conversationId && owner.prospectId) {
    if (options.mode === "backfill") {
      await db.transaction(tx => recomputeConversationChronology(tx, owner.prospectId!));
      return { inserted: true, filled: false, conversationId: owner.conversationId, prospectId: owner.prospectId };
    }
    if (input.direction === "inbound") {
      await applyInboundEffect(
        owner.conversationId,
        owner.prospectId,
        stripQuotedReply(text),
        subject,
        date.toISOString(),
        messageDbId,
      );
      // Fire-and-forget: never blocks or fails message ingest.
      void translateOnArrival(messageDbId);
    } else {
      await applyOutboundEffect(
        owner.conversationId,
        owner.prospectId,
        date.toISOString(),
      );
    }
  }

  return {
    inserted: true,
    filled: false,
    conversationId: owner.conversationId,
    prospectId: owner.prospectId,
  };
}

async function saveSyncState(input: {
  accountId: string;
  folder: string;
  uidValidity: number;
  lastUid: number;
  historyComplete: boolean;
  error: string | null;
}): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO mailbox_sync_state
      (id, account_id, folder, uidvalidity, last_uid, last_synced_at,
       history_complete, error, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), $6, $7, now())
     ON CONFLICT (account_id, folder) DO UPDATE SET
       uidvalidity = excluded.uidvalidity,
       last_uid = CASE
         WHEN mailbox_sync_state.uidvalidity = excluded.uidvalidity
           THEN GREATEST(mailbox_sync_state.last_uid, excluded.last_uid)
         ELSE excluded.last_uid
       END,
       last_synced_at = now(),
       history_complete = CASE
         WHEN mailbox_sync_state.uidvalidity = excluded.uidvalidity
           THEN mailbox_sync_state.history_complete AND excluded.history_complete
         ELSE excluded.history_complete
       END,
       error = excluded.error,
       updated_at = now()`,
    [
      crypto.randomUUID(),
      input.accountId,
      input.folder,
      input.uidValidity,
      input.lastUid,
      input.historyComplete,
      input.error,
    ],
  );
}

/** One bounded page per physical folder. Its independent checkpoint never advances the live cursor. */
async function recoverMailbox(
  client: ImapFlow, account: EmailAccountRecord,
  mailboxes: { path: string; specialUse?: string }[], options: SyncOptions, result: SyncResult,
): Promise<SyncResult> {
  const db = await getDb();
  const sent = mailboxes.filter(box => /\\Sent/i.test(box.specialUse ?? "") || /sent/i.test(box.path));
  result.complete = false;
  // Staged recovery never substitutes a special-use or similarly named mailbox.
  if (options.recoveryFolder !== undefined && !mailboxes.some(box => box.path === options.recoveryFolder)) {
    result.errors.push(`Requested recovery folder ${options.recoveryFolder} not found; recovery is incomplete.`);
    result.historyIncomplete = true;
    return result;
  }
  const folders = options.recoveryFolder !== undefined
    ? [{ label: options.recoveryFolder === "INBOX" ? "INBOX" as const : "Sent" as const, path: options.recoveryFolder }]
    : [{ label: "INBOX" as const, path: "INBOX" },
      ...sent.map(box => ({ label: "Sent" as const, path: box.path }))]
      .filter((box, index, all) => all.findIndex(other => other.path === box.path) === index);
  if (options.recoveryFolder === undefined && !sent.length) {
    result.errors.push("No Sent folder found; recovery is incomplete.");
    result.historyIncomplete = true;
  }
  for (const folder of folders) {
    const key = `backfill:${folder.path}`;
    let lastUid = 0;
    let uidValidity = 0;
    let scanned = 0;
    let imported = 0;
    let remaining = 0;
    let complete = false;
    let error: string | null = null;
    try {
      const mailbox = await client.mailboxOpen(folder.path, { readOnly: true });
      uidValidity = Number(mailbox.uidValidity);
      if (!Number.isSafeInteger(uidValidity) || uidValidity <= 0) throw new Error("Invalid UIDVALIDITY");
      if (mailbox.readOnly !== true) throw new Error("Recovery folder did not confirm read-only access; checkpoint held");
      const saved = await db.query<{ uidvalidity: string; last_uid: string }>(
        `SELECT uidvalidity, last_uid FROM mailbox_sync_state WHERE account_id = $1 AND folder = $2`, [account.id, key]);
      if (Number(saved.rows[0]?.uidvalidity) === uidValidity) lastUid = Number(saved.rows[0]?.last_uid) || 0;
      // No SINCE or newest-N policy. UID results are numerically filtered because IMAP n:* may return n-1.
      const found = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
      if (!Array.isArray(found)) throw new Error("Mailbox search did not return UIDs");
      const retained = [...new Set(found)].filter(uid => uid > lastUid).sort((a, b) => a - b);
      remaining = retained.length;
      for (const uid of retained.slice(0, RECOVERY_PAGE_SIZE)) {
        let fetched = false;
        for await (const message of client.fetch(String(uid), { source: true, flags: true, internalDate: true }, { uid: true })) {
          if (message.uid !== uid || !message.source) throw new Error(`UID ${uid} source unavailable`);
          if (message.source.length > 32 * 1024 * 1024) throw new Error(`UID ${uid} exceeds the recovery message-size limit; checkpoint held`);
          const parsed = await simpleParser(message.source);
          if (options.recoveryFolder === "Sent Items") {
            const senders = parsed.from?.value ?? [];
            if (senders.length !== 1 || normalizeEmail(senders[0].address ?? "") !== normalizeEmail(account.emailAddress)) {
              throw new Error(`UID ${uid} is not from the selected founder mailbox; checkpoint held`);
            }
          }
          const stored = await storeParsedMessage({
            parsed, account,
            direction: folder.label === "INBOX" ? "inbound" : "outbound",
            folderPath: folder.path, folderLabel: folder.label, uid, uidValidity,
            isSeen: message.flags?.has("\\Seen") ?? false,
            internalDate: message.internalDate ? new Date(message.internalDate) : null,
          }, options);
          if (stored.inserted) { imported++; result.imported++; }
          else { result.skipped++; }
          if (stored.filled) result.filled = (result.filled ?? 0) + 1;
          fetched = true;
        }
        if (!fetched) throw new Error(`UID ${uid} not fetched; checkpoint held for retry`);
        lastUid = uid;
        scanned++;
        remaining--;
      }
      complete = remaining === 0;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Recovery folder failed";
      result.errors.push(`${folder.path}: ${error}`);
    }
    if (uidValidity > 0) await db.query(`INSERT INTO mailbox_sync_state
      (id, account_id, folder, uidvalidity, last_uid, last_synced_at, history_complete, error)
      VALUES ($1,$2,$3,$4,$5,now(),$6,$7)
      ON CONFLICT (account_id, folder) DO UPDATE SET uidvalidity = excluded.uidvalidity,
      last_uid = excluded.last_uid, last_synced_at = now(), history_complete = excluded.history_complete,
      error = excluded.error, updated_at = now()`,
      [crypto.randomUUID(), account.id, key, uidValidity, lastUid, complete, error]);
    if (!complete) result.historyIncomplete = true;
    result.folders.push({ folder: folder.path, imported, scanned });
    result.progress!.push({ folder: folder.path, uidValidity, lastUid, remaining, complete });
    if (error) break; // A failure never proceeds to another physical folder.
  }
  result.complete = !result.historyIncomplete && result.errors.length === 0;
  return result;
}

export async function syncEmailAccount(accountId: string, options: SyncOptions = {}): Promise<SyncResult> {
  if (options.recoveryFolder !== undefined) {
    if (options.mode !== "backfill") throw new AppError("Recovery folder requires explicit backfill mode.", 400, "backfill_required");
    if (options.recoveryFolder !== "Sent Items" && options.recoveryFolder !== "INBOX") {
      throw new AppError("Recovery folder must be exactly Sent Items or INBOX.", 400, "invalid_recovery_folder");
    }
  }
  if (options.linkCertainAddresses) throw new AppError(
    "Address-book linking is a separate explicitly approved operation.", 400, "address_linking_separate_operation");
  if (options.mode === "backfill") {
    if (!options.founderUserId) throw new AppError("Backfill requires explicit founder approval.", 403, "founder_required");
    const db = await getDb();
    const founder = await db.query(`SELECT id FROM users WHERE id = $1 AND role = 'founder' AND is_active = true`, [options.founderUserId]);
    if (!founder.rows.length) throw new AppError("Backfill requires an active founder.", 403, "founder_required");
  } else if (options.linkCertainAddresses || options.processHistoricalBounces) {
    throw new AppError("Recovery flags require explicit backfill mode.", 400, "backfill_required");
  }
  if (syncing.has(accountId)) {
    throw new AppError("This mailbox is already syncing.", 409, "sync_in_progress");
  }
  syncing.add(accountId);
  try {
    const account = await getEmailAccountRecord(accountId);
    if (!account) throw new AppError("Email account not found.", 404);
    if (account.provider === "sandbox") {
      return {
        accountId,
        imported: 0,
        skipped: 0,
        errors: [],
        historyIncomplete: false,
        folders: [],
        sandbox: true,
        note: "This is a sandbox mailbox. Use “Simulate a reply” on a conversation to test inbound handling. No IMAP connection is made.",
      };
    }
    if (account.status === "disabled") {
      throw new AppError("This email account is disabled.", 409);
    }

    const result: SyncResult = {
      mode: options.mode ?? "incremental",
      filled: 0,
      progress: [],
      accountId,
      imported: 0,
      skipped: 0,
      errors: [],
      historyIncomplete: false,
      folders: [],
    };
    const client = new ImapFlow({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapSecure,
      auth: {
        user: account.username,
        pass: decryptSecret(account.passwordEncrypted),
      },
      logger: false,
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 60_000,
      tls: { minVersion: "TLSv1.2" },
    });

    try {
      await client.connect();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "IMAP connection failed.";
      if (options.mode !== "backfill") await saveSyncState({
        accountId,
        folder: "INBOX",
        uidValidity: 0,
        lastUid: 0,
        historyComplete: false,
        error: message,
      }).catch(() => undefined);
      throw new AppError(
        `Could not connect to IMAP. Check Settings and try again. ${message.slice(0, 250)}`,
        502,
        "imap_connect_failed",
      );
    }

    try {
      const mailboxes = await client.list();
      if (options.mode === "backfill") {
        return await recoverMailbox(client, account, mailboxes, options, result);
      }
      const sentBox =
        mailboxes.find((mailbox) => /\\Sent/i.test(mailbox.specialUse ?? "")) ||
        mailboxes.find((mailbox) => /^sent( items)?$/i.test(mailbox.path)) ||
        mailboxes.find((mailbox) => /sent/i.test(mailbox.path));

      const folders: { label: "INBOX" | "Sent"; path: string }[] = [
        { label: "INBOX", path: "INBOX" },
      ];
      if (sentBox) folders.push({ label: "Sent", path: sentBox.path });
      else {
        result.errors.push(
          "No Sent folder was found. Emails sent directly in IONOS cannot be synchronized until a Sent folder is available.",
        );
        result.historyIncomplete = true;
      }

      for (const folder of folders) {
        let folderImported = 0;
        let scanned = 0;
        let uidValidity = 0;
        let lastUid = 0;
        let historyComplete = false;
        try {
          const mailbox = await client.mailboxOpen(folder.path, { readOnly: true });
          uidValidity = Number(mailbox.uidValidity);
          const db = await getDb();
          const stateResult = await db.query<any>(
            `SELECT * FROM mailbox_sync_state WHERE account_id = $1 AND folder = $2`,
            [accountId, folder.label],
          );
          const state = stateResult.rows[0];
          const reset =
            !state ||
            Number(state.uidvalidity) !== uidValidity ||
            Number(state.last_uid) === 0;

          let uids: number[] = [];
          if (reset) {
            const since = new Date(Date.now() - INITIAL_DAYS * 86_400_000);
            const found = await client.search({ since }, { uid: true });
            uids = Array.isArray(found) ? found : [];
            if (uids.length > MAX_PER_FOLDER) {
              uids = uids.slice(-MAX_PER_FOLDER);
              historyComplete = false;
            } else {
              // Even a complete 30-day backfill is not the full mailbox history.
              historyComplete = false;
            }
          } else {
            const fromUid = Number(state.last_uid) + 1;
            const found = await client.search(
              { uid: `${fromUid}:*` },
              { uid: true },
            );
            uids = Array.isArray(found) ? found : [];
            historyComplete = Boolean(state.history_complete);
            if (uids.length > MAX_PER_FOLDER) {
              uids = uids.slice(0, MAX_PER_FOLDER);
              historyComplete = false;
            }
          }

          for (const uid of uids) {
            scanned += 1;
            try {
              for await (const message of client.fetch(
                String(uid),
                {
                  source: true,
                  envelope: true,
                  flags: true,
                  internalDate: true,
                },
                { uid: true },
              )) {
                if (!message.source) continue;
                const parsed = await simpleParser(message.source);
                const stored = await storeParsedMessage({
                  parsed,
                  account,
                  direction: folder.label === "INBOX" ? "inbound" : "outbound",
                  folderPath: folder.path,
                  folderLabel: folder.label,
                  uid,
                  uidValidity,
                  isSeen: message.flags?.has("\\Seen") ?? false,
                  internalDate: message.internalDate
                    ? new Date(message.internalDate)
                    : null,
                });
                if (stored.inserted) {
                  folderImported += 1;
                  result.imported += 1;
                } else {
                  result.skipped += 1;
                }
                if (stored.filled) result.filled = (result.filled ?? 0) + 1;
                lastUid = Math.max(lastUid, uid);
              }
            } catch (error) {
              result.errors.push(
                `${folder.label} UID ${uid}: ${error instanceof Error ? error.message : "could not parse message"}`,
              );
            }
          }

          if (!lastUid && state?.last_uid) lastUid = Number(state.last_uid);
          await saveSyncState({
            accountId,
            folder: folder.label,
            uidValidity,
            lastUid,
            historyComplete,
            error: null,
          });
          if (!historyComplete) result.historyIncomplete = true;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Folder sync failed.";
          result.errors.push(`${folder.label}: ${message}`);
          result.historyIncomplete = true;
          await saveSyncState({
            accountId,
            folder: folder.label,
            uidValidity,
            lastUid,
            historyComplete: false,
            error: message,
          }).catch(() => undefined);
        }
        result.folders.push({
          folder: folder.label,
          imported: folderImported,
          scanned,
        });
      }

      const db = await getDb();
      await db.query(
        // A successful sync says the mailbox is reachable, which is not the same as "allowed to
        // send": a profile paused by its bounce rate stays paused until the founder lifts it.
        `UPDATE email_accounts SET last_sync_at = now(), last_checked_at = now(),
          status = CASE WHEN status = 'paused_bounce' THEN status ELSE 'connected' END,
          last_error = CASE WHEN status = 'paused_bounce' THEN last_error ELSE null END,
          updated_at = now()
         WHERE id = $1`,
        [accountId],
      );
    } finally {
      await client.logout().catch(() => undefined);
    }
    // Everything below is local. A sync that read the mailbox has done its job even if these fail,
    // so they are attempted and reported rather than allowed to fail the run.
    // Recovery/linking is never enabled by deploying code or running the ordinary scheduler.
    result.rematched = null;
    result.sentCopies = await backfillSentCopies(account.id).catch(() => null);
    // New, attributable reports perform their own rate check. A no-op/replay sync must not pause.
    result.pausedByBounceRate = false;

    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      error instanceof Error ? error.message : "Mailbox sync failed.",
      502,
      "sync_failed",
    );
  } finally {
    syncing.delete(accountId);
  }
}

/**
 * Re-run the owner match for inbound messages that never found one.
 *
 * The sync already matches on thread headers, then the exact sender address, then the sender's
 * non-generic domain. This exists for the rows that arrived *before* the lead they belong to was in
 * the database — the import's unmatched inbound — so a later run can attach them instead of leaving
 * them invisible in the Inbox for ever.
 *
 * It only ever fills a null owner: a message already attached to a lead is never moved, because the
 * thread it sits in is the history the founder has already read. Every match is written with the
 * reason it was found (`matched_by`), so an attach can be explained afterwards.
 */
export async function rematchUnmatchedInbound(
  limit = 200,
): Promise<{ scanned: number; matched: number; byAddress: number; byDomain: number }> {
  const db = await getDb();
  const unmatched = await db.query<{
    id: string;
    from_email: string;
    subject: string | null;
    received_at: string | null;
    created_at: string | null;
  }>(
    `SELECT id, from_email, subject, received_at, created_at FROM messages
      WHERE direction = 'inbound' AND prospect_id IS NULL
      ORDER BY coalesce(received_at, created_at) ASC
      LIMIT $1`,
    [Math.max(1, Math.min(limit, 500))],
  );

  let matched = 0;
  let byAddress = 0;
  let byDomain = 0;

  for (const row of unmatched.rows) {
    const email = normalizeEmail(row.from_email ?? "");
    if (!email) continue;
    // A bounce report is not a conversation: attaching it to a lead would invent a reply.
    const bounce = await recordBounceIfAny({
      accountId: null,
      messageDbId: row.id,
      fromEmail: email,
      subject: row.subject ?? "",
      bodyText: "",
    });
    if (bounce.isBounce) continue;

    const domain = emailDomain(email);
    const generic = Boolean(domain && /gmail|outlook|yahoo|hotmail|icloud|proton/i.test(domain));
    const prospectId =
      (await findProspectByEmail(email)) ?? (generic ? null : await findProspectByDomain(domain));
    if (!prospectId || !await mayAssociateMessage(db, row.id, prospectId)) continue;

    const foundByAddress = Boolean(await findProspectByEmail(email));
    const when = row.received_at ?? row.created_at ?? new Date().toISOString();
    const conversationId = await conversationForProspect(
      prospectId,
      row.subject ?? "(no subject)",
      when,
    );
    const updated = await db.query(
      `UPDATE messages SET prospect_id = $2, conversation_id = $3, matched_by = $4
        WHERE id = $1 AND prospect_id IS NULL`,
      [row.id, prospectId, conversationId, foundByAddress ? "exact_email" : "sender_domain"],
    );
    if (!updated.rowCount) continue;
    matched += 1;
    if (foundByAddress) byAddress += 1;
    else byDomain += 1;

    // The conversation's own counters move with it, so an attached reply shows in the Inbox counts.
    await db.query(
      `UPDATE conversations SET
         last_message_at = GREATEST(coalesce(last_message_at, $2::timestamptz), $2::timestamptz),
         last_inbound_at = GREATEST(coalesce(last_inbound_at, $2::timestamptz), $2::timestamptz),
         unread_count = unread_count + 1,
         updated_at = now()
       WHERE id = $1`,
      [conversationId, when],
    );
  }

  return { scanned: unmatched.rows.length, matched, byAddress, byDomain };
}

/**
 * Write the Sent-folder copies that were not written at send time.
 *
 * A send path that could not reach IMAP leaves `sent_copy_saved_at` null. This walks those messages
 * oldest-first (well, newest first, which is what matters to a founder reading webmail) and appends
 * the copy, marking each one as it succeeds. A message already present in the folder is marked too:
 * "confirmed" is the fact being recorded, not "we appended it".
 */
export async function backfillSentCopies(
  accountId: string,
  limit = 10,
): Promise<{ attempted: number; saved: number; alreadyPresent: number }> {
  const account = await getEmailAccountRecord(accountId);
  if (!account || account.provider === "sandbox") {
    return { attempted: 0, saved: 0, alreadyPresent: 0 };
  }
  const pending = await listUncopiedSentMessages(accountId, limit);
  const db = await getDb();
  let saved = 0;
  let alreadyPresent = 0;
  for (const row of pending) {
    const body = await db.query<{ body_text: string | null; body_html: string | null; subject: string }>(
      `SELECT body_text, body_html, subject FROM messages WHERE id = $1`,
      [row.id],
    );
    const message = body.rows[0];
    if (!message) continue;
    const outcome = await saveSentCopyForMessage(account, row.id, {
      messageId: row.messageId,
      to: row.to,
      subject: message.subject ?? row.subject,
      text: message.body_text ?? "",
      html: message.body_html ?? "",
      fromName: account.fromName,
      fromEmail: account.emailAddress,
    });
    if (outcome.saved && outcome.alreadyPresent) alreadyPresent += 1;
    else if (outcome.saved) saved += 1;
  }
  return { attempted: pending.length, saved, alreadyPresent };
}

export async function getSyncHealth(accountId: string) {
  const db = await getDb();
  const states = await db.query<any>(
    `SELECT * FROM mailbox_sync_state WHERE account_id = $1 ORDER BY folder`,
    [accountId],
  );
  return states.rows.map((row) => ({
    folder: row.folder,
    lastUid: Number(row.last_uid),
    uidValidity: row.uidvalidity ? Number(row.uidvalidity) : null,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    historyComplete: Boolean(row.history_complete),
    error: row.error,
  }));
}

export async function resolveSenderDomain(email: string): Promise<string | null> {
  return emailDomain(email);
}

export function senderDomainForProspect(websiteUrl: string | null) {
  return domainFromUrl(websiteUrl);
}

export function classificationForDisplay(value: string): Classification {
  return value as Classification;
}
