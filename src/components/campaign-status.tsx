"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, CircleAlert, LoaderCircle, Pause, Play, Send, Square } from "lucide-react";
import { apiRequest } from "./client-ui";
import { Card, Notice, SectionHeading } from "./ui";
import { CampaignJournalList, PerMinuteControl } from "./campaign-ui";
import { useWorkspaceTimezone } from "./workspace-timezone";
import {
  NO_PER_MINUTE_LABEL,
  PER_MINUTE_RANGE_HINT,
  perMinuteSummary,
} from "@/lib/campaigns/pacing";
import { formatDateTime, relativeTime } from "@/lib/utils";
import type { CampaignSummary } from "@/lib/types";

const STATUS_TONE: Record<string, string> = {
  approved: "border-amber/20 bg-amber/[0.07] text-amber",
  active: "border-forest/20 bg-lime/25 text-forest",
  paused: "border-rust/20 bg-rust/[0.06] text-rust",
  completed: "border-forest bg-forest text-lime",
  cancelled: "border-line bg-white text-muted",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge capitalize ${STATUS_TONE[status] ?? "border-line bg-white text-muted"}`}>
      {status}
    </span>
  );
}

/**
 * One campaign in the list: its counts, its status, the pause/resume/cancel controls, an inline
 * per-minute edit that works while it runs, the last error when it paused, and every skip named with
 * its reason from the run journal — so a number never quietly shrinks and a scheduled start is visible.
 */
function CampaignRow({ campaign }: { campaign: CampaignSummary }) {
  const router = useRouter();
  const timezone = useWorkspaceTimezone();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [perMinute, setPerMinute] = useState(
    campaign.perMinuteCap === null ? "" : String(campaign.perMinuteCap),
  );

  async function changeStatus(status: "paused" | "active" | "cancelled") {
    setPending(status);
    setError(null);
    setSaved(null);
    try {
      await apiRequest(`/api/campaigns/${campaign.id}/status`, { body: { status } });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the campaign.");
    } finally {
      setPending(null);
    }
  }

  async function start() {
    setPending("start");
    setError(null);
    setSaved(null);
    try {
      await apiRequest(`/api/campaigns/${campaign.id}/start`, { method: "POST" });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start the campaign.");
    } finally {
      setPending(null);
    }
  }

  async function savePacing() {
    setPending("pacing");
    setError(null);
    setSaved(null);
    const trimmed = perMinute.trim();
    const cap = trimmed === "" ? null : Number(trimmed);
    if (cap !== null && !Number.isInteger(cap)) {
      setError(PER_MINUTE_RANGE_HINT);
      setPending(null);
      return;
    }
    try {
      // 0 or 7+ is sent as-is: the backend refuses it and its exact message is shown, never clamped.
      const data = await apiRequest(`/api/campaigns/${campaign.id}/pacing`, {
        body: { perMinuteCap: cap },
      });
      setSaved(`Saved: ${perMinuteSummary(data.perMinuteCap)}.`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the per-minute limit.");
    } finally {
      setPending(null);
    }
  }

  const scheduledFuture =
    campaign.scheduledAt !== null && new Date(campaign.scheduledAt).getTime() > Date.now();
  const scheduleMissed =
    campaign.scheduledAt !== null &&
    campaign.status === "approved" &&
    new Date(campaign.scheduledAt).getTime() <= Date.now();
  const skips = campaign.journal.filter(
    (entry) => entry.level === "item_skipped" || entry.level === "auto_start_held",
  );

  return (
    <div className="border-b border-line px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-13 font-bold text-ink">{campaign.name}</span>
            <StatusBadge status={campaign.status} />
            {campaign.perMinuteCap === null && (
              <span className="badge border-line bg-white text-muted">{NO_PER_MINUTE_LABEL}</span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-12 text-faint">
            <span>Created {relativeTime(campaign.createdAt)}</span>
            <span>{campaign.accountEmail}</span>
            <span className="inline-flex items-center gap-1">
              <CalendarClock size={11} />
              {campaign.scheduledAt
                ? `Scheduled for ${formatDateTime(campaign.scheduledAt, timezone)}`
                : "Not scheduled — starts on your Start"}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {campaign.status === "approved" && campaign.scheduledAt === null && (
            <button
              type="button"
              className="btn-primary btn-xs"
              onClick={start}
              disabled={!!pending}
            >
              {pending === "start" ? <LoaderCircle size={10} className="spin" /> : <Play size={10} />}
              Start
            </button>
          )}
          {campaign.status === "active" && (
            <button
              type="button"
              className="btn-secondary btn-xs"
              onClick={() => changeStatus("paused")}
              disabled={!!pending}
            >
              <Pause size={10} /> Pause
            </button>
          )}
          {campaign.status === "paused" && (
            <button
              type="button"
              className="btn-primary btn-xs"
              onClick={() => changeStatus("active")}
              disabled={!!pending}
            >
              {pending === "active" ? <LoaderCircle size={10} className="spin" /> : <Play size={10} />}
              Resume
            </button>
          )}
          {["approved", "active", "paused"].includes(campaign.status) && (
            <button
              type="button"
              className="btn-ghost btn-xs"
              onClick={() => changeStatus("cancelled")}
              disabled={!!pending}
            >
              <Square size={9} /> Cancel
            </button>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-12">
        <span className="text-ink">
          <strong className="font-bold">{campaign.sent}</strong> sent
        </span>
        <span className="text-muted">
          <strong className="font-semibold text-ink">{campaign.failed}</strong> failed
        </span>
        <span className="text-muted">
          <strong className="font-semibold text-ink">{campaign.skipped}</strong> skipped
        </span>
        <span className="text-muted">
          <strong className="font-semibold text-ink">{campaign.queued}</strong> queued
        </span>
        <span className="text-faint">of {campaign.total} selected</span>
      </div>

      {scheduleMissed && (
        <div className="mt-2 inline-flex items-center gap-1 text-12 font-semibold text-amber">
          <CircleAlert size={11} /> Its scheduled time has passed and it has not started — press Start.
        </div>
      )}
      {campaign.status === "paused" && campaign.lastError && (
        <div className="mt-2 rounded-lg border border-rust/20 bg-rust/[0.05] px-2.5 py-1.5 text-12 leading-4 text-rust">
          <span className="font-semibold">Paused: </span>
          {campaign.lastError}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <PerMinuteControl
          value={perMinute}
          onChange={setPerMinute}
          summary={perMinuteSummary(
            perMinute.trim() === "" ? null : Number(perMinute) || campaign.perMinuteCap,
          )}
          disabled={!!pending}
          id={`per-minute-${campaign.id}`}
        />
        <button type="button" className="btn-secondary btn-sm mb-5" onClick={savePacing} disabled={!!pending}>
          {pending === "pacing" ? <LoaderCircle size={12} className="spin" /> : <Send size={12} />}
          Save limit
        </button>
        {saved && <span className="mb-5 text-12 text-forest">{saved}</span>}
      </div>
      {error && <div className="mt-1 text-12 leading-5 text-rust">{error}</div>}

      {skips.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-12 font-semibold text-muted">
            {skips.length} {skips.length === 1 ? "item" : "items"} skipped or held — see why
          </summary>
          <CampaignJournalList entries={skips} />
        </details>
      )}
      {campaign.status === "completed" && campaign.journal.some((e) => e.level === "completed") && (
        <div className="mt-2 text-12 text-faint">
          {campaign.journal.filter((e) => e.level === "completed").slice(-1)[0].reason}
        </div>
      )}
    </div>
  );
}

/** The campaign list: every campaign with its counts, controls, error and named skips. */
export function CampaignList({ campaigns }: { campaigns: CampaignSummary[] }) {
  if (!campaigns.length) {
    return (
      <Notice tone="info" title="No campaigns yet.">
        Build one above from the filters you choose. Nothing sends until you approve a batch.
      </Notice>
    );
  }
  return (
    <Card className="p-0">
      <div className="px-5 pt-5">
        <SectionHeading
          title="Campaigns"
          description="A campaign works through its whole selection automatically. A single failure is skipped and named; only a system failure (or three in a row) pauses it."
        />
      </div>
      <div className="mt-3">
        {campaigns.map((campaign) => (
          <CampaignRow key={campaign.id} campaign={campaign} />
        ))}
      </div>
    </Card>
  );
}
