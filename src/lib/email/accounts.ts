import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { getDb } from "@/lib/db/client";
import { decryptSecret, encryptSecret } from "@/lib/auth/crypto";
import { AppError, isEmail, iso, normalizeEmail } from "@/lib/utils";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type EmailProvider = "ionos" | "smtp_imap" | "sandbox";

export interface EmailAccountRecord {
  id: string;
  name: string;
  provider: EmailProvider;
  emailAddress: string;
  normalizedEmail: string;
  fromName: string;
  replyTo: string | null;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  username: string;
  passwordEncrypted: string;
  /**
   * `paused_bounce` is written only by the sync's own bounce-rate check: the profile sent enough to be
   * judged and more than 3% of it bounced. It refuses to send until the founder resumes it in Settings.
   */
  status: "unverified" | "connected" | "error" | "disabled" | "paused_bounce";
  lastError: string | null;
  lastCheckedAt: string | null;
  lastSyncAt: string | null;
  dailySendLimit: number;
  minIntervalSeconds: number;
  isDefault: boolean;
  /**
   * True for the import's own mailbox (moutsim@nomeriq.com): it exists so the messages the import
   * brought in have a mailbox to belong to, and it may only be used by the leads the import pinned to
   * it. It is never the workspace default, and the API refuses to make it one.
   */
  neverDefault: boolean;
  /** The profile's own sign-off; empty means fall back to the workspace signature. */
  signature: string;
  /** When this profile's warm-up began, or null for no ramp. */
  warmupStartedAt: string | null;
  createdAt: string;
}

export interface PublicEmailAccount extends Omit<EmailAccountRecord, "passwordEncrypted" | "username"> {
  hasCredentials: boolean;
}

function mapAccount(row: any): EmailAccountRecord {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    emailAddress: row.email_address,
    normalizedEmail: row.normalized_email,
    fromName: row.from_name,
    replyTo: row.reply_to,
    smtpHost: row.smtp_host,
    smtpPort: Number(row.smtp_port),
    smtpSecure: Boolean(row.smtp_secure),
    imapHost: row.imap_host,
    imapPort: Number(row.imap_port),
    imapSecure: Boolean(row.imap_secure),
    username: row.username,
    passwordEncrypted: row.password_encrypted,
    status: row.status,
    lastError: row.last_error,
    lastCheckedAt: iso(row.last_checked_at),
    lastSyncAt: iso(row.last_sync_at),
    dailySendLimit: Number(row.daily_send_limit),
    minIntervalSeconds: Number(row.min_interval_seconds),
    isDefault: Boolean(row.is_default),
    neverDefault: Boolean(row.never_default),
    signature: row.signature ?? "",
    warmupStartedAt: iso(row.warmup_started_at),
    createdAt: iso(row.created_at) ?? "",
  };
}

function publicAccount(account: EmailAccountRecord): PublicEmailAccount {
  const { passwordEncrypted: _password, username: _username, ...rest } = account;
  return { ...rest, hasCredentials: Boolean(_password) };
}

export async function getEmailAccountRecord(
  id: string,
): Promise<EmailAccountRecord | null> {
  const db = await getDb();
  const result = await db.query<any>(`SELECT * FROM email_accounts WHERE id = $1`, [id]);
  return result.rows[0] ? mapAccount(result.rows[0]) : null;
}

/**
 * The workspace default: the one account whose is_default is true — and only that one.
 *
 * There is deliberately no "the only account" fallback. A mailbox is the sender for the leads pinned to
 * it; being the default is a separate, deliberate choice the founder makes. Picking a row merely because
 * it is the one row available silently assigned a mailbox — nomeriq.com, which belongs to the imported
 * leads — to every lead the import never pinned to it. With nothing marked default this returns null, and
 * the caller says so rather than naming a sender the lead does not have.
 */
