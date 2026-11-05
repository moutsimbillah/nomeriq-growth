import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { getDb } from "@/lib/db/client";
import { decryptSecret } from "@/lib/auth/crypto";
import type { EmailAccountRecord } from "./accounts";

/**
 * Keeping one copy of every sent email in the mailbox's own Sent folder.
 *
 * Webmail and Growth have to agree about what was sent. Growth sends over SMTP, which does not write
 * to IMAP, so a message sent through the portal would be missing from the Sent folder the founder
 * reads on his phone. This closes that gap, in the order the plan asks for:
 *
 *  1. **Look first.** Open the Sent folder and search for the message's own Message-ID. If a copy is
 *     already there — the provider filed one automatically, or an earlier attempt succeeded — do
 *     nothing. That is what makes a repeated sync harmless and stops duplicates.
 *  2. **Append only when it is missing**, with the same Message-ID, so the copy threads with the
 *     conversation rather than starting a parallel one.
 *  3. **Mark the message** with `sent_copy_saved_at` so it is never checked again.
 *
 * Nothing here can fail a send: the message has already left, and a Sent-folder hiccup is a
 * bookkeeping problem. The caller runs it best-effort and the message stays marked unsaved so the
 * next sync retries it.
 */

/** The fields the copy needs, which the send path already has. */
export interface SentCopyInput {
  /** The Message-ID header value, with its angle brackets. */
  messageId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  fromName: string;
  fromEmail: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; contentType: string; content: Buffer }[];
}

/**
 * Build the MIME source for a message without sending it.
 *
 * `streamTransport` is nodemailer's own "compose but do not transmit" mode, so the bytes appended to
 * IMAP are produced by the same code that would have produced the SMTP payload — the copy is the
 * message, not a reconstruction of it.
 */
export async function buildRawMessage(input: SentCopyInput): Promise<Buffer> {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const composed = await transport.sendMail({
    from: input.fromName ? { name: input.fromName, address: input.fromEmail } : input.fromEmail,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
    messageId: input.messageId,
    headers: input.headers,
    attachments: input.attachments,
  });
  const raw = (composed as unknown as { message?: Buffer | string }).message;
  if (!raw) throw new Error("Could not compose the sent copy.");
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
}

/** The Sent folder for a mailbox, choosing the same way the sync does. */
export function chooseSentFolder(
  mailboxes: { path: string; specialUse?: string | null }[],
): string | null {
  return (
    mailboxes.find((mailbox) => /\\Sent/i.test(mailbox.specialUse ?? ""))?.path ??
    mailboxes.find((mailbox) => /^sent( items)?$/i.test(mailbox.path))?.path ??
    mailboxes.find((mailbox) => /sent/i.test(mailbox.path))?.path ??
    null
  );
}

export interface SentCopyResult {
  saved: boolean;
  /** True when a copy was already in the folder, which is a success, not a skip. */
  alreadyPresent: boolean;
  folder: string | null;
  note: string | null;
}

const NOT_SAVED = (note: string): SentCopyResult => ({
  saved: false,
  alreadyPresent: false,
  folder: null,
  note,
});

/**
 * Save the copy, or confirm one is already there.
 *
 * The IMAP client is created here rather than injected, but every decision is made through the small
 * pure helpers above, so the "look first, append only if missing" rule is testable without a server.
 * A sandbox account, a mailbox with no credentials, or a missing Sent folder all return `saved: false`
 * with a plain note instead of throwing.
 */
export async function saveSentCopy(
  account: EmailAccountRecord,
  input: SentCopyInput,
): Promise<SentCopyResult> {
  if (account.provider === "sandbox") return NOT_SAVED("Sandbox mailbox: there is no Sent folder to write to.");
  if (!account.imapHost || !account.passwordEncrypted) {
    return NOT_SAVED("No IMAP credentials on this profile, so the Sent copy was not written.");
  }

  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: { user: account.username, pass: decryptSecret(account.passwordEncrypted) },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
    tls: { minVersion: "TLSv1.2" },
  });

  try {
    await client.connect();
    const folder = chooseSentFolder(await client.list());
    if (!folder) return NOT_SAVED("This mailbox has no Sent folder, so the copy was not written.");

    const mailbox = await client.mailboxOpen(folder);
    // The copy is already there if any message in the folder carries this Message-ID. Searching by
    // header is exact; a provider that rewrites Message-IDs would leave us appending a second copy,
    // which is why the result is recorded rather than assumed.
    const found = await client.search({ header: { "message-id": input.messageId } }, { uid: true });
    const existing = Array.isArray(found) ? found : [];
    if (existing.length > 0) {
      return { saved: true, alreadyPresent: true, folder, note: `A copy is already in ${folder}.` };
    }

    const raw = await buildRawMessage(input);
    await client.append(folder, raw, ["\\Seen"], new Date());
    return { saved: true, alreadyPresent: false, folder, note: `Saved to ${folder}.` };
  } catch (error) {
    return NOT_SAVED(
      `The sent copy could not be written: ${
        error instanceof Error ? error.message.slice(0, 180) : "unknown IMAP error"
      }`,
    );
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/**
 * Best-effort wrapper: save the copy and record the outcome on the message row.
 *
 * Called after a send has been fully recorded, so a failure here leaves `sent_copy_saved_at` null and
 * the next sync's backfill picks it up. Never throws.
 */
export async function saveSentCopyForMessage(
  account: EmailAccountRecord,
  messageDbId: string,
  input: SentCopyInput,
): Promise<SentCopyResult> {
  try {
    const result = await saveSentCopy(account, input);
    if (result.saved) {
      const db = await getDb();
      await db.query(
        `UPDATE messages SET sent_copy_saved_at = now() WHERE id = $1 AND sent_copy_saved_at IS NULL`,
        [messageDbId],
      );
    }
    return result;
  } catch {
    return NOT_SAVED("The sent copy could not be written.");
  }
}

/**
 * Messages sent through Growth whose copy has not been confirmed in the mailbox yet.
 *
 * This is what makes the copy eventually consistent rather than best-effort-and-forget: whatever the
 * send path could not write (the mailbox was offline, IMAP refused, the process restarted) is listed
 * here and retried by the sync.
 */
export async function listUncopiedSentMessages(
  accountId: string,
  limit = 20,
): Promise<{ id: string; messageId: string; to: string; subject: string }[]> {
  const db = await getDb();
  const result = await db.query<{
    id: string;
    message_id: string;
    to_emails: unknown;
    subject: string;
  }>(
    `SELECT id, message_id, to_emails, subject FROM messages
      WHERE account_id = $1 AND direction = 'outbound'
        AND sent_copy_saved_at IS NULL
        AND message_id IS NOT NULL
        AND is_sandbox = false
      ORDER BY coalesce(sent_at, created_at) DESC
      LIMIT $2`,
    [accountId, Math.min(limit, 100)],
  );
  return result.rows.map((row) => ({
    id: row.id,
    messageId: row.message_id,
    to: Array.isArray(row.to_emails) ? String(row.to_emails[0] ?? "") : "",
    subject: row.subject,
  }));
}