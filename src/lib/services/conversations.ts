import { createHash } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { AppError, isEmail, iso, json, normalizeEmail, textToHtmlParagraphs, truncate } from "@/lib/utils";
import type {
  Classification,
  ConversationSummary,
  Message,
  ProspectDetail,
} from "@/lib/types";
import {
  getDefaultEmailAccount,
  getEmailAccountRecord,
} from "@/lib/email/accounts";
import { pinSendingProfile, resolvePinnedProfile } from "@/lib/email/profiles";
import {
  deliverEmail,
  EmailDeliveryError,
  type DeliveryResult,
  type EmailAttachmentInput,
} from "@/lib/email/send-provider";
import { applyInboundEffect } from "@/lib/email/sync";
import { suggestReply, type ReplySuggestion } from "@/lib/ai/reply";
import { getProspect } from "./prospects";
import { getProductTruth, getWorkspaceSettings } from "./settings";
import {
  assertAccountCanSend,
  getSendReadiness,
  buildComplianceFooter,
} from "./email-sending";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The instant a message really happened, newest first.
 *
 * `created_at` is the row's insert time, and for an imported row that is the import time — identical
 * for every row of that import, so it says nothing about the order the conversation happened in.
 * The real time is `sent_at`, falling back to `received_at`, and only then `created_at`; that is the
 * same convention `listSentMessages` and `listUnknownInbound` already use. `id` breaks a tie, so two
 * messages with the same instant never swap places between renders.
 */
function newestMessageFirst(alias = ""): string {
  const column = (name: string) => (alias ? `${alias}.${name}` : name);
  return [
    `COALESCE(${column("sent_at")}, ${column("received_at")}, ${column("created_at")}) DESC`,
    `${column("created_at")} DESC`,
    `${column("id")} DESC`,
  ].join(", ");
}

/** What an imported message with no full body shows instead of an empty card. */
export const MESSAGE_BODY_PENDING_TEXT =
  "Full text not imported yet. It appears when the mailbox is connected.";

export type MessageBodyKind = "body" | "excerpt" | "pending";

export interface MessageBodyDisplay {
  kind: MessageBodyKind;
  text: string;
}

/**
 * What to show where a message's body goes.
 *
 * Imported rows can arrive with `body_text = ''` and only the excerpt the old portal kept in
 * `snippet`. The human-readable reason why the body is missing lives in `error` — that is importer
 * bookkeeping and is never shown to the founder. So: the body when there is one, the excerpt when
 * that is all there is, and a plain notice when neither exists.
 */
export function messageBodyForDisplay(
  message: Pick<Message, "bodyText" | "snippet">,
): MessageBodyDisplay {
  if (message.bodyText?.trim()) {
    return { kind: "body", text: message.bodyText };
  }
  const excerpt = message.snippet?.trim();
  if (excerpt) return { kind: "excerpt", text: excerpt };
  return { kind: "pending", text: MESSAGE_BODY_PENDING_TEXT };
}

function mapMessage(row: any): Message {
  // `error` is deliberately not mapped: it carries importer bookkeeping such as
  // "excerpt only, full body pending mailbox sync", which is not something to show a founder.
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id ?? null,
    direction: row.direction,
    fromEmail: row.from_email,
    fromName: row.from_name,
    toEmails: json<string[]>(row.to_emails, []),
    subject: row.subject,
    bodyText: row.body_text,
    bodyHtml: null,
    snippet: row.snippet,
    sentAt: iso(row.sent_at),
    receivedAt: iso(row.received_at),
    isSandbox: Boolean(row.is_sandbox),
    deliveryStatus: row.delivery_status,
    attachments: json(row.attachments, []),
    source: row.source,
    external: Boolean(row.external),
    draftId: row.draft_id,
  };
}

async function dbQuerySuppression(email: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.query(
    `SELECT 1 FROM suppressions WHERE normalized_email = $1 AND active = true LIMIT 1`,
    [normalizeEmail(email)],
  );
  return result.rows.length > 0;
}

