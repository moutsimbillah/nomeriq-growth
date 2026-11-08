import { createHash, randomBytes } from "node:crypto";
import { addedWindow } from "@/lib/dates/timezone";
import { getDb } from "@/lib/db/client";
import {
  getDefaultEmailAccount,
  getEmailAccountRecord,
  type EmailAccountRecord,
} from "@/lib/email/accounts";
import {
  pinSendingProfile,
  resolvePinnedProfile,
  warmupDailyLimit,
} from "@/lib/email/profiles";
import { saveSentCopyForMessage } from "@/lib/email/sent-copy";
import {
  deliverEmail,
  EmailDeliveryError,
  type DeliveryResult,
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
import { draftBodyOnly, complianceLines, withEmailIdentity } from "@/lib/email/message-content";
import { getDraft } from "./drafts";
import { messageRealTime, newestMessageFirst } from "./message-order";
import { recordFounderEnteredEmail } from "./prospects";
import { getWorkspaceSettings, type WorkspaceSettings } from "./settings";
import { getRecipientPolicy } from "./recipient-policy";
import { assertLeadOutreachAllowed } from "./lead-outreach-guard";
import { rejectionHeldAddresses } from "./lead-rejections";
import { realFollowUpInboundSql } from "./agent-followups";
import { linkedDuplicateFollowUpStopSql } from "./linked-contact-policy";
import { assertNoDuplicateContact, lockSendReservations } from "./duplicate-contact";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SendResult {
  /** True when a copy is confirmed in the mailbox's Sent folder (or was already there). */
  sentCopySaved?: boolean;
  /** Why the copy was not written, when it was not. Never a send failure. */
  sentCopyNote?: string | null;
  status: "accepted" | "sandbox" | "uncertain";
  alreadySent: boolean;
  messageId: string;
  accountEmail: string;
  response: string;
  sentAt: string;
  draftId: string;
  /** The server never confirmed delivery. Recorded as sent, with no step for the founder to take. */
  deliveryUncertain?: boolean;
  note?: string;
}

/**
 * A send that was held back by the account's own minimum interval. Nothing was sent, nothing is
 * recorded as sent, and the caller can try again once the window passes — the same shape the campaign
 * runner already uses when it re-queues an item.
 */
export interface QueuedSendResult {
  queued: true;
  retryAfterSeconds: number;
  note: string;
  draftId: string;
}

export type SendOutcome = SendResult | QueuedSendResult;

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
  settings?: WorkspaceSettings;
}): Promise<{ text: string; headers: Record<string, string> }> {
  const settings = input.settings ?? await getWorkspaceSettings();
  const isSandbox = input.accountProvider === "sandbox";
  if ((!settings.postalAddressEnabled || !settings.postalAddress.trim()) && !isSandbox) {
    throw new AppError(
      "Enable and supply your registered business postal address in Settings before sending commercial email.",
      409,
      "postal_address_missing",
    );
  }
  // Validate before creating a token: a refused send must not create an opt-out record.
  const unsubscribe = await unsubscribeUrl(input.prospectId, input.email);
  const lines = complianceLines(settings);
  if (isSandbox && !settings.postalAddress.trim() && settings.postalAddressEnabled) {
    lines.push("Sandbox test message — no message was delivered.");
  }
  const text = ["", "--", ...lines, `Unsubscribe: ${unsubscribe}`].join("\n");
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
  // An automatic bounce pause is a refusal with its own code: it is not a misconfigured mailbox, so
  // the founder is told what happened and how to clear it rather than being sent to Settings blind.
  if (account.status === "paused_bounce") {
    throw new AppError(
      account.lastError ||
        "This profile is paused because its recent bounce rate is above 3%. Check the address and the prospect emails, then resume it in Settings.",
      409,
      "bounce_rate_paused",
    );
  }
  if (account.status !== "connected") {
    throw new AppError(
      account.lastError ||
        "The email account is not connected. Check Settings before sending.",
      409,
      "email_account_not_connected",
    );
  }
  const db = await getDb();
  const settings = await getWorkspaceSettings();
  const now = new Date();
  const window = addedWindow("today", now, undefined, undefined, settings.timezone)!;
  const counts = await db.query<{ count: string | number; last_sent: string | null }>(
    `SELECT count(*) AS count, max(completed_at) AS last_sent
     FROM outbound_sends
     WHERE account_id = $1
       AND status IN ('accepted', 'sandbox')
       AND completed_at >= $2
       AND completed_at < $3`,
    [accountId, window.from.toISOString(), window.to.toISOString()],
  );
  const count = Number(counts.rows[0]?.count ?? 0);
  const warmupStartedAt = account.warmupStartedAt ? new Date(account.warmupStartedAt) : null;
  const allowedToday = warmupDailyLimit(
    account.dailySendLimit,
    warmupStartedAt,
    now,
    settings.timezone,
  );
  if (count >= allowedToday) {
    const rampNote = warmupStartedAt ? " This profile is warming up, so the figure rises daily." : "";
    throw new AppError(
      `The configured safety limit of ${allowedToday} sends per workspace day has been reached. This is your app-configured limit, not a claim about your provider's limit.${rampNote}`,
      429,
      "daily_limit_reached",
    );
  }
}

