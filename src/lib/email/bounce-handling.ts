import { getDb, type DbClient } from "@/lib/db/client";
import { AppError, normalizeEmail } from "@/lib/utils";
import {
  bounceDecision,
  bounceRateExceeded,
  parseBounceReports,
  type BounceInput,
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
  recorded?: number;
  replayed?: number;
  unprocessed?: number;
  failed?: boolean;
}

const NOT_A_BOUNCE: RecordedBounce = {
  isBounce: false,
  action: null,
  recipient: null,
  kind: "none",
  pausedProfile: false,
};

/** Distinct stored reports; legacy null-message rows cannot prove identity and do not count. */
export async function countPriorSoftBounces(normalizedEmail: string, tx?: DbClient): Promise<number> {
  const db = tx ?? await getDb();
  const result = await db.query<{ n: number }>(
    `SELECT count(DISTINCT message_id)::int AS n FROM email_bounces
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
type RecordInput = BounceInput & { accountId: string | null; messageDbId: string | null };

async function recordReports(tx: DbClient, input: RecordInput, reports: BounceReport[]): Promise<RecordedBounce> {
  const result: RecordedBounce = { ...NOT_A_BOUNCE, isBounce: true, recipient: reports[0]?.recipient ?? null, kind: reports[0]?.kind ?? "transient", recorded: 0, replayed: 0, unprocessed: 0 };
  const message = input.messageDbId ? await tx.query(`SELECT id FROM messages WHERE id = $1 AND account_id IS NOT DISTINCT FROM $2::uuid`, [input.messageDbId, input.accountId]) : null;
  if (!message?.rows.length || !reports.some((r) => r.recipient)) return { ...result, unprocessed: reports.length };
  await tx.query(`INSERT INTO workspace_settings (id) VALUES ('default') ON CONFLICT (id) DO NOTHING`);
  await tx.query(`SELECT id FROM workspace_settings WHERE id = 'default' FOR UPDATE`);
  for (const report of reports) {
    if (!report.recipient || !message?.rows.length) { result.unprocessed!++; continue; }
    const email = normalizeEmail(report.recipient);
    const existing = await tx.query<{ action: BounceAction }>(`SELECT action FROM email_bounces WHERE message_id = $1 AND normalized_email = $2 LIMIT 1`, [input.messageDbId, email]);
    if (existing.rows.length) { result.replayed!++; result.action ??= existing.rows[0].action; continue; }
    const prior = report.kind === "transient" ? await countPriorSoftBounces(email, tx) : 0;
    const action: BounceAction = bounceDecision({ kind: report.kind, priorSoftBounces: prior }) === "suppress" ? "suppressed" : "retried";
    await tx.query(`INSERT INTO email_bounces (id, account_id, message_id, normalized_email, kind, dsn_status, diagnostic, action) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [crypto.randomUUID(), input.accountId, input.messageDbId, email, report.kind, report.status, report.diagnostic, action]);
    result.recorded!++;
    if (action === "suppressed" || result.action === null) result.action = action;
    if (action === "suppressed") {
      await tx.query(`INSERT INTO suppressions (id, normalized_email, email, reason, source, prospect_id, note)
        VALUES ($1,$2,$2,$3,'mailbox_sync', (SELECT prospect_id FROM prospect_emails WHERE normalized_email = $2 LIMIT 1),$4)
        ON CONFLICT (normalized_email) DO UPDATE SET active = true`,
      [crypto.randomUUID(), email, suppressionReasonFor(report.kind), [report.status, report.diagnostic].filter(Boolean).join(" · ") || null]);
    }
  }
  if (result.recorded && input.accountId) result.pausedProfile = await pauseProfileIfBouncing(input.accountId, tx);
  return result;
}

/** Failed/unattributable reports remain recognized, never human replies. */
export async function recordBounceIfAny(input: RecordInput): Promise<RecordedBounce> {
  const reports = parseBounceReports(input);
  if (!reports.length) return { ...NOT_A_BOUNCE };
  try {
    const db = await getDb();
    return await db.transaction((tx) => recordReports(tx, input, reports));
  } catch {
    return { ...NOT_A_BOUNCE, isBounce: true, kind: reports[0].kind, recipient: reports[0].recipient, recorded: 0, replayed: 0, unprocessed: reports.length, failed: true };
  }
}

/**
 * The bounce rate over an account's last {@link BOUNCE_WINDOW} sends.
 *
 * Counted from `outbound_sends`, which is the record of what was actually attempted, and matched to
 * bounce reports by recipient address. Only sends that left Growth count: an uncertain or blocked
 * attempt never reached the provider, so it cannot bounce.
 */