function mapConversation(row: any): ConversationSummary {
  return {
    id: row.id,
    prospectId: row.prospect_id,
    prospectName: row.business_name,
    prospectEmail: row.contact_email ?? null,
    subject: row.subject,
    status: row.status,
    classification: row.classification as Classification,
    lastMessageAt: iso(row.last_message_at),
    lastInboundAt: iso(row.last_inbound_at),
    unreadCount: Number(row.unread_count),
    snippet: row.snippet ?? null,
  };
}

export async function listConversations(input: {
  onlyReplied?: boolean;
  query?: string;
  limit?: number;
} = {}): Promise<ConversationSummary[]> {
  const db = await getDb();
  const conditions = ["c.last_message_at IS NOT NULL"];
  const params: unknown[] = [];
  if (input.onlyReplied !== false) {
    conditions.push("c.last_inbound_at IS NOT NULL");
  }
  if (input.query?.trim()) {
    params.push(`%${input.query.trim()}%`);
    conditions.push(
      `(p.business_name ILIKE $${params.length} OR c.subject ILIKE $${params.length} OR EXISTS (
        SELECT 1 FROM prospect_emails pe WHERE pe.prospect_id = p.id AND pe.email ILIKE $${params.length}
      ))`,
    );
  }
  params.push(Math.min(input.limit ?? 100, 200));
  const result = await db.query<any>(
    `SELECT c.*, p.business_name,
       (SELECT pe.email FROM prospect_emails pe WHERE pe.prospect_id = p.id
         ORDER BY pe.is_primary DESC LIMIT 1) AS contact_email,
       (SELECT m.snippet FROM messages m WHERE m.conversation_id = c.id
         AND m.direction = 'inbound'
         ORDER BY ${newestMessageFirst("m")} LIMIT 1) AS snippet
     FROM conversations c
     JOIN prospects p ON p.id = c.prospect_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY COALESCE(c.last_inbound_at, c.last_message_at) DESC
     LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(mapConversation);
}

export interface ConversationDetail {
  id: string;
  prospect: ProspectDetail;
  subject: string;
  status: string;
  classification: Classification;
  classificationSource: string;
  classificationConfidence: number | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  messages: Message[];
  replyTo: string | null;
  suppressed: boolean;
  sendable: boolean;
  blockedReason: string | null;
}

export async function getConversation(
  id: string,
): Promise<ConversationDetail | null> {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT c.*, p.business_name FROM conversations c
     JOIN prospects p ON p.id = c.prospect_id WHERE c.id = $1 LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  const prospect = await getProspect(row.prospect_id);
  if (!prospect) return null;
  // Newest first, by the time each message really happened: for imported rows `created_at` is the
  // import time and identical across the import, so it cannot order the thread.
  const messages = await db.query<any>(
    `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY ${newestMessageFirst()}`,
    [id],
  );
  const lastInbound = messages.rows.find(
    (message) => message.direction === "inbound",
  );
  const addresses = [prospect.contactEmail, lastInbound?.from_email]
    .filter((value): value is string => Boolean(value))
    .map(normalizeEmail);
  const suppression = addresses.length
    ? await db.query(
        `SELECT 1 FROM suppressions WHERE normalized_email = ANY($1::text[]) AND active = true`,
        [addresses],
      )
    : { rows: [] };
  const suppressed = prospect.doNotContact || suppression.rows.length > 0;
  return {
    id: row.id,
    prospect,
    subject: row.subject,
    status: row.status,
    classification: row.classification,
    classificationSource: row.classification_source,
    classificationConfidence: row.classification_confidence
      ? Number(row.classification_confidence)
      : null,
    lastInboundAt: iso(row.last_inbound_at),
    lastOutboundAt: iso(row.last_outbound_at),
    messages: messages.rows.map(mapMessage),
    replyTo: lastInbound?.from_email ?? prospect.contactEmail,
    suppressed,
    sendable: Boolean(lastInbound) && !suppressed,
    blockedReason: suppressed
      ? "This contact is on the suppression list. Promotional email cannot be sent."
      : lastInbound
        ? null
        : "There is no inbound reply to respond to.",
  };
}

export async function getConversationForProspect(
  prospectId: string,
): Promise<ConversationDetail | null> {
  const db = await getDb();
  const result = await db.query<{ id: string }>(
    `SELECT id FROM conversations WHERE prospect_id = $1 LIMIT 1`,
    [prospectId],
  );
  if (!result.rows[0]) return null;
  return getConversation(result.rows[0].id);
}

export async function markConversationRead(id: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE conversations SET unread_count = 0, updated_at = now() WHERE id = $1`,
    [id],
  );
  await db.query(
    `UPDATE messages SET is_read = true WHERE conversation_id = $1 AND direction = 'inbound'`,
    [id],
  );
}

