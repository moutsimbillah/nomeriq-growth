import { createHash, randomBytes } from "node:crypto";
import { getDb } from "@/lib/db/client";
import {
  getDefaultEmailAccount,
  getEmailAccountRecord,
} from "@/lib/email/accounts";
import {
  deliverEmail,
  EmailDeliveryError,
  type EmailAttachmentInput,
} from "@/lib/email/send-provider";
import {
  AppError,
  escapeHtml,
  isEmail,
  normalizeEmail,
  textToHtmlParagraphs,
  truncate,
} from "@/lib/utils";
import { getDraft } from "./drafts";
import { getWorkspaceSettings } from "./settings";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SendResult {
  status: "accepted" | "sandbox";
  alreadySent: boolean;
  messageId: string;
  accountEmail: string;
  response: string;
  sentAt: string;
  draftId: string;
}

function appUrl(): string {
  return (process.env.APP_URL || "http://localhost:3100").replace(/\/$/, "");
}

async function unsubscribeUrl(
  prospectId: string,
  email: string,
): Promise<string> {
  const db = await getDb();
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await db.query(
    `INSERT INTO unsubscribe_tokens (id, prospect_id, normalized_email, token_hash)
     VALUES ($1, $2, $3, $4)`,
    [crypto.randomUUID(), prospectId, normalizeEmail(email), hash],
  );
  return `${appUrl()}/unsubscribe/${token}`;
}

export function isSuppressed(email: string): Promise<boolean> {
  return (async () => {
    const db = await getDb();
    const result = await db.query(
      `SELECT 1 FROM suppressions
       WHERE normalized_email = $1 AND active = true LIMIT 1`,
      [normalizeEmail(email)],
    );
    return result.rows.length > 0;
  })();
}

export async function buildComplianceFooter(input: {
  accountProvider: string;
  prospectId: string;
  email: string;
}): Promise<{ text: string; headers: Record<string, string> }> {
  const settings = await getWorkspaceSettings();
  const unsubscribe = await unsubscribeUrl(input.prospectId, input.email);
  const isSandbox = input.accountProvider === "sandbox";
  if (!settings.postalAddress.trim() && !isSandbox) {
    throw new AppError(
      "Add your registered business postal address in Settings before sending commercial email.",
      409,
      "postal_address_missing",
    );
  }
  const addressLine = settings.postalAddress.trim()
    ? settings.postalAddress.trim()
    : "Sandbox test message — no message was delivered.";
  const text = [
    "",
    "--",
    `${settings.legalBusinessName} · ${addressLine}`,
    settings.footerNote,
    `Unsubscribe: ${unsubscribe}`,
  ].join("\n");
  return {
    text,
    headers: {
      "List-Unsubscribe": `<${unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      "X-Nomeriq-Growth": "outreach",
    },
  };
}

export async function assertAccountCanSend(accountId: string): Promise<void> {
  const account = await getEmailAccountRecord(accountId);
  if (!account) throw new AppError("Email account not found.", 404);
  if (account.status !== "connected") {
    throw new AppError(
      account.lastError ||
        "The email account is not connected. Check Settings before sending.",
      409,
      "email_account_not_connected",
    );
  }
  const db = await getDb();
  const counts = await db.query<{ count: string | number; last_sent: string | null }>(
    `SELECT count(*) AS count, max(completed_at) AS last_sent
     FROM outbound_sends
     WHERE account_id = $1
       AND status IN ('accepted', 'sandbox')
       AND completed_at >= now() - interval '24 hours'`,
    [accountId],
  );
  const count = Number(counts.rows[0]?.count ?? 0);
  if (count >= account.dailySendLimit) {
    throw new AppError(
      `The configured safety limit of ${account.dailySendLimit} sends per rolling 24 hours has been reached. This is your app-configured limit, not a claim about your provider's limit.`,
      429,
      "daily_limit_reached",
    );
  }
  const lastSent = counts.rows[0]?.last_sent
    ? new Date(counts.rows[0].last_sent as string).getTime()
    : null;
  if (lastSent) {
    const elapsed = (Date.now() - lastSent) / 1000;
    if (elapsed < account.minIntervalSeconds) {
      const retryAfter = Math.ceil(account.minIntervalSeconds - elapsed);
      throw new AppError(
        `Sending too quickly. Your configured minimum interval is ${account.minIntervalSeconds}s. Try again in ${retryAfter}s.`,
        429,
        "min_interval",
      );
    }
  }
}