/**
 * The account's own minimum interval, kept apart from assertAccountCanSend on purpose: being too soon
 * is not a refusal. Nothing was sent, so the send is held back and can go again — the caller queues it
 * rather than reporting an error.
 */
export async function getSendReadiness(
  accountId: string,
): Promise<{ ready: true } | { ready: false; retryAfterSeconds: number }> {
  const account = await getEmailAccountRecord(accountId);
  if (!account) throw new AppError("Email account not found.", 404);
  const db = await getDb();
  const last = await db.query<{ last_sent: string | null }>(
    `SELECT max(completed_at) AS last_sent FROM outbound_sends
      WHERE account_id = $1 AND status IN ('accepted', 'sandbox', 'uncertain')`,
    [accountId],
  );
  const lastSent = last.rows[0]?.last_sent ? new Date(last.rows[0].last_sent).getTime() : null;
  if (!lastSent) return { ready: true };
  const elapsed = (Date.now() - lastSent) / 1000;
  if (elapsed >= account.minIntervalSeconds) return { ready: true };
  return { ready: false, retryAfterSeconds: Math.ceil(account.minIntervalSeconds - elapsed) };
}

async function checkRecipientSafety(
  prospectId: string,
  email: string,
  options: { allowFounderEntered?: boolean; draftId?: string | null } = {},
) {
  const db = await getDb();
  const prospect = await db.query<{ do_not_contact: boolean }>(
    `SELECT do_not_contact FROM prospects WHERE id = $1 AND archived_at IS NULL`,
    [prospectId],
  );
  if (!prospect.rows[0]) throw new AppError("Prospect not found.", 404);
  await assertLeadOutreachAllowed(prospectId, db);
  if (prospect.rows[0].do_not_contact) {
    throw new AppError(
      "This prospect is marked do not contact.",
      409,
      "do_not_contact",
    );
  }
  // Check the whole lead BEFORE recording a newly typed address. Bounce-only suppression is
  // address-specific; every other suppression and an unsubscribe classification stop all aliases.
  const policy = await getRecipientPolicy(prospectId, db);
  if ((await rejectionHeldAddresses([normalizeEmail(email), ...policy.emails.map(e=>normalizeEmail(e.email))], db)).length) {
    throw new AppError("This address is blocked by an offer-rejection hold, including across linked leads.", 409, "rejection_hold");
  }
  const suppressed = await db.query(
    `SELECT 1 FROM suppressions s WHERE s.active = true AND
      (s.normalized_email = $2 OR (s.reason <> 'bounce' AND
        (s.prospect_id = $1 OR s.normalized_email IN
          (SELECT normalized_email FROM prospect_emails WHERE prospect_id = $1))))
     UNION ALL SELECT 1 FROM conversations WHERE prospect_id = $1 AND classification = 'unsubscribe'`,
    [prospectId, normalizeEmail(email)],
  );
  const selected = policy.emails.find(e => normalizeEmail(e.email) === normalizeEmail(email));
  if (suppressed.rows.length) {
    throw new AppError(
      "This address is on the opt-out/suppression list. It cannot receive promotional email.",
      409,
      "suppressed",
    );
  }
  if (selected && (!selected.linked || selected.blocked)) {
    throw new AppError(selected.reason ?? "This recipient is unavailable.", 422, "unverified_recipient");
  }
  // Cross-lead duplicate contact, checked BEFORE a typed address could be recorded on this lead.
  await assertNoDuplicateContact({ prospectId, recipient: email, draftId: options.draftId }, db);
  if (!selected) {
    if (!options.allowFounderEntered) {
      throw new AppError(
        "The recipient is not the prospect's source-confirmed contact email.",
        422,
        "unverified_recipient",
      );
    }
    // Validate here, but persist a typed address only inside the locked send reservation below.
    // A racing refusal must not leave an incorrect contact association behind.
  }
}