export async function getDefaultEmailAccount(
  requireConnected = false,
): Promise<EmailAccountRecord | null> {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT * FROM email_accounts
     WHERE status <> 'disabled' AND is_default = true AND never_default = false
     ORDER BY created_at ASC LIMIT 1`,
  );
  const account = result.rows[0] ? mapAccount(result.rows[0]) : null;
  if (!account) return null;
  if (requireConnected && account.status !== "connected") {
    throw new AppError(
      "Connect a healthy email account in Settings before sending.",
      409,
      "email_account_not_connected",
    );
  }
  return account;
}

/** The one sentence both refusals share: why this mailbox may never be the workspace default. */
function neverDefaultMessage(account: { emailAddress: string }): string {
  return `${account.emailAddress} belongs to the imported leads and may only be used by the leads the import pinned to it, so it can never be the workspace default. Pin it to a lead instead.`;
}

export interface MailboxSidebarState {
  kind: "default" | "import_only" | "no_default" | "none";
  label: string | null;
}

export interface MailboxSidebarAccount {
  emailAddress: string;
  provider: string;
  isDefault: boolean;
  neverDefault: boolean;
}

/**
 * The sidebar's mailbox line, decided from the accounts alone so it can be tested without a database.
 *
 * The workspace default is the sending mailbox. The import's own mailbox is not one: it exists so the
 * messages the import brought in have a mailbox to belong to, and it may only be used by the leads the
 * import pinned to it. Reporting "No mailbox connected" while that mailbox holds every imported thread
 * was simply untrue, so each state is named for what it actually is.
 */
export function describeMailbox(accounts: MailboxSidebarAccount[]): MailboxSidebarState {
  const sending = accounts.find((account) => account.isDefault && !account.neverDefault);
  if (sending) {
    return {
      kind: "default",
      label: `${sending.emailAddress}${sending.provider === "sandbox" ? " · sandbox" : ""}`,
    };
  }
  const importOnly = accounts.find((account) => account.neverDefault);
  if (importOnly) {
    return {
      kind: "import_only",
      label: `${importOnly.emailAddress} — import only · no sending mailbox`,
    };
  }
  const other = accounts[0];
  if (other) {
    return { kind: "no_default", label: `${other.emailAddress} — not the sending mailbox yet` };
  }
  return { kind: "none", label: null };
}

/** Reads the non-disabled mailboxes and lets `describeMailbox` name the state. */
export async function getMailboxSidebarState(): Promise<MailboxSidebarState> {
  const db = await getDb();
  const result = await db.query<{
    email_address: string;
    provider: string;
    is_default: boolean;
    never_default: boolean;
  }>(
    `SELECT email_address, provider, is_default, never_default FROM email_accounts
      WHERE status <> 'disabled'
      ORDER BY is_default DESC, never_default DESC, created_at ASC`,
  );
  return describeMailbox(
    result.rows.map((row) => ({
      emailAddress: row.email_address,
      provider: row.provider,
      isDefault: Boolean(row.is_default),
      neverDefault: Boolean(row.never_default),
    })),
  );
}

export async function listEmailAccounts(): Promise<PublicEmailAccount[]> {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT * FROM email_accounts ORDER BY is_default DESC, created_at ASC`,
  );
  return result.rows.map((row) => publicAccount(mapAccount(row)));
}

export interface EmailAccountInput {
  name?: string;
  provider: EmailProvider;
  emailAddress: string;
  fromName: string;
  replyTo?: string | null;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  username?: string;
  password?: string;
  dailySendLimit?: number;
  minIntervalSeconds?: number;
  isDefault?: boolean;
  /** The profile's own sign-off. Empty means fall back to the workspace signature. */
  signature?: string;
  /** When this profile's warm-up began, as an ISO date, or null for no ramp. */
  warmupStartedAt?: string | null;
}

