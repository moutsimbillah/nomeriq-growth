import { getDb } from "@/lib/db/client";
import { AppError, normalizeEmail } from "@/lib/utils";
import {
  bounceDecision,
  bounceRateExceeded,
  parseBounce,
  suppressionReasonFor,
  BOUNCE_WINDOW,
  type BounceReport,
} from "./bounces";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Turning a delivery report into something the send gate respects.
 *
 * The plan's rule is that sync writes only unambiguous results. A delivery report is unambiguous about
 * one thing — whether that address can receive mail — so this module does exactly that and nothing
 * more: it records the report, and on a permanent one (or a complaint, or a third soft bounce) writes
 * a suppression, which the send gate already checks first.
 *
 * A bounce never marks the thread as replied, never cancels a follow-up because "they answered", and
 * never touches the prospect's stage: a bounce is a transport fact, not a conversation.
 */

export type BounceAction = "suppressed" | "retried";

export interface RecordedBounce {
  /** False when the message was not a delivery report at all. */
  isBounce: boolean;
  action: BounceAction | null;
  recipient: string | null;
  kind: BounceReport["kind"];
  /** Set when the account was paused by this report. */
  pausedProfile: boolean;
}

const NOT_A_BOUNCE: RecordedBounce = {
  isBounce: false,
  action: null,
  recipient: null,
  kind: "none",
  pausedProfile: false,
};

/** How many transient reports this address already has on record. */
export async function countPriorSoftBounces(normalizedEmail: string): Promise<number> {
  const db = await getDb();
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM email_bounces
      WHERE normalized_email = $1 AND kind = 'transient'`,
    [normalizedEmail],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * Record one inbound message as a bounce, if it is one.
 *
 * Returns `isBounce: false` for ordinary mail so the caller can carry on treating it as a reply. The
 * suppression write is idempotent: an address already suppressed keeps its original reason and date,
 * because the first reason recorded is the one that explains why contact stopped.
 */
export async function recordBounceIfAny(input: {
  accountId: string | null;
  messageDbId: string | null;
  fromEmail: string;
  subject: string;
  bodyText: string;
  contentType?: string | null;
  headers?: Record<string, string | null | undefined>;
}): Promise<RecordedBounce> {
  const report = parseBounce({
    fromEmail: input.fromEmail,
    subject: input.subject,
    bodyText: input.bodyText,
    contentType: input.contentType,
    headers: input.headers,
  });
  if (report.kind === "none") return NOT_A_BOUNCE;

  const db = await getDb();
  const recipient = report.recipient ? normalizeEmail(report.recipient) : null;
  if (!recipient) {
    // A report we cannot attribute to an address is recorded against nothing: suppressing the wrong
    // person is worse than missing one, and an unattributed report is still visible in the log.
    return { ...NOT_A_BOUNCE, isBounce: true, kind: report.kind, action: "retried" };
  }

  const prior =
    report.kind === "transient" ? await countPriorSoftBounces(recipient) : 0;
  const decision = bounceDecision({ kind: report.kind, priorSoftBounces: prior });
  const action: BounceAction = decision === "suppress" ? "suppressed" : "retried";

  await db.query(
    `INSERT INTO email_bounces
       (id, account_id, message_id, normalized_email, kind, dsn_status, diagnostic, action)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      crypto.randomUUID(),
      input.accountId,
      input.messageDbId,
      recipient,
      report.kind,
      report.status,
      report.diagnostic,
      action,
    ],
  );

  let pausedProfile = false;
  if (action === "suppressed") {
    const reason = suppressionReasonFor(report.kind);
    await db.query(
      `INSERT INTO suppressions (id, normalized_email, email, reason, source, prospect_id, note)
       VALUES ($1, $2, $2, $3, 'mailbox_sync',
         (SELECT prospect_id FROM messages WHERE id = $4), $5)
       ON CONFLICT (normalized_email) DO UPDATE SET
         active = true,
         note = coalesce(suppressions.note, EXCLUDED.note),
         updated_at = now()`,
      [
        crypto.randomUUID(),
        recipient,
        reason,
        input.messageDbId,
        report.diagnostic
          ? `${report.kind} bounce${report.status ? ` ${report.status}` : ""}: ${report.diagnostic}`.slice(0, 300)
          : `${report.kind} bounce`,
      ],
    );
    // A suppression is not a prospect decision, so the lead is flagged rather than archived: the
    // founder may still want the record.
    await db.query(
      `UPDATE prospects SET updated_at = now()
        WHERE id = (SELECT prospect_id FROM messages WHERE id = $1)`,
      [input.messageDbId],
    );
    if (input.accountId) pausedProfile = await pauseProfileIfBouncing(input.accountId);
  }

  return {
    isBounce: true,
    action,
    recipient,
    kind: report.kind,
    pausedProfile,
  };
}