async function priorContactExists(prospectId: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.query(
    `SELECT 1 FROM messages m LEFT JOIN conversations c ON c.id=m.conversation_id
     WHERE m.direction = 'outbound' AND m.delivery_status IS DISTINCT FROM 'failed'
       AND (m.prospect_id=$1 OR c.prospect_id=$1 OR EXISTS (
         SELECT 1 FROM prospect_emails e, jsonb_array_elements_text(CASE WHEN jsonb_typeof(m.to_emails)='array' THEN m.to_emails ELSE '[]'::jsonb END) recipient
         WHERE e.prospect_id=$1 AND e.normalized_email=lower(trim(recipient))))
     UNION ALL SELECT 1 FROM outbound_sends s JOIN drafts d ON d.id=s.draft_id
       WHERE s.status IN ('accepted','sandbox','uncertain') AND (s.prospect_id=$1 OR EXISTS (
         SELECT 1 FROM prospect_emails e WHERE e.prospect_id=$1 AND e.normalized_email=lower(trim(d.recipient_email))))
     UNION ALL SELECT 1 FROM messages m LEFT JOIN conversations c ON c.id=m.conversation_id
       JOIN prospect_duplicate_links l ON (l.prospect_id=m.prospect_id OR l.prospect_id=c.prospect_id)
       WHERE l.canonical_prospect_id=$1 AND l.restored_at IS NULL AND m.delivery_status IS DISTINCT FROM 'failed'
     UNION ALL SELECT 1 FROM outbound_sends s LEFT JOIN drafts d ON d.id=s.draft_id
       JOIN prospect_duplicate_links l ON (l.prospect_id=s.prospect_id OR l.prospect_id=d.prospect_id)
       WHERE l.canonical_prospect_id=$1 AND l.restored_at IS NULL AND s.status IN ('accepted','sandbox','uncertain','sending','queued')
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
    // The same "newest by its real time" order as the conversation page: `created_at` is the import
    // time for imported rows, so it cannot say which message really came last.
    `SELECT message_id, references_json, subject FROM messages
     WHERE conversation_id = $1
     ORDER BY ${newestMessageFirst()} LIMIT 1`,
    [conversationId],
  );
  return result.rows[0] ?? null;
}

/**
 * Has the prospect written since our own last message to them?
 *
 * Both sides are compared by the time each message really happened, never by `created_at`: an
 * imported inbound row carries the import time in `created_at`, which is later than every real send,
 * so a `created_at` comparison reported a reply to every send — cancelling follow-ups that were
 * overdue to go. The newest outbound is measured the same way, so a send stored late does not look
 * older than it is. No outbound at all still means any inbound counts as a reply, as before.
 */
export async function hasReplySinceLastOutbound(
  conversationId: string,
): Promise<boolean> {
  const db = await getDb();
  const result = await db.query(
    `SELECT 1 FROM messages m
     WHERE m.conversation_id = $1 AND ${realFollowUpInboundSql()}
       AND ${messageRealTime('m')} > COALESCE((
         SELECT max(${messageRealTime()}) FROM messages
         WHERE conversation_id = $1 AND direction = 'outbound'
       ), '-infinity'::timestamptz)
     LIMIT 1`,
    [conversationId],
  );
  return result.rows.length > 0;
}

async function hasFollowUpStoppingReply(prospectId: string): Promise<boolean> {
  const db = await getDb();
  if ((await db.query("SELECT id FROM prospect_rejection_recommendations WHERE prospect_id=$1 LIMIT 1", [prospectId])).rows.length) return true;
  const { rows } = await db.query(`SELECT 1 FROM messages m LEFT JOIN conversations c ON c.id=m.conversation_id
    WHERE (m.prospect_id=$1 OR c.prospect_id=$1) AND m.direction='inbound'
      AND (${realFollowUpInboundSql()} OR COALESCE(m.received_at,m.sent_at) IS NULL) LIMIT 1`, [prospectId]);
  if (rows.length) return true;
  // An active linked duplicate is the same business: its holds, replies and outcomes stop this
  // lead's follow-ups exactly as its own would — the same shared policy the candidate list and the
  // guarded draft INSERT apply, so a reply recorded on the duplicate stops the scheduled queue and
  // this manual send at the same moment.
  const linked = await db.query(`SELECT 1 FROM prospect_duplicate_links l JOIN prospects dp ON dp.id=l.prospect_id
    WHERE l.canonical_prospect_id=$1 AND l.restored_at IS NULL AND ${linkedDuplicateFollowUpStopSql("l","dp")} LIMIT 1`, [prospectId]);
  return linked.rows.length > 0;
}

export interface SendDraftOptions {
  draftId: string;
  accountId?: string | null;
  campaignId?: string | null;
  actorUserId: string;
  attachments?: EmailAttachmentInput[];
  /**
   * Set only by the founder's own send path: an address the founder typed is recorded as a
   * founder-entered contact instead of being refused. Never set by a tool or campaign call.
   */
  allowFounderRecipient?: boolean;
}

export async function sendDraft(
  options: SendDraftOptions,
): Promise<SendOutcome> {
  const draft = await getDraft(options.draftId);
  if (!draft) throw new AppError("Draft not found.", 404);
  const db = await getDb();
  const existingSend = await db.query<any>(
    `SELECT * FROM outbound_sends WHERE draft_id = $1 LIMIT 1`,
    [draft.id],
  );
  const existingRow = existingSend.rows[0] ?? null;

  // Idempotency must win even after the draft has transitioned to sent. An uncertain attempt counts
  // as sent too: it may well have been delivered, so repeating it is the one thing we must not do.
  if (
    existingRow?.status === "accepted" ||
    existingRow?.status === "sandbox" ||
    existingRow?.status === "uncertain"
  ) {
    const account = await getEmailAccountRecord(existingRow.account_id);
    return {
      status: existingRow.status,
      deliveryUncertain: existingRow.status === "uncertain",
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
  await checkRecipientSafety(draft.prospectId, draft.recipientEmail, {
    allowFounderEntered: options.allowFounderRecipient === true,
    draftId: draft.id,
  });

  if (existingRow?.status === "sending") {
    throw new AppError(
      "A send attempt for this draft is already in progress. Check Sent before retrying.",
      409,
      "send_in_progress",
    );
  }
  if (existingRow && existingRow.status !== "queued" && existingRow.status !== "failed") {
    throw new AppError(
      "This draft cannot be sent in its current state.",
      409,
      "send_blocked",
    );
  }
  // Reservation: under one serializing lock, re-check the cross-lead duplicate guard and write the
  // 'sending' row in the same transaction, so two leads sharing an identity cannot both pass the
  // check before either reservation exists. A refusal rolls back and writes nothing.
  try {
    await db.transaction(async (tx) => {
      await lockSendReservations(tx, draft.prospectId);
      await assertNoDuplicateContact(
        { prospectId: draft.prospectId, recipient: draft.recipientEmail, draftId: draft.id },
        tx,
      );
      if (options.allowFounderRecipient) {
        await recordFounderEnteredEmail(draft.prospectId, draft.recipientEmail, tx);
      }
      if (existingRow) {
        // queued: the scheduler is taking this one up (or the founder pressed Send again): the hold
        // is over. failed: a definitive SMTP rejection is safe to retry with the same ledger row.
        const moved = await tx.query(
          `UPDATE outbound_sends SET status = 'sending', error = null, started_at = now(), completed_at = null,
            queued_at = CASE WHEN status = 'queued' THEN null ELSE queued_at END
           WHERE id = $1 AND status = $2 RETURNING id`,
          [existingRow.id, existingRow.status],
        );
        if (!moved.rows.length) {
          throw new AppError(
            "A send attempt for this draft is already in progress. Check Sent before retrying.",
            409,
            "send_in_progress",
          );
        }
      } else {
        await tx.query(
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
      }
    });
  } catch (error) {
    if (!(error instanceof AppError) && String((error as { code?: string }).code) === "23505") {
      throw new AppError(
        "A send attempt for this draft already exists.",
        409,
        "already_sent",
      );
    }
    throw error;
  }

  // The lead's pinned profile wins outright. Until it is pinned, an explicit choice stands, and only a
  // mailbox the founder actually marked as the default may fill in — never simply "the only account":
  // nomeriq.com belongs to the leads the import pinned to it, and a lead it did not pin must not be sent
  // from silently. A draft's thread may not exist yet, so only the lead's own pin is consulted here;
  // replies read the thread's pin as well (see sendReply).
  const pinnedProfile = await resolvePinnedProfile({ prospectId: draft.prospectId });
  let account: EmailAccountRecord | null = null;
  if (pinnedProfile) {
    account = pinnedProfile;
  } else if (options.accountId) {
    account = await getEmailAccountRecord(options.accountId);
  } else {
    account = await getDefaultEmailAccount(true);
    if (!account) {
      await db.query(`DELETE FROM outbound_sends WHERE draft_id = $1`, [draft.id]);
      throw new AppError(
        "This lead has no sending profile yet, and no mailbox is set as the default. Pick the mailbox this lead is sent from on the lead page before sending — a mailbox is only ever used by the leads pinned to it.",
        409,
        "no_sender_profile",
      );
    }
  }
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
    if (await hasFollowUpStoppingReply(draft.prospectId)) {
      await db.query(
        `UPDATE outbound_sends SET status = 'blocked',
          error = 'Prospect replied; follow-up cancelled', completed_at = now()
         WHERE draft_id = $1`,
        [draft.id],
      );
      // The stop stays. The founder does not have to tidy up after it: the follow-up is cancelled
      // here, with the reason kept on the draft.
      await db.query(
        `UPDATE drafts SET status = 'cancelled',
          last_error = 'Cancelled automatically: the prospect replied before this follow-up was sent.',
          updated_at = now()
         WHERE id = $1`,
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
  const readiness = await getSendReadiness(account.id);
  if (!readiness.ready) {
    // Nothing was sent. The attempt row is kept and marked 'queued' with the moment it may go, so
    // processQueuedSends() finds it and sends it once the gap has passed — no second click needed.
    await db.query(
      `UPDATE outbound_sends SET status = 'queued', queued_at = now() + ($2 || ' seconds')::interval,
        error = null, started_at = now(), completed_at = null
       WHERE draft_id = $1 AND status = 'sending'`,
      [draft.id, String(readiness.retryAfterSeconds)],
    );
    return {
      queued: true,
      retryAfterSeconds: readiness.retryAfterSeconds,
      draftId: draft.id,
      note: `Held back by your own minimum interval between sends. Nothing was sent — it goes automatically in ${readiness.retryAfterSeconds}s.`,
    };
  }

  const settings = await getWorkspaceSettings();
  const footer = await buildComplianceFooter({
    accountProvider: account.provider,
    prospectId: draft.prospectId,
    email: draft.recipientEmail,
    settings,
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
  const body = draftBodyOnly(draft.body, [settings.senderSignature, account.signature]);
  if (!body) throw new AppError("Write a message body before sending.", 400, "empty_draft_body");
  const signedBody = withEmailIdentity(body, settings, account.signature);
  const text = `${signedBody}\n${footer.text}`;
  const html = `${textToHtmlParagraphs(signedBody)}<hr style="border:none;border-top:1px solid #ddd;margin:24px 0" /><div style="font-size:12px;color:#666">${textToHtmlParagraphs(footer.text.replace(/^\n+/, ""))}</div>`;

  // Last read before transport: composing the footer/profile may have yielded to a new opt-out.
  try {
    await checkRecipientSafety(draft.prospectId, draft.recipientEmail, { draftId: draft.id });
    if (draft.kind === "first_contact" && await priorContactExists(draft.prospectId)) {
      throw new AppError("This prospect has already been contacted.", 409, "already_contacted");
    }
    if (draft.kind === "follow_up" && outboundConversation && await hasFollowUpStoppingReply(draft.prospectId)) {
      throw new AppError("The prospect has replied. This follow-up was blocked.", 409, "prospect_replied");
    }
  } catch (error) {
    await db.query(`UPDATE outbound_sends SET status='blocked', error=$2, completed_at=now() WHERE draft_id=$1`,
      [draft.id, error instanceof Error ? error.message : "Recipient safety check failed"]);
    throw error;
  }
  let delivery: DeliveryResult;
  // Set when the transport could not confirm delivery: the send counts as sent with this note.
  let uncertainty: string | null = null;
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
    if (failure.definitive) {
      // A refusal is a refusal: nothing was delivered, the draft can be fixed and retried.
      await db.query(
        `UPDATE outbound_sends SET status = 'failed', error = $1, completed_at = now()
         WHERE draft_id = $2`,
        [failure.message, draft.id],
      );
      await db.query(
        `UPDATE drafts SET last_error = $1, updated_at = now() WHERE id = $2`,
        [failure.message, draft.id],
      );
      throw new AppError(failure.message, 502, "smtp_rejected");
    }
    // Anything else may well have been delivered, and repeating it is the one thing we must not do.
    // So it counts as sent, with the uncertainty recorded, and there is nothing to resolve by hand.
    uncertainty = failure.message;
    delivery = {
      mode: "live",
      transportMessageId: messageId,
      response: failure.message,
    };
  }

  // Assigned inside the recording transaction and used after it, for the Sent-folder copy.
  let messageDbId: string | null = null;

  const deliveryStatus = uncertainty
    ? "uncertain"
    : delivery.mode === "sandbox"
      ? "sandbox"
      : "accepted";
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

      // The lead and its thread are tied to the profile that just emailed them, in the same
      // transaction as the message row: no message may exist without a record of which mailbox sent it.
      await pinSendingProfile(
        { prospectId: draft.prospectId, conversationId, accountId: account.id },
        tx,
      );

      messageDbId = crypto.randomUUID();
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
          truncate(body, 220),
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

  // The email has left; this only makes webmail agree with Growth. A failure here is recorded as
  // "copy not saved yet" and retried by the next mailbox sync, so it can never undo a send.
  const sentCopy = messageDbId
    ? await saveSentCopyForMessage(account, messageDbId, {
        messageId: delivery.transportMessageId,
        to: draft.recipientEmail,
        subject,
        text,
        html,
        fromName: account.fromName,
        fromEmail: account.emailAddress,
        headers: {
          ...footer.headers,
          ...(previous?.message_id
            ? { "In-Reply-To": previous.message_id, References: references.join(" ") }
            : {}),
        },
        attachments: options.attachments,
      }).catch(() => null)
    : null;

  return {
    status: deliveryStatus,
    alreadySent: false,
    messageId: delivery.transportMessageId,
    accountEmail: account.emailAddress,
    response: delivery.response,
    sentAt,
    draftId: draft.id,
    sentCopySaved: sentCopy?.saved ?? false,
    sentCopyNote: sentCopy?.note ?? null,
    deliveryUncertain: uncertainty !== null,
    note: uncertainty
      ? "Recorded as sent. The sending server did not confirm delivery — check the mailbox if you need certainty."
      : undefined,
  };
}

/**
 * The refusals that will never succeed on a retry. Everything else is a condition that changes on its
 * own — a full daily limit, a mailbox not connected yet, a send already in flight — and stays queued.
 */
/** How long a transiently refused queued send waits before the scheduler tries it again. */
const QUEUED_RETRY_BACKOFF_SECONDS = 60;

const PERMANENT_STOP_CODES = new Set([
  "suppressed",
  "do_not_contact",
  "already_contacted",
  "prospect_replied",
  "unverified_recipient",
  "smtp_rejected",
  "duplicate_contact",
]);

export interface QueuedSendOutcome {
  draftId: string;
  sent: boolean;
  /** Set when a stop refused it: the row is marked blocked with this reason. */
  blockedBy?: string;
  retryAfterSeconds?: number;
}

/**
 * Sends the queued drafts whose moment has come. Called by the scheduled route, once per tick.
 *
 * Each candidate goes through sendDraft, so every stop still applies and nothing is bypassed: a queued
 * draft whose prospect has since opted out is refused here exactly as it would be from the interface.
 *
 * A refusal from a stop is final for that row (marked blocked with the reason) so a stop can never be
 * retried in a loop. Conditions that will change on their own are NOT final: a full daily limit, a
 * mailbox that is not connected yet, another send already in flight, or a mail server that is briefly
 * down all leave the row queued for the next tick.
 *
 * One bounded batch per call, oldest first, so a large queue cannot turn one tick into an unbounded run.
 */
export async function processQueuedSends(
  options: { max?: number } = {},
): Promise<{ due: number; sent: number; results: QueuedSendOutcome[] }> {
  const db = await getDb();
  const limit = Math.min(Math.max(options.max ?? 5, 1), 20);
  const due = await db.query<{ draft_id: string; account_id: string | null }>(
    `SELECT draft_id, account_id FROM outbound_sends
      WHERE status = 'queued' AND queued_at IS NOT NULL AND queued_at <= now()
      ORDER BY queued_at ASC
      LIMIT $1`,
    [limit],
  );

  const results: QueuedSendOutcome[] = [];
  for (const row of due.rows) {
    try {
      const outcome = await sendDraft({
        draftId: row.draft_id,
        accountId: row.account_id,
        actorUserId: "scheduler",
      });
      if ("queued" in outcome) {
        results.push({ draftId: row.draft_id, sent: false, retryAfterSeconds: outcome.retryAfterSeconds });
        continue;
      }
      results.push({ draftId: row.draft_id, sent: true });
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      if (appError && PERMANENT_STOP_CODES.has(appError.code)) {
        await db.query(
          `UPDATE outbound_sends SET status = 'blocked', error = $2, completed_at = now()
           WHERE draft_id = $1 AND status = 'queued'`,
          [row.draft_id, appError.message],
        ).catch(() => undefined);
        results.push({ draftId: row.draft_id, sent: false, blockedBy: appError.code });
        continue;
      }
      // A condition that will change on its own. The row was reset to 'sending' on the way in, so it
      // must go back to the queue: leaving it there would strand the draft — and 'sending' is exactly
      // what blocks a later attempt. A short backoff keeps a full mailbox from being hammered.
      await db.query(
        `UPDATE outbound_sends SET status = 'queued', error = $2,
          queued_at = now() + ($3 || ' seconds')::interval
         WHERE draft_id = $1 AND status = 'sending'`,
        [row.draft_id, appError?.message ?? null, String(QUEUED_RETRY_BACKOFF_SECONDS)],
      ).catch(() => undefined);
      results.push({ draftId: row.draft_id, sent: false, retryAfterSeconds: QUEUED_RETRY_BACKOFF_SECONDS });
    }
  }

  return { due: due.rows.length, sent: results.filter((r) => r.sent).length, results };
}

export async function getSendUsage(accountId: string): Promise<{
  sentToday: number;
  dailyLimit: number;
  minIntervalSeconds: number;
  nextAllowedAt: string | null;
}> {
  const account = await getEmailAccountRecord(accountId);
  if (!account) throw new AppError("Email account not found.", 404);
  const db = await getDb();
  const settings = await getWorkspaceSettings();
  const now = new Date();
  const window = addedWindow("today", now, undefined, undefined, settings.timezone)!;
  const result = await db.query<{ count: string | number; last_sent: string | null }>(
    `SELECT count(*) AS count, max(completed_at) AS last_sent
     FROM outbound_sends
     WHERE account_id = $1 AND status IN ('accepted', 'sandbox')
       AND completed_at >= $2
       AND completed_at < $3`,
    [accountId, window.from.toISOString(), window.to.toISOString()],
  );
  const lastSent = result.rows[0]?.last_sent
    ? new Date(result.rows[0].last_sent as string)
    : null;
  const nextAllowed = lastSent
    ? new Date(lastSent.getTime() + account.minIntervalSeconds * 1000).toISOString()
    : null;
  return {
    sentToday: Number(result.rows[0]?.count ?? 0),
    dailyLimit: account.dailySendLimit,
    minIntervalSeconds: account.minIntervalSeconds,
    nextAllowedAt: nextAllowed && new Date(nextAllowed) > new Date() ? nextAllowed : null,
  };
}

export function renderEmailPreview(body: string, footerText: string): string {
  return `${textToHtmlParagraphs(body)}<div class="footer">${escapeHtml(footerText)}</div>`;
}