function assertAccountInput(input: EmailAccountInput, requirePassword: boolean) {
  if (!isEmail(input.emailAddress)) throw new AppError("Enter a valid email address.");
  if (!input.fromName?.trim()) throw new AppError("Add a truthful sender name.");
  if (input.replyTo && !isEmail(input.replyTo)) {
    throw new AppError("Reply-to must be a valid email address.");
  }
  if (input.dailySendLimit !== undefined && (input.dailySendLimit < 1 || input.dailySendLimit > 500)) {
    throw new AppError("Daily limit must be between 1 and 500.");
  }
  if (input.minIntervalSeconds !== undefined && (input.minIntervalSeconds < 5 || input.minIntervalSeconds > 3600)) {
    throw new AppError("Minimum interval must be between 5 and 3,600 seconds.");
  }
  if (input.warmupStartedAt) {
    if (Number.isNaN(Date.parse(input.warmupStartedAt))) {
      throw new AppError("Warm-up start must be a real date.");
    }
  }
  if (input.signature !== undefined && input.signature.length > 2000) {
    throw new AppError("A signature can be at most 2,000 characters.");
  }
  if (input.provider !== "sandbox") {
    if (!input.smtpHost?.trim() || !input.imapHost?.trim() || !input.username?.trim()) {
      throw new AppError("SMTP host, IMAP host, and username are required.");
    }
    if (requirePassword && !input.password) {
      throw new AppError("Enter the mailbox password or app password.");
    }
  }
}

