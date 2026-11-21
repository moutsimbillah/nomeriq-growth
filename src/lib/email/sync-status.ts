import { getDb } from "@/lib/db/client";
import { iso } from "@/lib/utils";

/**
 * The honest mailbox-sync status line.
 *
 * Its verdict is read from the newest `mailbox_sync_runs` row, NEVER from `email_accounts.last_sync_at`
 * — that column only moves when a sync SUCCEEDS, so a mailbox that has failed every run for a day still
 * reads "synced a minute ago". The run rows move on success and failure alike, which is the only way a
 * stopped 15-minute timer can become visible.
 *
 * The freshness alarm is deliberately independent of the outcome: "overdue" means no run has STARTED in
 * over the window, which is what a stopped or failing timer looks like from here. The app cannot read
 * the systemd timer, so it makes no "next sync at" claim; it reports only what it has observed.
 */

export type MailboxSyncVerdict = "succeeded" | "failed" | "overdue" | "never";

/** No run started within this window is the loud "overdue" alarm. */
export const MAILBOX_SYNC_OVERDUE_MS = 30 * 60 * 1000;

export interface MailboxSyncRun {
  /** The run's own status: running, completed, failed, expired, undone, undo_conflict. */
  status: string;
  /** When the run started, ISO, or null when unreadable. */
  startedAt: string | null;
}

export interface MailboxSyncStatus {
  verdict: MailboxSyncVerdict;
  /** The newest run's start, for "Last sync <time>". */
  at: string | null;
  /** Whole minutes since the newest run started; null when never. */
  ageMinutes: number | null;
}

function isConcluded(status: string): boolean {
  return status !== "running";
}

/**
 * The verdict over a mailbox's runs, newest first (the caller orders them). Pure, so the awkward
 * combinations are unit-tested without a database:
 *
 * - No rows ever → `never`: the timer has not produced a single run.
 * - The newest run started more than the overdue window ago → `overdue`. This is the loud case: whatever
 *   the last run's outcome, the timer is not keeping up.
 * - Otherwise the outcome is the newest CONCLUDED run's: `completed` → `succeeded`, anything else
 *   (`failed`, `expired`, `undone`, `undo_conflict`) → `failed`. A run still in flight contributes no
 *   outcome — a partial run must never read as success — so while it runs the line shows the last
 *   concluded result, and `never` if none has concluded yet.
 */
export function describeMailboxSync(rowsNewestFirst: MailboxSyncRun[], now: Date): MailboxSyncStatus {
  if (!rowsNewestFirst.length) return { verdict: "never", at: null, ageMinutes: null };

  const newest = rowsNewestFirst[0];
  const startedMs = newest.startedAt ? new Date(newest.startedAt).getTime() : Number.NaN;
  const ageMs = Number.isFinite(startedMs) ? now.getTime() - startedMs : Number.POSITIVE_INFINITY;
  const ageMinutes = Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 60_000)) : null;

  if (!(ageMs <= MAILBOX_SYNC_OVERDUE_MS)) {
    return { verdict: "overdue", at: newest.startedAt, ageMinutes };
  }

  const concluded = rowsNewestFirst.find((row) => isConcluded(row.status));
  if (!concluded) return { verdict: "never", at: newest.startedAt, ageMinutes };
  return {
    verdict: concluded.status === "completed" ? "succeeded" : "failed",
    at: newest.startedAt,
    ageMinutes,
  };
}

/** The newest runs for an account, so the pure decision above can be made from real database state. */
export async function getMailboxSyncStatus(
  accountId: string,
  now: Date = new Date(),
): Promise<MailboxSyncStatus> {
  const db = await getDb();
  const result = await db.query<{ status: string; started_at: string | null }>(
    `SELECT status, started_at FROM mailbox_sync_runs
      WHERE account_id = $1 ORDER BY started_at DESC, created_at DESC LIMIT 20`,
    [accountId],
  );
  return describeMailboxSync(
    result.rows.map((row) => ({ status: row.status, startedAt: iso(row.started_at) })),
    now,
  );
}