export async function bounceRateForAccount(accountId: string, tx?: DbClient): Promise<{
  sends: number;
  bounces: number;
  rate: number;
  sampled: boolean;
  exceeded: boolean;
}> {
  const db = tx ?? await getDb();
  const counts = await db.query<{ sends: number; bounces: number }>(`WITH recent AS (
    SELECT id, recipient_email, completed_at FROM outbound_sends WHERE account_id = $1 AND status = 'accepted' AND completed_at IS NOT NULL
    ORDER BY completed_at DESC, id DESC LIMIT $2
  ) SELECT count(*)::int AS sends, count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM email_bounces b JOIN messages m ON m.id = b.message_id
    WHERE b.account_id = $1 AND b.normalized_email = lower(recent.recipient_email)
      AND b.kind IN ('permanent','complaint') AND coalesce(m.received_at,m.sent_at) >= recent.completed_at
      AND NOT EXISTS (SELECT 1 FROM outbound_sends later WHERE later.account_id = $1 AND later.status = 'accepted'
        AND lower(later.recipient_email) = lower(recent.recipient_email) AND later.completed_at > recent.completed_at
        AND later.completed_at <= coalesce(m.received_at,m.sent_at))
  ))::int AS bounces FROM recent`, [accountId, BOUNCE_WINDOW]);
  const sends = Number(counts.rows[0]?.sends ?? 0), bounces = Number(counts.rows[0]?.bounces ?? 0);
  return { sends, bounces, ...bounceRateExceeded({ sends, bounces }) };
}

/**
 * Pause a sending profile whose recent bounce rate is over the limit.
 *
 * Returns true when the account was paused by this call. A profile already paused stays paused: the
 * rate has to come down (by the founder clearing it in Settings) before it sends again, so this never
 * quietly resumes anyone.
 */