export async function createEmailAccount(
  input: EmailAccountInput,
  userId: string,
): Promise<PublicEmailAccount> {
  assertAccountInput(input, true);
  const db = await getDb();
  const id = crypto.randomUUID();
  const provider = input.provider;
  const isIonos = provider === "ionos" || (provider === "smtp_imap" && /ionos/i.test(input.emailAddress));
  const smtpHost =
    provider === "sandbox"
      ? ""
      : input.smtpHost?.trim() || (isIonos ? "smtp.ionos.com" : "");
  const imapHost =
    provider === "sandbox"
      ? ""
      : input.imapHost?.trim() || (isIonos ? "imap.ionos.com" : "");
  const passwordEncrypted =
    provider === "sandbox"
      ? encryptSecret(crypto.randomUUID())
      : encryptSecret(input.password!);
  const existing = await db.query<{ count: string | number }>(
    "SELECT count(*) AS count FROM email_accounts",
  );
  const isDefault = input.isDefault ?? Number(existing.rows[0]?.count ?? 0) === 0;

  try {
    await db.query(
      `INSERT INTO email_accounts (
        id, name, provider, email_address, normalized_email, from_name, reply_to,
        smtp_host, smtp_port, smtp_secure, imap_host, imap_port, imap_secure,
        username, password_encrypted, status, daily_send_limit, min_interval_seconds,
        is_default, signature, warmup_started_at, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [
        id,
        input.name?.trim() || (provider === "sandbox" ? "Sandbox test mailbox" : "IONOS mailbox"),
        provider,
        input.emailAddress.trim(),
        normalizeEmail(input.emailAddress),
        input.fromName.trim(),
        input.replyTo?.trim() || null,
        smtpHost,
        input.smtpPort ?? 587,
        input.smtpSecure ?? false,
        imapHost,
        input.imapPort ?? 993,
        input.imapSecure ?? true,
        provider === "sandbox" ? "sandbox" : input.username!.trim(),
        passwordEncrypted,
        provider === "sandbox" ? "connected" : "unverified",
        input.dailySendLimit ?? 25,
        input.minIntervalSeconds ?? 60,
        isDefault,
        input.signature ?? "",
        input.warmupStartedAt ?? null,
        userId,
      ],
    );
    if (isDefault) {
      await db.query(
        `UPDATE email_accounts SET is_default = false WHERE id <> $1`,
        [id],
      );
    }
  } catch (error) {
    if (String((error as { code?: string }).code) === "23505") {
      // The import creates a profile's row before any password exists, and the founder connects THAT
      // row later. A second account for the same address would split the imported messages from the
      // mailbox that syncs them — the sync matches on (account_id, message_id) — so this is refused
      // outright, and the message says where to go instead.
      const existing = await db.query<{ name: string }>(
        `SELECT name FROM email_accounts WHERE normalized_email = $1`,
        [normalizeEmail(input.emailAddress)],
      );
      const name = existing.rows[0]?.name;
      throw new AppError(
        name
          ? `That address is already set up as "${name}". Add its password to that profile instead of creating a second account — its messages and replies belong to it.`
          : "That email address is already set up. Add its password to the existing profile instead of creating a second account.",
        409,
        "email_account_exists",
      );
    }
    throw error;
  }

  if (provider !== "sandbox") {
    await verifyEmailAccountConnection(id).catch(() => undefined);
  }
  return publicAccount((await getEmailAccountRecord(id))!);
}

export async function updateEmailAccount(
  id: string,
  input: Partial<EmailAccountInput>,
): Promise<PublicEmailAccount> {
  const current = await getEmailAccountRecord(id);
  if (!current) throw new AppError("Email account not found.", 404);
  // A mailbox that may never be the default cannot be made one, however the request is worded.
  // never_default is deliberately not part of EmailAccountInput, so the normal update path can never
  // clear the mark either — only a migration can change it.
  if (current.neverDefault && input.isDefault === true) {
    throw new AppError(neverDefaultMessage(current), 409, "never_default_account");
  }
  const merged: EmailAccountInput = {
    provider: input.provider ?? current.provider,
    emailAddress: input.emailAddress ?? current.emailAddress,
    fromName: input.fromName ?? current.fromName,
    replyTo: input.replyTo === undefined ? current.replyTo : input.replyTo,
    smtpHost: input.smtpHost ?? current.smtpHost,
    smtpPort: input.smtpPort ?? current.smtpPort,
    smtpSecure: input.smtpSecure ?? current.smtpSecure,
    imapHost: input.imapHost ?? current.imapHost,
    imapPort: input.imapPort ?? current.imapPort,
    imapSecure: input.imapSecure ?? current.imapSecure,
    username: input.username ?? current.username,
    dailySendLimit: input.dailySendLimit ?? current.dailySendLimit,
    minIntervalSeconds: input.minIntervalSeconds ?? current.minIntervalSeconds,
    isDefault: current.neverDefault ? false : (input.isDefault ?? current.isDefault),
    signature: input.signature === undefined ? current.signature : input.signature,
    warmupStartedAt:
      input.warmupStartedAt === undefined ? current.warmupStartedAt : input.warmupStartedAt,
  };
  assertAccountInput(merged, false);
  const db = await getDb();
  const passwordEncrypted = input.password
    ? encryptSecret(input.password)
    : current.passwordEncrypted;
  try {
    await db.query(
      `UPDATE email_accounts SET
        name = $1, provider = $2, email_address = $3, normalized_email = $4,
        from_name = $5, reply_to = $6, smtp_host = $7, smtp_port = $8,
        smtp_secure = $9, imap_host = $10, imap_port = $11, imap_secure = $12,
        username = $13, password_encrypted = $14, daily_send_limit = $15,
        min_interval_seconds = $16, is_default = $17, status = $18,
        signature = $20, warmup_started_at = $21,
        last_error = null, updated_at = now()
       WHERE id = $19`,
      [
        input.name ?? current.name,
        merged.provider,
        merged.emailAddress.trim(),
        normalizeEmail(merged.emailAddress),
        merged.fromName.trim(),
        merged.replyTo?.trim() || null,
        merged.smtpHost?.trim() || "",
        merged.smtpPort,
        merged.smtpSecure,
        merged.imapHost?.trim() || "",
        merged.imapPort,
        merged.imapSecure,
        merged.provider === "sandbox" ? "sandbox" : merged.username?.trim() || "",
        passwordEncrypted,
        merged.dailySendLimit,
        merged.minIntervalSeconds,
        merged.isDefault,
        merged.provider === "sandbox" ? "connected" : "unverified",
        id,
        merged.signature ?? "",
        merged.warmupStartedAt ?? null,
      ],
    );
    if (merged.isDefault) {
      await db.query(
        `UPDATE email_accounts SET is_default = false WHERE id <> $1`,
        [id],
      );
    }
  } catch (error) {
    if (String((error as { code?: string }).code) === "23505") {
      throw new AppError("That email address is already connected.", 409);
    }
    throw error;
  }
  if (merged.provider !== "sandbox" && (input.password || input.smtpHost || input.imapHost)) {
    await verifyEmailAccountConnection(id).catch(() => undefined);
  }
  return publicAccount((await getEmailAccountRecord(id))!);
}

export async function setDefaultEmailAccount(id: string): Promise<void> {
  const account = await getEmailAccountRecord(id);
  if (!account) throw new AppError("Email account not found.", 404, "email_account_not_found");
  if (account.neverDefault) {
    throw new AppError(neverDefaultMessage(account), 409, "never_default_account");
  }
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.query(`UPDATE email_accounts SET is_default = false WHERE id <> $1`, [id]);
    await tx.query(`UPDATE email_accounts SET is_default = true, updated_at = now() WHERE id = $1`, [id]);
  });
}

export async function disableEmailAccount(id: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE email_accounts SET status = 'disabled', is_default = false, updated_at = now() WHERE id = $1`,
    [id],
  );
}

function actionableEmailError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/EAUTH|authentication|invalid credentials|login/i.test(message)) {
    return "The mail server rejected the username or password. For IONOS, confirm the mailbox is active and use the mailbox password (or an app password if enabled).";
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return "The mail server hostname could not be resolved. Check the SMTP/IMAP host names and DNS.";
  }
  if (/ETIMEDOUT|timeout|timed out/i.test(message)) {
    return "The connection timed out. Check the host, port, TLS mode, and whether your network blocks SMTP/IMAP.";
  }
  if (/self.signed|certificate|TLS|SSL/i.test(message)) {
    return "TLS negotiation failed. Use STARTTLS on port 587 for SMTP and TLS on port 993 for IMAP.";
  }
  return `Connection failed: ${message.slice(0, 300)}`;
}

