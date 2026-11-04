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

/* eslint-disable @typescript-eslint/no-explicit-any */

const syncing = new Set<string>();
const MAX_PER_FOLDER = 40;
const INITIAL_DAYS = 30;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface SyncResult {
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
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT conversation_id, prospect_id FROM messages
     WHERE message_id = ANY($1::text[]) AND conversation_id IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [ids],
  );
  return result.rows[0]
    ? {
        conversationId: result.rows[0].conversation_id,
        prospectId: result.rows[0].prospect_id,
      }
    : null;
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
}): Promise<{
  prospectId: string | null;
  conversationId: string | null;
  matchedBy: string;
}> {
  const threadMessageIds = [
    ...(input.inReplyTo ? [input.inReplyTo] : []),
    ...input.references,
  ];
  if (threadMessageIds.length) {
    const thread = await findThreadConversation(threadMessageIds);
    if (thread) {
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
  for (const email of candidateEmails) {
    const prospectId = await findProspectByEmail(email);
    if (prospectId) {
      const conversationId = await conversationForProspect(
        prospectId,
        input.subject,
        input.when,
      );
      return { prospectId, conversationId, matchedBy: "exact_email" };
    }
  }

  const domain =
    input.direction === "inbound"
      ? emailDomain(input.fromEmail)
      : emailDomain(candidateEmails[0] ?? "");
  if (domain && !/gmail|outlook|yahoo|hotmail|icloud|proton/i.test(domain)) {
    const prospectId = await findProspectByDomain(domain);
    if (prospectId) {
      const conversationId = await conversationForProspect(
        prospectId,
        input.subject,
        input.when,
      );
      return { prospectId, conversationId, matchedBy: "sender_domain" };
    }
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
): Promise<void> {
  const db = await getDb();
  const classification = classifyReply(body);
  await db.transaction(async (tx) => {
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

    if (
      classification.classification === "unsubscribe" ||
      classification.classification === "not_interested"
    ) {
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
            classification.classification === "unsubscribe" ? "unsubscribe" : "opt_out",
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
       WHERE id = $3`,
      [when, when, prospectId],
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
}): Promise<{
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

  const rawMessageHeaders = JSON.stringify({
    returnPath: parsed.headers.get("return-path") || null,
    replyTo: parsed.headers.get("reply-to") || null,
    folderLabel: input.folderLabel,
  });

  const text = bodyText(parsed);
  const html = parsed.html ? String(parsed.html).slice(0, 500_000) : null;
  const snippet = truncate(stripQuotedReply(text), 220);

  const duplicate = await db.query<{ id: string; body_text: string | null }>(
    `SELECT id, body_text FROM messages
     WHERE (account_id = $1 AND folder = $2 AND uidvalidity = $3 AND uid = $4)
        OR (account_id = $1 AND message_id = $5)
     LIMIT 1`,
    [
      input.account.id,
      input.folderPath,
      input.uidValidity,
      input.uid,
      messageId,
    ],
  );
  const existing = duplicate.rows[0];
  if (existing) {
    // A row that arrived with no body is filled in rather than skipped: an imported message, or a sync
    // that ran before the body could be read, would otherwise stay blank for ever. Only a BLANK body is
    // filled — a body already stored is never replaced by a second copy of the same message, so the
    // first sync that read it keeps what it saw. The update is guarded on blankness too, so two syncs
    // racing on the same message cannot both claim to have filled it.
    if (existing.body_text && existing.body_text.trim()) {
      return { inserted: false, filled: false, conversationId: null, prospectId: null };
    }
    const filled = await db.query<{ conversation_id: string | null; prospect_id: string | null }>(
      `UPDATE messages SET
         body_text = $2,
         body_html = coalesce(body_html, $3),
         snippet = coalesce(snippet, $4),
         subject = CASE WHEN subject IS NULL OR subject = '' OR subject = '(no subject)'
                        THEN $5 ELSE subject END,
         cc_emails = CASE WHEN cc_emails IS NULL OR cc_emails = '[]'::jsonb
                          THEN $6::jsonb ELSE cc_emails END,
         from_name = coalesce(nullif(from_name, ''), $7),
         raw_headers = coalesce(raw_headers, $8::jsonb)
       WHERE id = $1 AND (body_text IS NULL OR btrim(body_text) = '')
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
      parsed.html ? String(parsed.html).slice(0, 500_000) : null,
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

  if (owner.conversationId && owner.prospectId) {
    if (input.direction === "inbound") {
      await applyInboundEffect(
        owner.conversationId,
        owner.prospectId,
        stripQuotedReply(text),
        subject,
        date.toISOString(),
      );
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

export async function syncEmailAccount(accountId: string): Promise<SyncResult> {
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
      await saveSyncState({
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
        `UPDATE email_accounts SET last_sync_at = now(), last_checked_at = now(),
          status = 'connected', last_error = null, updated_at = now()
         WHERE id = $1`,
        [accountId],
      );
    } finally {
      await client.logout().catch(() => undefined);
    }
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
