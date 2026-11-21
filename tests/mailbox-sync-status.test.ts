import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  describeMailboxSync,
  MAILBOX_SYNC_OVERDUE_MS,
  type MailboxSyncRun,
} from "@/lib/email/sync-status";

/**
 * The honest mailbox sync line: its verdict comes from the newest mailbox_sync_runs row, never from
 * last_sync_at (which only moves on success), so a mailbox that has failed all day cannot read
 * "synced a minute ago". These cases pin every branch of the pure decision.
 */

const NOW = new Date("2026-11-22T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
const run = (status: string, minutesAgo: number, error: string | null = null): MailboxSyncRun => ({
  status,
  startedAt: at(minutesAgo),
  error,
});

describe("describeMailboxSync", () => {
  it("reports never when no run has ever been recorded", () => {
    expect(describeMailboxSync([], NOW)).toEqual({ verdict: "never", at: null, ageMinutes: null, reason: null });
  });

  it("reports succeeded for a fresh completed run", () => {
    const status = describeMailboxSync([run("completed", 2)], NOW);
    expect(status.verdict).toBe("succeeded");
    expect(status.at).toBe(at(2));
    expect(status.ageMinutes).toBe(2);
  });

  it("reports failed for a fresh failed or expired run", () => {
    expect(describeMailboxSync([run("failed", 3)], NOW).verdict).toBe("failed");
    expect(describeMailboxSync([run("expired", 3)], NOW).verdict).toBe("failed");
    expect(describeMailboxSync([run("undo_conflict", 3)], NOW).verdict).toBe("failed");
  });

  it("surfaces the failed run's OWN recorded reason, never a bare 'failed'", () => {
    const failed = describeMailboxSync([run("failed", 3, "IMAP login failed for moutsim@nomeriq.com.")], NOW);
    expect(failed.verdict).toBe("failed");
    expect(failed.reason).toBe("IMAP login failed for moutsim@nomeriq.com.");

    // An expired run carries the runner's own reason too ("lease expired"), and an undo conflict its own.
    expect(describeMailboxSync([run("expired", 3, "lease expired")], NOW).reason).toBe("lease expired");

    // A failed run that recorded no reason yields null rather than inventing one — the line says so.
    expect(describeMailboxSync([run("failed", 3)], NOW).reason).toBeNull();
    // A blank reason is not a reason.
    expect(describeMailboxSync([run("failed", 3, "   ")], NOW).reason).toBeNull();
  });

  it("never carries a reason on a success, an overdue or a never verdict", () => {
    expect(describeMailboxSync([run("completed", 2, "should be ignored")], NOW).reason).toBeNull();
    const staleMinutes = MAILBOX_SYNC_OVERDUE_MS / 60_000 + 1;
    expect(describeMailboxSync([run("failed", staleMinutes, "IMAP login failed")], NOW).reason).toBeNull();
    expect(describeMailboxSync([], NOW).reason).toBeNull();
  });

  it("uses the newest CONCLUDED run's reason, not a still-running run's", () => {
    const status = describeMailboxSync(
      [run("running", 1, "in flight"), run("failed", 6, "IMAP login failed")],
      NOW,
    );
    expect(status.verdict).toBe("failed");
    expect(status.reason).toBe("IMAP login failed");
  });

  it("reports overdue - the loud case - when no run started within the window, whatever the outcome", () => {
    const staleMinutes = MAILBOX_SYNC_OVERDUE_MS / 60_000 + 1;
    expect(describeMailboxSync([run("completed", staleMinutes)], NOW).verdict).toBe("overdue");
    // A stale FAILED run is still overdue, not merely failed: the timer itself is not firing.
    expect(describeMailboxSync([run("failed", staleMinutes)], NOW).verdict).toBe("overdue");
  });

  it("treats the window edge as still fresh", () => {
    const edge = MAILBOX_SYNC_OVERDUE_MS / 60_000;
    expect(describeMailboxSync([run("completed", edge)], NOW).verdict).toBe("succeeded");
    expect(describeMailboxSync([run("completed", edge + 1)], NOW).verdict).toBe("overdue");
  });

  it("never claims success for a run still in flight - it shows the newest concluded result", () => {
    // Newest is running; the last concluded run failed, so the honest verdict is failed.
    const status = describeMailboxSync([run("running", 1), run("failed", 6)], NOW);
    expect(status.verdict).toBe("failed");
    // Newest is running and there is no concluded run yet: nothing has succeeded, so it is not a success.
    expect(describeMailboxSync([run("running", 1)], NOW).verdict).toBe("never");
  });

  it("uses the newest row's start for the displayed time, even with an older concluded run", () => {
    const status = describeMailboxSync([run("running", 1), run("completed", 5)], NOW);
    expect(status.verdict).toBe("succeeded");
    expect(status.at).toBe(at(1));
  });

  it("reports overdue from the newest row even when an older run had concluded", () => {
    const staleMinutes = MAILBOX_SYNC_OVERDUE_MS / 60_000 + 5;
    const status = describeMailboxSync([run("running", staleMinutes), run("completed", 1)], NOW);
    expect(status.verdict).toBe("overdue");
  });

  it("ignores an unreadable start time rather than inventing freshness", () => {
    const status = describeMailboxSync([{ status: "completed", startedAt: null }], NOW);
    expect(status.verdict).toBe("overdue");
  });
});

describe("the sync line is wired from run rows, not last_sync_at", () => {
  const view = readFileSync("src/components/campaign-ui.tsx", "utf8");
  const page = readFileSync("src/app/(app)/email/email-tools.tsx", "utf8");

  it("shows the four verdicts and the fixed auto-sync interval", () => {
    for (const verdict of ["succeeded", "failed", "overdue", "never"]) expect(view).toContain(verdict);
    expect(view).toContain("Auto-sync every 15 minutes");
  });

  it("reads the newest run row and renders that line", () => {
    expect(page).toMatch(/getMailboxSyncStatus\(/);
    expect(page).toMatch(/MailboxSyncStatusLine/);
  });

  it("surfaces the run's own reason rather than a bare 'failed'", () => {
    // The view reads the run's own error/reason and says so when the run recorded none.
    expect(view).toMatch(/reason/);
    expect(view).toMatch(/recorded no reason/);
  });

  it("renders one status line per mailbox, not only the first account", () => {
    expect(page).toMatch(/getMailboxSyncStatus\(mailbox\.id\)/);
    expect(page).toMatch(/mailboxSync\.map\(/);
    expect(page).not.toMatch(/getMailboxSyncStatus\(account\.id\)/);
  });
});