/**
 * The bounce rate over an account's last {@link BOUNCE_WINDOW} sends.
 *
 * Counted from `outbound_sends`, which is the record of what was actually attempted, and matched to
 * bounce reports by recipient address. Only sends that left Growth count: an uncertain or blocked
 * attempt never reached the provider, so it cannot bounce.
 */
export async function bounceRateForAccount(accountId: string): Promise<{
  sends: number;
  bounces: number;
  rate: number;
  sampled: boolean;
  exceeded: boolean;
}> {
  const db = await getDb();
  const recent = await db.query<{ recipient_email: string | null; completed_at: string }>(
    `SELECT recipient_email, completed_at FROM outbound_sends
      WHERE account_id = $1 AND status IN ('accepted')
      ORDER BY completed_at DESC NULLS LAST
      LIMIT $2`,
    [accountId, BOUNCE_WINDOW],
  );
  const addresses = recent.rows
    .map((row) => row.recipient_email)
    .filter((value): value is string => Boolean(value))
    .map(normalizeEmail);

  let bounces = 0;
  if (addresses.length) {
    const bounced = await db.query<{ n: number }>(
      `SELECT count(DISTINCT normalized_email)::int AS n FROM email_bounces
        WHERE normalized_email = ANY($1::text[])
          AND kind IN ('permanent', 'complaint')`,
      [addresses],
    );
    bounces = Number(bounced.rows[0]?.n ?? 0);
  }

  const verdict = bounceRateExceeded({ sends: recent.rows.length, bounces });
  return { sends: recent.rows.length, bounces, ...verdict };
}

/**
 * Pause a sending profile whose recent bounce rate is over the limit.
 *
 * Returns true when the account was paused by this call. A profile already paused stays paused: the
 * rate has to come down (by the founder clearing it in Settings) before it sends again, so this never
 * quietly resumes anyone.
 */
export async function pauseProfileIfBouncing(accountId: string): Promise<boolean> {
  const db = await getDb();
  const rate = await bounceRateForAccount(accountId);
  if (!rate.exceeded) return false;

  const note =
    `Paused automatically: ${rate.bounces} of the last ${rate.sends} sends bounced ` +
    `(${(rate.rate * 100).toFixed(1)}%, above the 3% limit). Check the sending address and the ` +
    `prospect emails before resuming.`;
  const updated = await db.query(
    `UPDATE email_accounts
        SET status = 'paused_bounce', bounce_paused_at = now(), bounce_paused_note = $2,
            last_error = $2, updated_at = now()
      WHERE id = $1 AND status <> 'paused_bounce'`,
    [accountId, note],
  );
  return Boolean(updated.rowCount);
}

/** Clear an automatic pause by hand, which is the founder's decision, not the sync's. */
export async function resumeFromBouncePause(accountId: string): Promise<void> {
  const db = await getDb();
  const result = await db.query(
    `UPDATE email_accounts
        SET status = 'connected', bounce_paused_at = NULL, bounce_paused_note = NULL,
            last_error = NULL, updated_at = now()
      WHERE id = $1 AND status = 'paused_bounce'`,
    [accountId],
  );
  if (!result.rowCount) {
    throw new AppError("This mailbox is not paused by a bounce rate.", 409, "not_paused");
  }
}

/** The account's auto-pause state, for the Settings surface. */
export async function getBouncePauseState(accountId: string): Promise<{
  paused: boolean;
  pausedAt: string | null;
  note: string | null;
}> {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT status, bounce_paused_at, bounce_paused_note FROM email_accounts WHERE id = $1`,
    [accountId],
  );
  const row = result.rows[0];
  return {
    paused: row?.status === "paused_bounce",
    pausedAt: row?.bounce_paused_at ? new Date(row.bounce_paused_at).toISOString() : null,
    note: row?.bounce_paused_note ?? null,
  };
}