export async function verifyEmailAccountConnection(id: string): Promise<{
  smtp: boolean;
  imap: boolean;
  error: string | null;
}> {
  const account = await getEmailAccountRecord(id);
  if (!account) throw new AppError("Email account not found.", 404);
  const db = await getDb();
  if (account.provider === "sandbox") {
    await db.query(
      `UPDATE email_accounts SET status = 'connected', last_checked_at = now(),
       last_error = null, updated_at = now() WHERE id = $1`,
      [id],
    );
    return { smtp: true, imap: true, error: null };
  }

  let smtpOk = false;
  let imapOk = false;
  let error: string | null = null;
  try {
    const password = decryptSecret(account.passwordEncrypted);
    const transporter = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort,
      secure: account.smtpSecure,
      requireTLS: !account.smtpSecure,
      auth: { user: account.username, pass: password },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,
      tls: { minVersion: "TLSv1.2" },
    });
    smtpOk = await transporter.verify();
    transporter.close();
  } catch (verifyError) {
    error = actionableEmailError(verifyError);
  }

  if (!error) {
    let client: ImapFlow | null = null;
    try {
      const password = decryptSecret(account.passwordEncrypted);
      client = new ImapFlow({
        host: account.imapHost,
        port: account.imapPort,
        secure: account.imapSecure,
        auth: { user: account.username, pass: password },
        logger: false,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 20_000,
        tls: { minVersion: "TLSv1.2" },
      });
      await client.connect();
      await client.mailboxOpen("INBOX", { readOnly: true });
      imapOk = true;
    } catch (verifyError) {
      error = actionableEmailError(verifyError);
    } finally {
      await client?.logout().catch(() => undefined);
    }
  }

  const connected = smtpOk && imapOk && !error;
  await db.query(
    `UPDATE email_accounts SET status = $1, last_error = $2,
     last_checked_at = now(), updated_at = now() WHERE id = $3`,
    [connected ? "connected" : "error", error, id],
  );
  return { smtp: smtpOk, imap: imapOk, error };
}
