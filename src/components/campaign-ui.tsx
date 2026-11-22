"use client";

import { CalendarClock, CircleAlert, FileText, LoaderCircle, MailCheck, Send, X } from "lucide-react";
import type { CampaignJournalEntry } from "@/lib/types";
import { CATEGORIES, PIPELINE, PIPELINE_LABELS } from "@/lib/types";
import { AGENT_LABELS, AGENT_TAGS } from "@/lib/agent/agentTag";
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
 * The live count and nothing else: the anchor the founder reads first, and the one line the controls
 * beneath it act on. Kept separate from the candidate list so the builder can put every control above
 * the list — see `CampaignBuilderPanel`.
 */
export function CampaignBatchCount({
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
  return (
    <div data-campaign-count className="flex flex-wrap items-baseline gap-2">
      <span className="text-28 leading-none">{preview.matches}</span>
      <span className="text-12 text-muted">
        draft{preview.matches === 1 ? "" : "s"} match these filters · this batch selects{" "}
        <strong className="font-bold text-ink">{preview.selected}</strong>
      </span>
    </div>
  );
}

/**
 * The candidate list: every failing draft NAMED (a single failing draft means the batch cannot be
 * approved at all — the backend is all-or-nothing — so the failure list is never hidden behind the
 * count) and a few of the emails that will go. This is the region the builder bounds and scrolls, so
 * no length of list can push a control out of reach.
 */
export function CampaignCandidateList({ preview }: { preview: CampaignBatchPreview | null }) {
  if (!preview) return null;
  const failing = preview.failingPreviews;
  return (
    <div className="space-y-3">
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

/**
 * Both halves in one block, for callers that want the count and the list together. The builder itself
 * uses the halves apart: the count above its controls, the list below them.
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
  return (
    <div className="space-y-3">
      <CampaignBatchCount preview={preview} loading={loading} error={error} />
      <CampaignCandidateList preview={preview} />
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

/* ------------------------------------------------------------------ the builder panel */

/** The filters the builder collects. The container builds the request from exactly this shape. */
export interface CampaignBuilderFilters {
  agent: string;
  market: string;
  stage: string;
  tier: string;
  sender: string;
  hasEmail: boolean;
  notContacted: boolean;
}

const TIER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "tier_1", label: "Tier 1 — email-first, reachable" },
  { value: "other", label: "Other" },
  { value: "email_no_website", label: "Email, no website" },
  { value: "category_b", label: "Category B — never emailed" },
  { value: "unassessed", label: "Unassessed" },
];

export interface CampaignBuilderPanelProps {
  accounts: Array<{ id: string; emailAddress: string; provider: string; status: string }>;
  name: string;
  accountId: string;
  filters: CampaignBuilderFilters;
  batchSize: string;
  timing: "now" | "at";
  whenLocal: string;
  perMinute: string;
  /** The founder's-words summary of the current per-minute value, from `perMinuteSummary`. */
  perMinuteSummary: string;
  perMinuteHint: string;
  timezone: string;
  preview: CampaignBatchPreview | null;
  previewLoading: boolean;
  previewError: string | null;
  error: string | null;
  matches: number;
  overMatched: boolean;
  queueCount: number;
  /** Every refusal for the selected drafts; any one of them disables the primary action. */
  failingCount: number;
  /** How many of the selected drafts PASSED the check — the batch the alternative would queue. */
  passingCount: number;
  pending: boolean;
  onNameChange: (value: string) => void;
  onAccountChange: (value: string) => void;
  onFilterChange: <K extends keyof CampaignBuilderFilters>(
    key: K,
    value: CampaignBuilderFilters[K],
  ) => void;
  onBatchSizeChange: (value: string) => void;
  onTimingChange: (value: "now" | "at") => void;
  onWhenChange: (value: string) => void;
  onPerMinuteChange: (value: string) => void;
  /** The one approval action: approves and queues the selected batch. */
  onApprove: () => void;
  /**
   * The founder's explicit alternative when drafts fail the check: re-form the batch to the ones that
   * pass and queue only those. Never taken without this click.
   */
  onApprovePassingOnly: () => void;
  onClose: () => void;
}

/**
 * The builder's form. Two rules shape the order, and both are load-bearing:
 *
 * 1. Every control sits ABOVE the candidate list, and the list lives in its own bounded, scrollable
 *    region — so a 500-row list cannot push the controls out of reach. The live count is the anchor;
 *    the start choice, the per-minute limit and the notice follow it; then the action bar.
 * 2. The action bar (the batch size and the ONE approve button) is `sticky bottom-0`, so it stays on
 *    screen while the list is read, at any list length.
 *
 * The all-or-nothing refusal is unchanged: a single failing draft disables the primary button, names
 * every failure in the list below, and offers no click that could approve them. The alternative beside
 * it is an explicit founder action that states the reduced count and leaves the failing drafts listed.
 */
export function CampaignBuilderPanel({
  accounts,
  name,
  accountId,
  filters,
  batchSize,
  timing,
  whenLocal,
  perMinute,
  perMinuteSummary: perMinuteSummaryText,
  perMinuteHint,
  timezone,
  preview,
  previewLoading,
  previewError,
  error,
  matches,
  overMatched,
  queueCount,
  failingCount,
  passingCount,
  pending,
  onNameChange,
  onAccountChange,
  onFilterChange,
  onBatchSizeChange,
  onTimingChange,
  onWhenChange,
  onPerMinuteChange,
  onApprove,
  onApprovePassingOnly,
  onClose,
}: CampaignBuilderPanelProps) {
  const approveDisabled =
    pending ||
    queueCount < 1 ||
    failingCount > 0 ||
    !accountId ||
    !name.trim() ||
    previewLoading ||
    (timing === "at" && !whenLocal);
  // The alternative never weakens the refusal: it is only offered when something would actually go,
  // and it carries the same guards as the primary action minus the failing-draft block.
  const passingOnlyOffered = failingCount > 0 && passingCount > 0;
  const passingOnlyDisabled =
    pending ||
    passingCount < 1 ||
    !accountId ||
    !name.trim() ||
    previewLoading ||
    (timing === "at" && !whenLocal);

  return (
    <div className="mt-4 space-y-4" data-campaign-panel>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="campaign-name">
            Campaign name
          </label>
          <input
            id="campaign-name"
            className="input"
            value={name}
            placeholder="e.g. Tier 1 signals — November"
            onChange={(event) => onNameChange(event.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="campaign-account">
            Send from
          </label>
          <select
            id="campaign-account"
            className="select"
            value={accountId}
            onChange={(event) => onAccountChange(event.target.value)}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.emailAddress}
                {account.provider === "sandbox" ? " (sandbox)" : ""}
                {account.status !== "connected" ? " — not connected" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-paper/40 p-3.5">
        <div className="mb-2 text-12 font-bold uppercase tracking-[0.1em] text-faint">Who it goes to</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className="label" htmlFor="filter-tier">
              Tier
            </label>
            <select
              id="filter-tier"
              className="select"
              value={filters.tier}
              onChange={(event) => onFilterChange("tier", event.target.value)}
            >
              <option value="">Any tier</option>
              {TIER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="filter-market">
              Market
            </label>
            <select
              id="filter-market"
              className="select"
              value={filters.market}
              onChange={(event) => onFilterChange("market", event.target.value)}
            >
              <option value="">Any market</option>
              {CATEGORIES.map((category) => (
                <option key={category.value} value={category.value}>
                  {category.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="filter-stage">
              Stage
            </label>
            <select
              id="filter-stage"
              className="select"
              value={filters.stage}
              onChange={(event) => onFilterChange("stage", event.target.value)}
            >
              <option value="">Any stage</option>
              {PIPELINE.map((stage) => (
                <option key={stage} value={stage}>
                  {PIPELINE_LABELS[stage]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="filter-sender">
              Sender
            </label>
            <select
              id="filter-sender"
              className="select"
              value={filters.sender}
              onChange={(event) => onFilterChange("sender", event.target.value)}
            >
              <option value="">Any sender</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.emailAddress}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="filter-agent">
              Saved by
            </label>
            <select
              id="filter-agent"
              className="select"
              value={filters.agent}
              onChange={(event) => onFilterChange("agent", event.target.value)}
            >
              <option value="">Any agent</option>
              {AGENT_TAGS.map((tag) => (
                <option key={tag} value={tag}>
                  {AGENT_LABELS[tag]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-4">
          <label className="inline-flex items-center gap-2 text-12 font-semibold text-ink">
            <input
              type="checkbox"
              className="accent-[#11231a]"
              checked={filters.notContacted}
              onChange={(event) => onFilterChange("notContacted", event.target.checked)}
            />
            Not yet contacted
          </label>
          <label className="inline-flex items-center gap-2 text-12 font-semibold text-ink">
            <input
              type="checkbox"
              className="accent-[#11231a]"
              checked={filters.hasEmail}
              onChange={(event) => onFilterChange("hasEmail", event.target.checked)}
            />
            Has a contact email
          </label>
        </div>
        <p className="mt-2 text-12 text-faint">
          Every candidate already has a prepared or approved first-contact draft — that is exactly what
          makes it selectable here, so nothing unapproved can slip in.
        </p>
      </div>

      {/* The anchor the founder reads first; the controls follow it, the candidate list does not. */}
      <CampaignBatchCount preview={preview} loading={previewLoading} error={previewError} />

      <div>
        <span className="label">Start</span>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2 text-12 font-semibold text-ink">
            <input
              type="radio"
              name="campaign-timing"
              checked={timing === "now"}
              onChange={() => onTimingChange("now")}
            />
            Start now
          </label>
          <label className="inline-flex items-center gap-2 text-12 font-semibold text-ink">
            <input
              type="radio"
              name="campaign-timing"
              checked={timing === "at"}
              onChange={() => onTimingChange("at")}
            />
            At a date and time
          </label>
        </div>
        {timing === "at" && (
          <input
            type="datetime-local"
            className="input mt-2 w-auto"
            value={whenLocal}
            aria-label={`Start time, ${timezone}`}
            onChange={(event) => onWhenChange(event.target.value)}
          />
        )}
        <p className="mt-1 inline-flex items-center gap-1 text-12 text-faint">
          <CalendarClock size={11} /> Times are {timezone}.{" "}
          {timing === "at"
            ? "A scheduled campaign starts itself — you do not need to be here."
            : "A campaign set to start now waits for your Start."}
        </p>
      </div>

      <PerMinuteControl
        value={perMinute}
        onChange={onPerMinuteChange}
        summary={perMinuteSummaryText}
        hint={perMinuteHint}
        id="campaign-per-minute"
      />

      {error && (
        <div className="rounded-xl border border-rust/20 bg-rust/[0.05] px-3 py-2 text-12 leading-5 text-rust">
          {error}
        </div>
      )}

      <Notice tone="info">
        {queueCount > 0 && failingCount === 0
          ? `One click approves these ${queueCount} draft${queueCount === 1 ? "" : "s"} and queues them. A single failure later is skipped and named; only a system failure pauses the campaign.`
          : "Fix any failing draft first — the batch is all-or-nothing, so one bad draft blocks the whole batch."}
      </Notice>

      {/*
        The founder's escape from "fix any failing draft first": one explicit click re-forms the batch to
        the drafts that PASS and says the reduced number out loud. Nothing is excluded without it, and
        the failing drafts stay listed below.
      */}
      {passingOnlyOffered && (
        <div
          data-campaign-passing-only
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber/30 bg-amber/[0.07] px-3 py-2.5"
        >
          <div className="min-w-0 text-12 leading-5 text-muted">
            <strong className="font-semibold text-ink">
              {passingCount} of {queueCount} selected drafts passed
            </strong>{" "}
            — {failingCount === 1 ? "1 failing draft stays" : `${failingCount} failing drafts stay`} unapproved and
            listed below. This one click queues only the {passingCount} that pass.
          </div>
          <button
            type="button"
            data-campaign-approve-passing
            className="btn-secondary btn-sm shrink-0"
            disabled={passingOnlyDisabled}
            onClick={onApprovePassingOnly}
          >
            {pending ? <LoaderCircle size={12} className="spin" /> : <Send size={12} />}
            Approve the {passingCount} that pass instead
          </button>
        </div>
      )}

      {/* Sticky: the batch size and the one approve action stay on screen however long the list is. */}
      <div
        data-campaign-actions
        className="sticky bottom-0 z-20 -mx-5 flex flex-wrap items-end justify-between gap-3 border-t border-line bg-panel/95 px-5 py-3 backdrop-blur"
      >
        <div>
          <label className="label" htmlFor="batch-size">
            Batch size
          </label>
          <input
            id="batch-size"
            className="input w-32"
            inputMode="numeric"
            value={batchSize}
            placeholder={matches ? String(matches) : "All"}
            onChange={(event) => onBatchSizeChange(event.target.value)}
          />
          <p className="mt-1 text-12 text-muted">
            {matches > 0
              ? `Up to ${matches} match. Leave empty to take them all.`
              : "Waiting for matches."}
            {overMatched && (
              <span className="ml-1 font-semibold text-amber">
                Only {matches} match — the batch will be {matches}.
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <CampaignApproveButton
            count={queueCount}
            disabled={approveDisabled}
            pending={pending}
            onClick={onApprove}
          />
        </div>
      </div>

      {/* The candidate list, in its own bounded region: it can never push a control out of reach. */}
      {preview && !previewError && (
        <div
          data-campaign-candidates
          className="max-h-[45vh] overflow-y-auto rounded-xl border border-line bg-paper/30 p-3"
        >
          <CampaignCandidateList preview={preview} />
        </div>
      )}
    </div>
  );
}

/**
 * What the founder is told after clicking the alternative: the count that actually went, and every
 * failing draft named again — left out, still unapproved and still listed, never silently dropped.
 */
export function CampaignBatchApprovedNotice({
  approved,
  excluded,
}: {
  approved: number;
  excluded: Array<{ draftId: string; prospectName: string; message: string }>;
}) {
  if (!excluded.length) return null;
  return (
    <div
      data-campaign-passing-notice
      className="mt-3 rounded-xl border border-amber/30 bg-amber/[0.07] px-3 py-2 text-12 leading-5 text-[#76501a]"
    >
      <div className="font-semibold">
        Approved and queued {approved} email{approved === 1 ? "" : "s"} — only the drafts that passed.
      </div>
      <div className="mt-1">
        {excluded.length} failing draft{excluded.length === 1 ? "" : "s"} {excluded.length === 1 ? "was" : "were"} left
        out and NOT approved — {excluded.length === 1 ? "it stays" : "they stay"} unapproved, and the reasons are
        listed here so nothing dropped silently:
      </div>
      <ul className="mt-1 space-y-0.5">
        {excluded.map((row) => (
          <li key={row.draftId}>
            <strong className="font-semibold">{row.prospectName}</strong> — {row.message}
          </li>
        ))}
      </ul>
    </div>
  );
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
    <button
      type="button"
      data-campaign-approve
      className="btn-primary"
      onClick={onClick}
      disabled={disabled || pending}
    >
      {pending ? <LoaderCircle size={13} className="spin" /> : <Send size={13} />}
      {pending
        ? "Approving and queuing…"
        : `Approve and queue ${count} email${count === 1 ? "" : "s"}`}
    </button>
  );
}
