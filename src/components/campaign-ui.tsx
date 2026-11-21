"use client";

import { CircleAlert, FileText, LoaderCircle, MailCheck, Send, X } from "lucide-react";
import type { CampaignJournalEntry } from "@/lib/types";
import type { CampaignBatchPreview } from "@/lib/services/campaigns";
import type { MailboxSyncStatus, MailboxSyncVerdict } from "@/lib/email/sync-status";
import { Notice } from "./ui";

/**
 * The presentational half of the campaign screens. Nothing here reads a database or calls an endpoint —
 * the client containers own the hooks — so the awkward states (a failing draft, an overdue sync, a
 * paused campaign's last error) render in a test without a browser or a router.
 */

/* ------------------------------------------------------------------ honest mailbox sync line */

const SYNC_VERDICT_LABEL: Record<MailboxSyncVerdict, string> = {
  succeeded: "succeeded",
  failed: "failed",
  overdue: "overdue",
  never: "never",
};

/**
 * "Last sync <time> · succeeded|failed|overdue|never", beside the fixed "Auto-sync every 15 minutes".
 *
 * The verdict comes from the newest mailbox_sync_runs row, never from last_sync_at (which only moves on
 * success). "overdue" — no run for over 30 minutes — is deliberately loud: it is the only hint here the
 * 15-minute timer has stopped, and the app cannot read the timer, so it makes no "next sync at" claim.
 *
 * A "failed" verdict is never shown as if it explained itself: the run's own recorded reason
 * (`mailbox_sync_runs.error`) travels with it, and when the run recorded none the line says so plainly
 * rather than leaving a bare "failed".
 */