export async function pauseProfileIfBouncing(accountId: string, tx?: DbClient): Promise<boolean> {
  const db = tx ?? await getDb();
  const rate = await bounceRateForAccount(accountId, db);
  if (!rate.exceeded) return false;

  const note =
    `Paused automatically: ${rate.bounces} of the last ${rate.sends} sends bounced ` +
    `(${(rate.rate * 100).toFixed(1)}%, above the 3% limit). Check the sending address and the ` +
    `prospect emails before resuming.`;
  const updated = await db.query(
    `UPDATE email_accounts
        SET status = 'paused_bounce', bounce_paused_at = now(), bounce_paused_note = $2,
            last_error = $2, updated_at = now()
      WHERE id = $1 AND status = 'connected'`,
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

/** Address-specific transport history; event dates come from the original linked DSN message. */
export async function getAddressDeliveryStatuses(prospectId: string) {
  const db = await getDb();
  const { rows } = await db.query<{ email: string; normalized_email: string; kind: string | null; occurred_at: string | null; suppressed: boolean }>(`SELECT pe.email, pe.normalized_email, b.kind, b.occurred_at,
    EXISTS (SELECT 1 FROM suppressions s WHERE s.normalized_email = pe.normalized_email AND s.active) AS suppressed
    FROM prospect_emails pe LEFT JOIN LATERAL (
      SELECT eb.kind, coalesce(m.received_at,m.sent_at) AS occurred_at FROM email_bounces eb
      LEFT JOIN messages m ON m.id = eb.message_id WHERE eb.normalized_email = pe.normalized_email
      ORDER BY CASE WHEN eb.kind IN ('permanent','complaint') OR eb.action = 'suppressed' THEN 0 ELSE 1 END,
        coalesce(m.received_at,m.sent_at) DESC NULLS LAST, eb.created_at DESC LIMIT 1
    ) b ON true WHERE pe.prospect_id = $1 ORDER BY pe.normalized_email`, [prospectId]);
  return rows.map((r) => ({ email: r.email, normalizedEmail: r.normalized_email, status: r.kind === "permanent" ? "permanent_bounced" : r.kind === "complaint" ? "complaint" : r.kind === "transient" ? (r.suppressed ? "transient_suppressed" : "transient_retrying") : "unknown", suppressed: r.suppressed, occurredAt: r.occurred_at ? new Date(r.occurred_at).toISOString() : null }));
}

type HistoricalRow = { id: string; from_email: string; subject: string; body_text: string; raw_headers: Record<string, unknown>; attachments: { contentType?: string }[]; lead_name: string | null };
function historicalInput(row: HistoricalRow, accountId: string): RecordInput {
  const raw = row.raw_headers ?? {};
  const metadata = (raw.bounceInput && typeof raw.bounceInput === "object" ? raw.bounceInput : raw) as Record<string, unknown>;
  const headerValues = (metadata.headers && typeof metadata.headers === "object" ? metadata.headers : metadata) as Record<string, unknown>;
  const headers = Object.fromEntries(Object.entries(headerValues).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([key, value]) => [key.toLowerCase(), value]));
  const storedReportType = Array.isArray(row.attachments) ? row.attachments.find((a) => /message\/(delivery-status|feedback-report)/i.test(a.contentType ?? ""))?.contentType : undefined;
  return { accountId, messageDbId: row.id, fromEmail: row.from_email, subject: row.subject,
    bodyText: typeof metadata.bodyText === "string" ? metadata.bodyText : row.body_text,
    contentType: typeof metadata.contentType === "string" ? metadata.contentType : headers["content-type"] ?? storedReportType ?? (raw.deliveryReport === true ? "multipart/report" : undefined), headers };
}
function completeReport(report: BounceReport) {
  return Boolean(report.recipient && !report.incomplete);
}
async function historicalRows(db: DbClient, accountId: string) {
  const account = await db.query(`SELECT id FROM email_accounts WHERE id = $1`, [accountId]);
  if (!account.rows.length) throw new AppError("Mailbox not found.", 404, "not_found");
  return (await db.query<HistoricalRow>(`SELECT m.id,m.from_email,m.subject,m.body_text,m.raw_headers,m.attachments,p.business_name AS lead_name
    FROM messages m LEFT JOIN prospects p ON p.id = m.prospect_id WHERE m.account_id = $1 AND m.direction = 'inbound'
    ORDER BY coalesce(m.received_at,m.sent_at),m.id`, [accountId])).rows;
}
/** SELECT-only: no settings getters, defaults, logging, or mailbox connection. Counts/names only. */
export async function previewHistoricalBounces(accountId: string) {
  const db = await getDb();
  const rows = await historicalRows(db, accountId);
  const summary = { scanned: rows.length, reports: 0, replayed: 0, wouldNewlySuppress: 0, alreadySuppressed: 0, unattributable: 0, incomplete: 0, leads: [] as string[] };
  const planned = new Set<string>(), leadNames = new Set<string>();
  const soft = new Map<string, number>();
  for (const row of rows) {
    const input = historicalInput(row, accountId);
    for (const report of parseBounceReports(input)) {
      summary.reports++;
      if (row.lead_name) leadNames.add(row.lead_name);
      if (!report.recipient) summary.unattributable++;
      if (!completeReport(report)) { summary.incomplete++; continue; }
      const email = normalizeEmail(report.recipient!);
      const replay = await db.query(`SELECT 1 FROM email_bounces WHERE message_id = $1 AND normalized_email = $2`, [row.id, email]);
      if (replay.rows.length) { summary.replayed++; continue; }
      const suppression = await db.query(`SELECT 1 FROM suppressions WHERE normalized_email = $1 AND active`, [email]);
      if (suppression.rows.length || planned.has(email)) { summary.alreadySuppressed++; continue; }
      const prior = soft.get(email) ?? await countPriorSoftBounces(email, db);
      if (report.kind === "transient") soft.set(email, prior + 1);
      if (bounceDecision({ kind: report.kind, priorSoftBounces: prior }) === "suppress") { summary.wouldNewlySuppress++; planned.add(email); }
    }
  }
  summary.leads = [...leadNames].sort();
  return summary;
}
/** Manual-only entry point; never called from initialization or cron. */
export async function applyHistoricalBounces(input: { accountId: string; founderUserId: string; confirmation: string }) {
  if (input.confirmation !== "APPLY HISTORICAL BOUNCES") throw new AppError("Explicit historical bounce confirmation is required.", 400, "confirmation_required");
  const db = await getDb();
  const founder = await db.query(`SELECT id FROM users WHERE id = $1 AND role = 'founder' AND is_active = true`, [input.founderUserId]);
  if (!founder.rows.length) throw new AppError("Only the founder can do this.", 403, "forbidden");
  const summary = { recorded: 0, replayed: 0, unprocessed: 0 };
  for (const row of await historicalRows(db, input.accountId)) {
    const recordInput = historicalInput(row, input.accountId);
    const parsedReports = parseBounceReports(recordInput);
    const reports = parsedReports.filter(completeReport);
    summary.unprocessed += parsedReports.length - reports.length;
    if (!reports.length) continue;
    const result = await db.transaction((tx) => recordReports(tx, recordInput, reports));
    summary.recorded += result.recorded ?? 0; summary.replayed += result.replayed ?? 0; summary.unprocessed += result.unprocessed ?? 0;
  }
  return summary;
}