async function checkRecipientSafety(prospectId: string, email: string) {
  const db = await getDb();
  const prospect = await db.query<{ do_not_contact: boolean }>(
    `SELECT do_not_contact FROM prospects WHERE id = $1 AND archived_at IS NULL`,
    [prospectId],
  );
  if (!prospect.rows[0]) throw new AppError("Prospect not found.", 404);
  if (prospect.rows[0].do_not_contact) {
    throw new AppError(
      "This prospect is marked do not contact.",
      409,
      "do_not_contact",
    );
  }
  const suppressed = await db.query(
    `SELECT 1 FROM suppressions WHERE normalized_email = $1 AND active = true`,
    [normalizeEmail(email)],
  );
  if (suppressed.rows.length) {
    throw new AppError(
      "This address is on the opt-out/suppression list. It cannot receive promotional email.",
      409,
      "suppressed",
    );
  }
  const verified = await db.query(
    `SELECT 1 FROM prospect_emails WHERE prospect_id = $1 AND normalized_email = $2`,
    [prospectId, normalizeEmail(email)],
  );
  if (!verified.rows.length) {
    throw new AppError(
      "The recipient is not the prospect's source-confirmed contact email.",
      422,
      "unverified_recipient",
    );
  }
}

async function priorContactExists(prospectId: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.query(
    `SELECT 1 FROM messages
     WHERE prospect_id = $1 AND direction = 'outbound' AND delivery_status <> 'failed'
     LIMIT 1`,
    [prospectId],
  );
  return result.rows.length > 0;
}