export function MailboxSyncStatusLine({
  status,
  atLabel,
}: {
  status: MailboxSyncStatus;
  /** The newest run's start, already formatted in the workspace zone; null when never. */
  atLabel: string | null;
}) {
  const { verdict, reason } = status;
  const overdue = verdict === "overdue";
  const failed = verdict === "failed";
  const failureReason = reason?.trim() ? reason.trim() : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-12 text-muted">
      <span className="inline-flex items-center gap-1.5">
        <MailCheck size={13} className={overdue ? "text-rust" : verdict === "never" ? "text-muted" : "text-forest"} />
        <span>
          Last sync <strong className="font-semibold text-ink">{atLabel ?? "never"}</strong>
        </span>
      </span>
      <span className="text-faint" aria-hidden>
        ·
      </span>
      <span
        data-sync-verdict={verdict}
        className={
          overdue
            ? "inline-flex items-center gap-1 rounded-md border border-rust/40 bg-rust/[0.12] px-2 py-0.5 font-bold uppercase tracking-wide text-rust"
            : verdict === "succeeded"
              ? "inline-flex items-center rounded-md border border-forest/20 bg-lime/20 px-2 py-0.5 font-semibold text-forest"
              : "inline-flex items-center gap-1 rounded-md border border-line bg-white/70 px-2 py-0.5 font-semibold text-muted"
        }
      >
        {overdue && <CircleAlert size={11} />}
        {SYNC_VERDICT_LABEL[verdict]}
      </span>
      {failed && (
        <span data-sync-reason className="min-w-0 break-anywhere text-rust">
          {failureReason ?? "The newest run failed and recorded no reason."}
        </span>
      )}
      <span className="text-faint">
        Auto-sync every 15 minutes
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ per-minute control */

/**
 * The per-minute field: a whole number 1..6, or EMPTY. Empty is spelled out as "no per-minute limit —
 * sends go back to back" and an empty value is the sanctioned state, never a blank that looks unset.
 * The value is a free number input on purpose: 0 or 7 is sent to the backend and its refusal shown
 * verbatim, never clamped here.
 */
export function PerMinuteControl({
  value,
  onChange,
  summary,
  hint,
  disabled,
  id = "per-minute",
}: {
  value: string;
  onChange: (value: string) => void;
  /** The founder's-words summary of the current value, from `perMinuteSummary`. */
  summary: string;
  hint?: string;
  disabled?: boolean;
  id?: string;
}) {
  const empty = value.trim() === "";
  return (
    <div>
      <label className="label" htmlFor={id}>
        Per-minute limit
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={id}
          className="input w-24"
          inputMode="numeric"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Empty"
          disabled={disabled}
        />
        <button
          type="button"
          className={empty ? "btn-secondary btn-xs" : "btn-ghost btn-xs"}
          onClick={() => onChange("")}
          disabled={disabled || empty}
        >
          No limit
        </button>
      </div>
      <p className={`mt-1 text-12 ${empty ? "font-semibold text-forest" : "text-muted"}`}>{summary}</p>
      {hint && <p className="mt-0.5 text-12 text-faint">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ batch preview */

/**
 * What the founder sees before committing: how many match, the emails that will go, and any draft the
 * mechanical check refuses. A single failing draft means the batch cannot be approved at all — the
 * backend is all-or-nothing — so the failure list is never hidden behind the count.
 */
export function CampaignBatchPreviewPanel({
  preview,
  loading,
  error,
}: {
  preview: CampaignBatchPreview | null;
  loading: boolean;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="rounded-xl border border-rust/20 bg-rust/[0.05] px-3 py-2 text-12 leading-5 text-rust">
        {error}
      </div>
    );
  }
  if (!preview) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-white/40 px-3 py-2 text-12 text-muted">
        {loading ? <LoaderCircle size={13} className="spin" /> : <FileText size={13} />}
        {loading ? "Counting matching drafts…" : "Choose filters to see how many drafts match."}
      </div>
    );
  }
  const failing = preview.failingPreviews;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-28 leading-none">{preview.matches}</span>
        <span className="text-12 text-muted">
          draft{preview.matches === 1 ? "" : "s"} match these filters · this batch selects{" "}
          <strong className="font-bold text-ink">{preview.selected}</strong>
        </span>
      </div>

      {failing.length > 0 && (
        <Notice tone="danger" title={`${failing.length} draft${failing.length === 1 ? "" : "s"} failed the check — nothing can be approved:`}>
          <ul className="mt-1 space-y-1">
            {failing.map((row) => (
              <li key={row.draftId} className="leading-5">
                <span className="inline-flex items-center gap-1 font-semibold">
                  <X size={11} /> {row.prospectName}
                </span>{" "}
                — {row.message}
              </li>
            ))}
          </ul>
        </Notice>
      )}

      {preview.sample.length > 0 && (
        <div>
          <div className="mb-1 text-12 font-bold uppercase tracking-[0.1em] text-faint">
            A few of the emails that will go
          </div>
          <ul className="space-y-1">
            {preview.sample.map((row) => (
              <li key={row.id} className="flex items-baseline gap-2 text-12">
                <span className="font-semibold text-ink">{row.prospectName}</span>
                <span className="min-w-0 truncate text-muted">{row.subject}</span>
              </li>
            ))}
          </ul>
          {preview.selected > preview.sample.length && (
            <div className="mt-1 text-12 text-faint">
              …and {preview.selected - preview.sample.length} more.
            </div>
          )}
        </div>
      )}

      {preview.matches === 0 && (
        <div className="text-12 text-muted">
          No prepared first-contact drafts match these filters yet, so there is nothing to queue.
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ journal */

const JOURNAL_LABEL: Record<string, string> = {
  item_skipped: "Skipped",
  system_failure: "Paused (system)",
  paused: "Paused",
  resumed: "Resumed",
  completed: "Completed",
  auto_started: "Started on schedule",
  auto_start_held: "Not auto-started",
};

/**
 * The run journal, so a shrinking number is always explained: every skipped item is named with the
 * reason the runner recorded, and every automatic start (or the refusal to make one) is in the same
 * list. A count never quietly drops without this.
 */
export function CampaignJournalList({ entries }: { entries: CampaignJournalEntry[] }) {
  if (!entries.length) return null;
  return (
    <ul className="mt-2 space-y-1">
      {entries.map((entry) => (
        <li key={entry.id} className="flex items-baseline gap-2 text-12 leading-5">
          <span
            className={`shrink-0 font-bold uppercase tracking-wide ${
              entry.level === "item_skipped" || entry.level === "auto_start_held"
                ? "text-amber"
                : entry.level === "system_failure" || entry.level === "paused"
                  ? "text-rust"
                  : "text-muted"
            }`}
          >
            {JOURNAL_LABEL[entry.level] ?? entry.level}
          </span>
          <span className="min-w-0 text-muted">{entry.reason}</span>
        </li>
      ))}
    </ul>
  );
}

/** The list of skips only, for a compact "N skipped" line — every skipped item and every held start. */
export function CampaignSkipList({ entries }: { entries: CampaignJournalEntry[] }) {
  const skips = entries.filter((entry) => entry.level === "item_skipped" || entry.level === "auto_start_held");
  if (!skips.length) return null;
  return <CampaignJournalList entries={skips} />;
}

/* ------------------------------------------------------------------ small shared bits */

export function CampaignApproveButton({
  count,
  disabled,
  pending,
  onClick,
}: {
  count: number;
  disabled: boolean;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="btn-primary" onClick={onClick} disabled={disabled || pending}>
      {pending ? <LoaderCircle size={13} className="spin" /> : <Send size={13} />}
      {pending
        ? "Approving and queuing…"
        : `Approve and queue ${count} email${count === 1 ? "" : "s"}`}
    </button>
  );
}