export async function updateConversationClassification(
  id: string,
  classification: Classification,
  userId: string,
): Promise<void> {
  const db = await getDb();
  const conversation = await db.query<any>(
    `SELECT * FROM conversations WHERE id = $1`,
    [id],
  );
  const row = conversation.rows[0];
  if (!row) throw new AppError("Conversation not found.", 404);
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE conversations SET classification = $1, classification_source = 'founder',
        updated_at = now() WHERE id = $2`,
      [classification, id],
    );
    if (classification === "unsubscribe") {
      const email = await tx.query<{ email: string }>(
        `SELECT email FROM prospect_emails WHERE prospect_id = $1 LIMIT 1`,
        [row.prospect_id],
      );
      const address = email.rows[0]?.email;
      if (address) {
        await tx.query(
          `INSERT INTO suppressions
            (id, normalized_email, email, reason, source, prospect_id, note)
           VALUES ($1, $2, $3, 'unsubscribe', 'founder', $4, 'Classified as opt-out by founder')
           ON CONFLICT (normalized_email) DO UPDATE SET active = true, reason = 'unsubscribe', updated_at = now()`,
          [crypto.randomUUID(), normalizeEmail(address), address, row.prospect_id],
        );
      }
      await tx.query(
        `UPDATE prospects SET do_not_contact = true, status = 'lost',
          next_action = 'No further contact — opt-out recorded', updated_at = now()
         WHERE id = $1`,
        [row.prospect_id],
      );
    }
    await tx.query(
      `INSERT INTO audit_log
        (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'founder', $2, 'conversation.classified', 'conversation', $3, $4::jsonb)`,
      [
        crypto.randomUUID(),
        userId,
        id,
        JSON.stringify({ classification }),
      ],
    );
  });
}

export async function suggestConversationReply(
  id: string,
): Promise<ReplySuggestion & { recipient: string | null }> {
  const conversation = await getConversation(id);
  if (!conversation) throw new AppError("Conversation not found.", 404);
  if (conversation.suppressed) {
    return {
      subject: conversation.subject,
      body: "",
      needsFounderInput: false,
      usedAi: false,
      model: null,
      note: "This contact has opted out or is marked do not contact. No promotional reply is suggested.",
      recipient: null,
    };
  }
  const [truth, settings] = await Promise.all([
    getProductTruth(),
    getWorkspaceSettings(),
  ]);
  const turns = conversation.messages.map((message) => ({
    direction: message.direction,
    fromEmail: message.fromEmail,
    subject: message.subject,
    bodyText: message.bodyText,
    sentAt: message.sentAt,
  }));
  const suggestion = await suggestReply({
    truth,
    prospect: conversation.prospect,
    classification: conversation.classification,
    turns,
    settings,
  });
  return { ...suggestion, recipient: conversation.replyTo };
}

export interface SendReplyInput {
  conversationId: string;
  subject: string;
  body: string;
  accountId?: string | null;
  actorUserId: string;
  idempotencyKey: string;
  attachments?: EmailAttachmentInput[];
}

export async function sendReply(input: SendReplyInput) {
  if (!input.idempotencyKey?.trim()) {
    throw new AppError(
      "A unique idempotency key is required to prevent duplicate replies.",
      400,
      "idempotency_required",
    );
  }
  const conversation = await getConversation(input.conversationId);
  if (!conversation) throw new AppError("Conversation not found.", 404);
  if (conversation.suppressed) {
    throw new AppError(
      "This contact has opted out or is marked do not contact. No email can be sent.",
      409,
      "suppressed",
    );
  }
  if (!conversation.replyTo || !isEmail(conversation.replyTo)) {
    throw new AppError("There is no valid sender to reply to.", 409);
  }
  {
    const suppression = await dbQuerySuppression(conversation.replyTo);
    if (suppression) {
      throw new AppError(
        "This sender is on the suppression list. No email can be sent.",
        409,
        "suppressed",
      );
    }
  }
  if (/^(mailer-daemon|postmaster)@/i.test(conversation.replyTo)) {
    throw new AppError(
      "This conversation is a delivery failure notification, not a prospect reply.",
      409,
    );
  }
  const body = input.body.trim();
  const subject = input.subject.trim().replace(/[\r\n]+/g, " ");
  if (body.length < 2) throw new AppError("Write a reply before sending.");
  if (!subject) throw new AppError("Add a subject line.");

  const db = await getDb();
  const keyHash = createHash("sha256")
    .update(input.idempotencyKey)
    .digest("hex");
  let reusableSendRowId: string | null = null;
  const existing = await db.query<any>(
    `SELECT * FROM outbound_sends WHERE idempotency_key = $1 LIMIT 1`,
    [keyHash],
  );
  if (existing.rows[0]) {
    if (["accepted", "sandbox", "uncertain"].includes(existing.rows[0].status)) {
      return {
        alreadySent: true,
        status: existing.rows[0].status,
        messageId: existing.rows[0].transport_message_id,
        sentAt: iso(existing.rows[0].completed_at),
        deliveryUncertain: existing.rows[0].status === "uncertain",
      };
    }
    if (existing.rows[0].status === "failed") {
      reusableSendRowId = existing.rows[0].id;
      await db.query(
        `UPDATE outbound_sends SET status = 'sending', error = null,
          started_at = now(), completed_at = null WHERE id = $1`,
        [existing.rows[0].id],
      );
    } else if (existing.rows[0].status === "sending") {
      throw new AppError(
        "This reply is already being processed. Check Sent before retrying.",
        409,
        "reply_in_progress",
      );
    }
  }

  // A reply must come from the address the prospect is already talking to: the lead's profile first,
  // then the thread's, and only then an explicit pick or the default.
  const pinnedProfile = await resolvePinnedProfile({
    prospectId: conversation.prospect.id,
    conversationId: conversation.id,
  });
  const account =
    pinnedProfile ??
    ((input.accountId
      ? await getEmailAccountRecord(input.accountId)
      : await getDefaultEmailAccount(true)) ?? null);
  if (!account) {
    throw new AppError("Connect an email account before replying.", 409);
  }
  if (account.status !== "connected") {
    throw new AppError(
      account.lastError || "The email account is not connected.",
      409,
    );
  }
  await assertAccountCanSend(account.id);

  const lastInbound = conversation.messages.find(
    (message) => message.direction === "inbound",
  );
  if (!lastInbound) throw new AppError("No inbound message to reply to.", 409);
  const previousMessage = await db.query<{ message_id: string | null; references_json: unknown }>(
    `SELECT message_id, references_json FROM messages
     WHERE conversation_id = $1 ORDER BY ${newestMessageFirst()} LIMIT 1`,
    [conversation.id],
  );
  const references = [
    ...((Array.isArray(previousMessage.rows[0]?.references_json)
      ? previousMessage.rows[0].references_json
      : []) as string[]),
    previousMessage.rows[0]?.message_id,
  ].filter((value): value is string => Boolean(value));

  const footer = await buildComplianceFooter({
    accountProvider: account.provider,
    prospectId: conversation.prospect.id,
    email: conversation.replyTo,
  });
  const messageId = `<${crypto.randomUUID()}@${account.emailAddress.split("@")[1] || "nomeriq.local"}>`;
  const text = `${body}\n${footer.text}`;
  const html = `${textToHtmlParagraphs(body)}<hr style="border:none;border-top:1px solid #ddd;margin:24px 0" /><div style="font-size:12px;color:#666">${textToHtmlParagraphs(footer.text.replace(/^\n+/, ""))}</div>`;
  const sendRowId = reusableSendRowId ?? crypto.randomUUID();

  if (!reusableSendRowId) {
    try {
      await db.query(
        `INSERT INTO outbound_sends
          (id, conversation_id, kind, recipient_email, subject, account_id,
           prospect_id, idempotency_key, status)
         VALUES ($1, $2, 'reply', $3, $4, $5, $6, $7, 'sending')`,
        [
          sendRowId,
          conversation.id,
          conversation.replyTo,
          subject,
          account.id,
          conversation.prospect.id,
          keyHash,
        ],
      );
    } catch (error) {
      if (String((error as { code?: string }).code) === "23505") {
        throw new AppError(
          "This reply was already submitted.",
          409,
          "already_sent",
        );
      }
      throw error;
    }
  }

  const readiness = await getSendReadiness(account.id);
  if (!readiness.ready) {
    // Nothing was sent, so nothing is recorded as sent: the attempt row goes back and the reply can be
    // tried again once the account's own window passes.
    await db.query(`DELETE FROM outbound_sends WHERE id = $1 AND status = 'sending'`, [sendRowId]);
    return {
      queued: true,
      retryAfterSeconds: readiness.retryAfterSeconds,
      note: `Held back by your own minimum interval between sends. Nothing was sent — it can go in ${readiness.retryAfterSeconds}s.`,
    };
  }

  let delivery: DeliveryResult;
  let uncertainty: string | null = null;
  try {
    delivery = await deliverEmail(account, {
      to: conversation.replyTo,
      subject,
      text,
      html,
      messageId,
      headers: {
        ...footer.headers,
        ...(lastInbound.messageId
          ? { "In-Reply-To": lastInbound.messageId }
          : {}),
        References: references.join(" "),
      },
      attachments: input.attachments,
    });
  } catch (error) {
    const failure =
      error instanceof EmailDeliveryError
        ? error
        : new EmailDeliveryError(
            error instanceof Error ? error.message : "SMTP failed.",
            false,
          );
    if (failure.definitive) {
      await db.query(
        `UPDATE outbound_sends SET status = 'failed', error = $1, completed_at = now()
         WHERE id = $2`,
        [failure.message, sendRowId],
      );
      throw new AppError(failure.message, 502, "smtp_rejected");
    }
    // May have been delivered: count it as sent, record the uncertainty, ask nothing of the founder.
    uncertainty = failure.message;
    delivery = {
      mode: "live",
      transportMessageId: messageId,
      response: failure.message,
    };
  }

  const sentAt = new Date().toISOString();
  const deliveryStatus = uncertainty
    ? "uncertain"
    : delivery.mode === "sandbox"
      ? "sandbox"
      : "accepted";
  const messageDbId = crypto.randomUUID();
  const attachmentRecords = (input.attachments ?? []).map((attachment) => ({
    id: crypto.randomUUID(),
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.content.length,
    content: attachment.content,
  }));
  try {
    await db.transaction(async (tx) => {
      // Pinned with the message row, so the thread and the lead keep replying from this profile.
      await pinSendingProfile(
        {
          prospectId: conversation.prospect.id,
          conversationId: conversation.id,
          accountId: account.id,
        },
        tx,
      );
      await tx.query(
        `INSERT INTO messages (
          id, conversation_id, prospect_id, account_id, direction, source,
          message_id, in_reply_to, references_json, from_email, from_name,
          to_emails, subject, body_text, body_html, snippet, sent_at, received_at,
          is_read, is_sandbox, delivery_status, attachments, external
        ) VALUES (
          $1, $2, $3, $4, 'outbound', $5, $6, $7, $8::jsonb, $9, $10,
          $11::jsonb, $12, $13, $14, $15, $16, null, true, $17, $18, $19::jsonb, false
        )`,
        [
          messageDbId,
          conversation.id,
          conversation.prospect.id,
          account.id,
          delivery.mode === "sandbox" ? "system" : "smtp",
          delivery.transportMessageId,
          lastInbound.id,
          JSON.stringify(references),
          account.emailAddress,
          account.fromName,
          JSON.stringify([conversation.replyTo]),
          subject,
          text,
          html,
          truncate(body, 220),
          sentAt,
          delivery.mode === "sandbox",
          deliveryStatus,
          JSON.stringify(
            attachmentRecords.map(({ content: _content, ...metadata }) => metadata),
          ),
        ],
      );
      for (const attachment of attachmentRecords) {
        await tx.query(
          `INSERT INTO message_attachments
            (id, message_id, filename, content_type, size, content)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            attachment.id,
            messageDbId,
            attachment.filename,
            attachment.contentType,
            attachment.size,
            new Uint8Array(attachment.content),
          ],
        );
      }
      await tx.query(
        `UPDATE conversations SET
          status = 'waiting', last_message_at = $1, last_outbound_at = $1,
          unread_count = 0, updated_at = now()
         WHERE id = $2`,
        [sentAt, conversation.id],
      );
      await tx.query(
        `UPDATE prospects SET last_contacted_at = $1,
          next_action = CASE WHEN status IN ('new', 'verified', 'draft_prepared', 'contacted', 'replied')
            THEN 'Wait for the prospect''s response' ELSE next_action END,
          updated_at = now()
         WHERE id = $2`,
        [sentAt, conversation.prospect.id],
      );
      await tx.query(
        `UPDATE outbound_sends SET status = $1, transport_message_id = $2,
          smtp_response = $3, completed_at = $4
         WHERE id = $5`,
        [deliveryStatus, delivery.transportMessageId, delivery.response, sentAt, sendRowId],
      );
    });
  } catch {
    await db.query(
      `UPDATE outbound_sends SET status = 'uncertain', error = $1, completed_at = now()
       WHERE id = $2`,
      [
        "Reply was accepted by the sending server but could not be fully recorded. Check Sent.",
        sendRowId,
      ],
    ).catch(() => undefined);
    throw new AppError(
      "The reply may have been sent, but Growth could not record it. Check the mailbox Sent folder before retrying.",
      500,
      "post_send_recording_failed",
    );
  }

  return {
    alreadySent: false,
    status: deliveryStatus,
    messageId: delivery.transportMessageId,
    sentAt,
    deliveryUncertain: uncertainty !== null,
    note: uncertainty
      ? "Recorded as sent. The sending server did not confirm delivery — check the mailbox if you need certainty."
      : undefined,
  };
}