async function latestConversationMessage(conversationId: string) {
  const db = await getDb();
  const result = await db.query<{
    message_id: string | null;
    references_json: unknown;
    subject: string;
  }>(
    `SELECT message_id, references_json, subject FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [conversationId],
  );
  return result.rows[0] ?? null;
}

export interface SendDraftOptions {
  draftId: string;
  accountId?: string | null;
  campaignId?: string | null;
  actorUserId: string;
  attachments?: EmailAttachmentInput[];
}

export async function sendDraft(
  options: SendDraftOptions,
): Promise<SendResult> {
  const draft = await getDraft(options.draftId);
  if (!draft) throw new AppError("Draft not found.", 404);
  const db = await getDb();
  const existingSend = await db.query<any>(
    `SELECT * FROM outbound_sends WHERE draft_id = $1 LIMIT 1`,
    [draft.id],
  );
  const existingRow = existingSend.rows[0] ?? null;

  // Idempotency must win even after the draft has transitioned to sent.
  if (existingRow?.status === "accepted" || existingRow?.status === "sandbox") {
    const account = await getEmailAccountRecord(existingRow.account_id);
    return {
      status: existingRow.status,
      alreadySent: true,
      messageId: existingRow.transport_message_id || "",
      accountEmail: account?.emailAddress ?? "",
      response: existingRow.smtp_response || "",
      sentAt: existingRow.completed_at
        ? new Date(existingRow.completed_at).toISOString()
        : "",
      draftId: draft.id,
    };
  }

  if (draft.status === "sent") {
    throw new AppError("This draft has already been sent.", 409, "already_sent");
  }
  if (draft.status !== "approved") {
    throw new AppError(
      "Review and approve the draft before sending.",
      409,
      "not_approved",
    );
  }
  if (!isEmail(draft.recipientEmail)) {
    throw new AppError("The recipient is not a valid email address.");
  }
  await checkRecipientSafety(draft.prospectId, draft.recipientEmail);

  if (existingRow) {
    const row = existingRow;
    if (row.status === "sending") {
      throw new AppError(
        "A send attempt for this draft is already in progress. Check Sent before retrying.",
        409,
        "send_in_progress",
      );
    }
    if (row.status === "uncertain") {
      throw new AppError(
        "The previous attempt has uncertain delivery. Check the IONOS Sent folder and mark it resolved before retrying.",
        409,
        "uncertain_delivery",
      );
    }
    if (row.status === "failed") {
      // A definitive SMTP rejection is safe to retry with the same ledger row.
      await db.query(
        `UPDATE outbound_sends SET status = 'sending', error = null,
          started_at = now(), completed_at = null WHERE id = $1`,
        [row.id],
      );
    } else {
      throw new AppError(
        "This draft cannot be sent in its current state.",
        409,
        "send_blocked",
      );
    }
  } else {
    try {
      await db.query(
        `INSERT INTO outbound_sends
          (id, draft_id, account_id, prospect_id, campaign_id, idempotency_key, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'sending')`,
        [
          crypto.randomUUID(),
          draft.id,
          options.accountId ?? null,
          draft.prospectId,
          options.campaignId ?? null,
          createHash("sha256")
            .update(`${draft.id}:${draft.recipientEmail}`)
            .digest("hex"),
        ],
      );
    } catch (error) {
      if (String((error as { code?: string }).code) === "23505") {
        throw new AppError(
          "A send attempt for this draft already exists.",
          409,
          "already_sent",
        );
      }
      throw error;
    }
  }

  const account =
    (options.accountId
      ? await getEmailAccountRecord(options.accountId)
      : await getDefaultEmailAccount(true)) ?? null;
  if (!account) {
    await db.query(`DELETE FROM outbound_sends WHERE draft_id = $1`, [draft.id]);
    throw new AppError(
      "Connect an email account in Settings before sending.",
      409,
      "no_email_account",
    );
  }
  if (account.status !== "connected") {
    await db.query(
      `UPDATE outbound_sends SET status = 'failed', error = $2,
       completed_at = now() WHERE draft_id = $1`,
      [draft.id, account.lastError || "Email account not connected"],
    );
    throw new AppError(
      account.lastError || "The email account is not connected.",
      409,
      "email_account_not_connected",
    );
  }

  if (draft.kind === "first_contact") {
    if (await priorContactExists(draft.prospectId)) {
      await db.query(
        `UPDATE outbound_sends SET status = 'blocked',
          error = 'Prospect already contacted', completed_at = now()
         WHERE draft_id = $1`,
        [draft.id],
      );
      throw new AppError(
        "This prospect has already been contacted. A new first-contact email cannot be sent.",
        409,
        "already_contacted",
      );
    }
  }

  let conversation = await db.query<any>(
    `SELECT * FROM conversations WHERE prospect_id = $1 LIMIT 1`,
    [draft.prospectId],
  );
  if (draft.kind === "follow_up") {
    if (!conversation.rows[0]) {
      await db.query(
        `UPDATE outbound_sends SET status = 'blocked',
          error = 'No conversation for follow-up', completed_at = now()
         WHERE draft_id = $1`,
        [draft.id],
      );
      throw new AppError("A follow-up needs an existing conversation.", 409);
    }
    const inboundAfter = await db.query(
      `SELECT 1 FROM messages
       WHERE conversation_id = $1 AND direction = 'inbound'
         AND created_at > COALESCE((
           SELECT max(created_at) FROM messages
           WHERE conversation_id = $1 AND direction = 'outbound'
         ), '-infinity'::timestamptz)
       LIMIT 1`,
      [conversation.rows[0].id],
    );
    if (inboundAfter.rows.length) {
      await db.query(
        `UPDATE outbound_sends SET status = 'blocked',
          error = 'Prospect replied; follow-up cancelled', completed_at = now()
         WHERE draft_id = $1`,
        [draft.id],
      );
      throw new AppError(
        "The prospect has replied since your last email. This follow-up was blocked.",
        409,
        "prospect_replied",
      );
    }
  }

  await assertAccountCanSend(account.id);

  const footer = await buildComplianceFooter({
    accountProvider: account.provider,
    prospectId: draft.prospectId,
    email: draft.recipientEmail,
  });
  const messageId = `<${crypto.randomUUID()}@${account.emailAddress.split("@")[1] || "nomeriq.local"}>`;
  const outboundConversation = conversation.rows[0];
  const previous = outboundConversation
    ? await latestConversationMessage(outboundConversation.id)
    : null;
  if (draft.kind === "follow_up" && !previous) {
    await db.query(
      `UPDATE outbound_sends SET status = 'blocked',
        error = 'No previous message for follow-up', completed_at = now()
       WHERE draft_id = $1`,
      [draft.id],
    );
    throw new AppError(
      "No previous conversation message exists for this follow-up.",
      409,
    );
  }
  const references = previous
    ? [
        ...(Array.isArray(previous.references_json)
          ? previous.references_json
          : []),
        previous.message_id,
      ].filter((value): value is string => Boolean(value))
    : [];
  const subject =
    draft.kind === "follow_up"
      ? draft.subject.toLowerCase().startsWith("re:")
        ? draft.subject
        : `Re: ${previous?.subject || draft.subject}`
      : draft.subject;
  const text = `${draft.body.trim()}\n${footer.text}`;
  const html = `${textToHtmlParagraphs(draft.body.trim())}<hr style="border:none;border-top:1px solid #ddd;margin:24px 0" /><div style="font-size:12px;color:#666">${textToHtmlParagraphs(footer.text.replace(/^\n+/, ""))}</div>`;

  let delivery;
  try {
    delivery = await deliverEmail(account, {
      to: draft.recipientEmail,
      subject,
      text,
      html,
      messageId,
      headers: {
        ...footer.headers,
        ...(previous?.message_id
          ? {
              "In-Reply-To": previous.message_id,
              References: references.join(" "),
            }
          : {}),
      },
      attachments: options.attachments,
    });
  } catch (error) {
    const failure =
      error instanceof EmailDeliveryError
        ? error
        : new EmailDeliveryError(
            error instanceof Error ? error.message : "SMTP send failed.",
            false,
          );
    await db.query(
      `UPDATE outbound_sends SET status = $1, error = $2, completed_at = now()
       WHERE draft_id = $3`,
      [failure.definitive ? "failed" : "uncertain", failure.message, draft.id],
    );
    await db.query(
      `UPDATE drafts SET last_error = $1, updated_at = now() WHERE id = $2`,
      [failure.message, draft.id],
    );
    throw new AppError(
      failure.message,
      502,
      failure.definitive ? "smtp_rejected" : "delivery_uncertain",
    );
  }

  const deliveryStatus = delivery.mode === "sandbox" ? "sandbox" : "accepted";
  const sentAt = new Date().toISOString();
  try {
    await db.transaction(async (tx) => {
      let conversationId = outboundConversation?.id as string | undefined;
      if (!conversationId) {
        conversationId = crypto.randomUUID();
        await tx.query(
          `INSERT INTO conversations
            (id, prospect_id, subject, status, last_message_at, last_outbound_at)
           VALUES ($1, $2, $3, 'waiting', $4, $4)`,
          [conversationId, draft.prospectId, subject, sentAt],
        );
      } else {
        await tx.query(
          `UPDATE conversations SET
            last_message_at = $1, last_outbound_at = $1,
            status = CASE WHEN status = 'closed' THEN 'open' ELSE 'waiting' END,
            updated_at = now()
           WHERE id = $2`,
          [sentAt, conversationId],
        );
      }

      const messageDbId = crypto.randomUUID();
      const attachmentRecords = (options.attachments ?? []).map((attachment) => ({
        id: crypto.randomUUID(),
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.content.length,
        content: attachment.content,
      }));
      await tx.query(
        `INSERT INTO messages (
          id, conversation_id, prospect_id, account_id, direction, source,
          message_id, in_reply_to, references_json, from_email, from_name,
          to_emails, subject, body_text, body_html, snippet, sent_at, is_read,
          is_sandbox, delivery_status, attachments, draft_id, campaign_id, external
        ) VALUES (
          $1, $2, $3, $4, 'outbound', $5, $6, $7, $8::jsonb, $9, $10,
          $11::jsonb, $12, $13, $14, $15, $16, true, $17, $18, $19::jsonb,
          $20, $21, false
        )`,
        [
          messageDbId,
          conversationId,
          draft.prospectId,
          account.id,
          delivery.mode === "sandbox" ? "system" : "smtp",
          delivery.transportMessageId,
          previous?.message_id ?? null,
          JSON.stringify(references),
          account.emailAddress,
          account.fromName,
          JSON.stringify([draft.recipientEmail]),
          subject,
          text,
          html,
          truncate(draft.body, 220),
          sentAt,
          delivery.mode === "sandbox",
          deliveryStatus,
          JSON.stringify(
            attachmentRecords.map(({ content: _content, ...metadata }) => metadata),
          ),
          draft.id,
          options.campaignId ?? null,
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
        `UPDATE drafts SET status = 'sent', sent_at = $1, last_error = null,
          updated_at = now() WHERE id = $2`,
        [sentAt, draft.id],
      );
      await tx.query(
        `UPDATE outbound_sends SET status = $1, transport_message_id = $2,
          smtp_response = $3, completed_at = $4, error = null
         WHERE draft_id = $5`,
        [deliveryStatus, delivery.transportMessageId, delivery.response, sentAt, draft.id],
      );
      await tx.query(
        `UPDATE prospects SET
          last_contacted_at = $1,
          status = CASE
            WHEN status IN ('new', 'verified', 'draft_prepared') THEN 'contacted'
            ELSE status END,
          next_action = CASE
            WHEN status IN ('new', 'verified', 'draft_prepared') THEN 'Wait for a reply'
            ELSE next_action END,
          updated_at = now()
         WHERE id = $2`,
        [sentAt, draft.prospectId],
      );
      if (options.campaignId) {
        await tx.query(
          `UPDATE campaign_items SET status = 'sent', error = null, updated_at = now()
           WHERE campaign_id = $1 AND draft_id = $2`,
          [options.campaignId, draft.id],
        );
      }
    });
  } catch (error) {
    await db.query(
      `UPDATE outbound_sends SET status = 'uncertain', error = $1,
       completed_at = now() WHERE draft_id = $2`,
      [
        "The sending server accepted the message, but Growth could not finish recording it. Check Sent and reconcile manually.",
        draft.id,
      ],
    ).catch(() => undefined);
    throw new AppError(
      "The message may have been sent, but Growth could not finish recording it. Check the mailbox Sent folder before any retry.",
      500,
      "post_send_recording_failed",
    );
  }

  return {
    status: deliveryStatus as "accepted" | "sandbox",
    alreadySent: false,
    messageId: delivery.transportMessageId,
    accountEmail: account.emailAddress,
    response: delivery.response,
    sentAt,
    draftId: draft.id,
  };
}

export async function getSendUsage(accountId: string): Promise<{
  sentLast24h: number;
  dailyLimit: number;
  minIntervalSeconds: number;
  nextAllowedAt: string | null;
}> {
  const account = await getEmailAccountRecord(accountId);
  if (!account) throw new AppError("Email account not found.", 404);
  const db = await getDb();
  const result = await db.query<{ count: string | number; last_sent: string | null }>(
    `SELECT count(*) AS count, max(completed_at) AS last_sent
     FROM outbound_sends
     WHERE account_id = $1 AND status IN ('accepted', 'sandbox')
       AND completed_at >= now() - interval '24 hours'`,
    [accountId],
  );
  const lastSent = result.rows[0]?.last_sent
    ? new Date(result.rows[0].last_sent as string)
    : null;
  const nextAllowed = lastSent
    ? new Date(lastSent.getTime() + account.minIntervalSeconds * 1000).toISOString()
    : null;
  return {
    sentLast24h: Number(result.rows[0]?.count ?? 0),
    dailyLimit: account.dailySendLimit,
    minIntervalSeconds: account.minIntervalSeconds,
    nextAllowedAt: nextAllowed && new Date(nextAllowed) > new Date() ? nextAllowed : null,
  };
}

export function renderEmailPreview(body: string, footerText: string): string {
  return `${textToHtmlParagraphs(body)}<div class="footer">${escapeHtml(footerText)}</div>`;
}