export async function simulateInboundReply(input: {
  conversationId: string;
  body: string;
  actorUserId: string;
}): Promise<void> {
  const conversation = await getConversation(input.conversationId);
  if (!conversation) throw new AppError("Conversation not found.", 404);
  const db = await getDb();
  const lastOutbound = await db.query<any>(
    `SELECT m.*, a.provider FROM messages m
     LEFT JOIN email_accounts a ON a.id = m.account_id
     WHERE m.conversation_id = $1 AND m.direction = 'outbound'
     ORDER BY ${newestMessageFirst("m")} LIMIT 1`,
    [input.conversationId],
  );
  if (!lastOutbound.rows[0] || lastOutbound.rows[0].provider !== "sandbox") {
    throw new AppError(
      "Test replies are only available for the sandbox mailbox, so a simulation can never be mistaken for a real reply.",
      409,
      "sandbox_only",
    );
  }
  const contactEmail = conversation.prospect.contactEmail;
  if (!contactEmail) throw new AppError("Prospect has no contact email.", 409);
  const body = input.body.trim();
  if (!body) throw new AppError("Write the simulated reply.");
  const now = new Date().toISOString();
  const messageId = `<sim-${crypto.randomUUID()}@growth.local>`;
  await db.query(
    `INSERT INTO messages (
      id, conversation_id, prospect_id, account_id, direction, source,
      message_id, in_reply_to, references_json, from_email, from_name, to_emails,
      subject, body_text, body_html, snippet, sent_at, received_at, is_read,
      is_sandbox, delivery_status, attachments, external, matched_by
    ) VALUES (
      $1, $2, $3, $4, 'inbound', 'system', $5, $6, $7::jsonb, $8, $9,
      $10::jsonb, $11, $12, null, $13, null, $14, false, true, 'accepted',
      '[]'::jsonb, false, 'sandbox_simulation'
    )`,
    [
      crypto.randomUUID(),
      conversation.id,
      conversation.prospect.id,
      lastOutbound.rows[0].account_id,
      messageId,
      lastOutbound.rows[0].message_id,
      JSON.stringify([lastOutbound.rows[0].message_id].filter(Boolean)),
      contactEmail,
      conversation.prospect.businessName,
      JSON.stringify([lastOutbound.rows[0].from_email]),
      `Re: ${lastOutbound.rows[0].subject}`,
      body,
      truncate(body, 220),
      now,
    ],
  );
  await applyInboundEffect(
    conversation.id,
    conversation.prospect.id,
    body,
    `Re: ${lastOutbound.rows[0].subject}`,
    now,
  );
  await db.query(
    `INSERT INTO audit_log
      (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1, 'founder', $2, 'email.sandbox_reply_simulated', 'conversation', $3, $4::jsonb)`,
    [
      crypto.randomUUID(),
      input.actorUserId,
      conversation.id,
      JSON.stringify({ body: truncate(body, 300) }),
    ],
  );
}

export async function listSentMessages(limit = 100) {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT m.*, p.business_name, a.email_address AS account_email
     FROM messages m
     LEFT JOIN prospects p ON p.id = m.prospect_id
     LEFT JOIN email_accounts a ON a.id = m.account_id
     WHERE m.direction = 'outbound'
     ORDER BY COALESCE(m.sent_at, m.created_at) DESC LIMIT $1`,
    [Math.min(limit, 200)],
  );
  return result.rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    prospectId: row.prospect_id,
    prospectName: row.business_name,
    accountEmail: row.account_email,
    to: json<string[]>(row.to_emails, [])[0] ?? "",
    subject: row.subject,
    snippet: row.snippet,
    sentAt: iso(row.sent_at) ?? iso(row.created_at),
    isSandbox: Boolean(row.is_sandbox),
    deliveryStatus: row.delivery_status,
    external: Boolean(row.external),
  }));
}

export async function listUnknownInbound(limit = 30) {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT * FROM messages
     WHERE direction = 'inbound' AND prospect_id IS NULL
     ORDER BY COALESCE(received_at, created_at) DESC LIMIT $1`,
    [Math.min(limit, 100)],
  );
  return result.rows.map(mapMessage);
}

export async function getAttachment(
  id: string,
): Promise<{ filename: string; contentType: string; content: Buffer } | null> {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT filename, content_type, content FROM message_attachments WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row?.content) return null;
  return {
    filename: row.filename,
    contentType: row.content_type,
    content: Buffer.from(row.content),
  };
}
