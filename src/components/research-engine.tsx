"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  Ban,
  CircleDollarSign,
  Gauge,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Zap,
} from "lucide-react";
import type { ResearchJob } from "@/lib/types";
import { apiRequest, InlineError } from "./client-ui";
import { Notice, ProgressBar } from "./ui";
import { ResearchActivityFeed, useResearchPump } from "./research-activity";

interface EngineSnapshot {
  job: ResearchJob;
  budget: {
    budgetUsd: number;
    spentUsd: number;
    remainingUsd: number;
    exhausted: boolean;
  } | null;
  usage: {
    costUsd: number;
    searches: number;
    fetches: number;
    modelCalls: number;
    requests: number;
    recent: {
      operation: string;
      model: string | null;
      costUsd: number;
      status: string;
      createdAt: string | null;
    }[];
  } | null;
}

type EngineAction = "start" | "pause" | "resume" | "cancel" | "tick";

function money(value: number): string {
  return `$${value.toFixed(4)}`;
}

function statusTone(status: string): string {
  if (status === "active") return "border-forest/25 bg-lime/25 text-forest";
  if (status === "completed") return "border-forest/25 bg-forest/10 text-forest";
  if (status === "budget_paused" || status === "paused")
    return "border-amber/30 bg-amber/10 text-amber";
  if (status === "failed") return "border-rust/25 bg-rust/[0.06] text-rust";
  return "border-line bg-paper text-muted";
}

/**
 * Founder control for the autonomous DeepSeek engine.
 *
 * All state shown here is read back from the server after every action, so the
 * display can never drift from the database. Progress is real: nothing is
 * animated or estimated.
 */
export function ResearchEnginePanel({
  job,
  configured,
  onRefreshJobs,
}: {
  job: ResearchJob;
  configured: boolean;
  onRefreshJobs?: () => void;
}) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  const [pending, setPending] = useState<EngineAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [live, setLive] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = (await apiRequest(`/api/research/${job.id}/engine`, {
        method: "GET",
      })) as EngineSnapshot;
      setSnapshot(data);
    } catch {
      // A transient poll failure must not blank the panel.
    }
  }, [job.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const isActiveNow = (snapshot?.job.status ?? job.status) === "active";

  // Advance the job while a founder is watching it. The cron route is the durable
  // driver, but without a scheduler (a local run, or a deployment whose cron is
  // not firing) an active job would otherwise sit still and look broken.
  const pump = useResearchPump({
    jobId: job.id,
    active: isActiveNow,
    enabled: configured,
    onTick: (notes) => {
      if (notes.length) setNotes(notes);
    },
    onStop: () => {
      void load();
      onRefreshJobs?.();
      router.refresh();
    },
  });

  // Poll only while the job is running, so an idle page makes no requests.
  useEffect(() => {
    const current = snapshot?.job.status ?? job.status;
    if (current !== "active") {
      setLive(false);
      return;
    }
    setLive(true);
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [snapshot?.job.status, job.status, load]);

  async function act(action: EngineAction) {
    setPending(action);
    setError(null);
    setNotes([]);
    try {
      const data = await apiRequest(`/api/research/${job.id}/engine`, {
        body: { action, runNow: action !== "pause" && action !== "cancel" },
      });
      if (data?.tick?.notes?.length) setNotes(data.tick.notes as string[]);
      setSnapshot({ job: data.job, budget: data.budget, usage: data.usage });
      onRefreshJobs?.();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action failed.");
    } finally {
      setPending(null);
    }
  }

  const current = snapshot?.job ?? job;
  const budget = snapshot?.budget ?? {
    budgetUsd: job.budgetUsd,
    spentUsd: job.spentUsd,
    remainingUsd: Math.max(0, job.budgetUsd - job.spentUsd),
    exhausted: job.spentUsd >= job.budgetUsd - 1e-9,
  };
  const isActive = current.status === "active";
  const isTerminal = current.status === "completed" || current.status === "cancelled";
  const canStart = !isActive && !isTerminal && configured;

  return (
    <div className="rounded-2xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-forest/20 bg-forest/[0.05] px-2.5 py-1 text-12 font-bold uppercase tracking-[0.12em] text-forest">
              <Sparkles size={10} /> DeepSeek engine
            </span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-12 font-bold uppercase tracking-[0.12em] ${statusTone(current.status)}`}
            >
              {current.status.replace(/_/g, " ")}
            </span>
            {live && (
              <span className="inline-flex items-center gap-1.5 text-12 font-semibold uppercase tracking-[0.12em] text-muted">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#a8d846]" />
                live
              </span>
            )}
            {isActive && pump.running && !pump.paused && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-forest/20 bg-forest/[0.05] px-2 py-0.5 text-12 font-bold uppercase tracking-[0.1em] text-forest">
                <LoaderCircle size={9} className="spin" />
                driving from this tab
              </span>
            )}
            {isActive && pump.paused && (
              <button
                type="button"
                onClick={() => pump.setPaused(false)}
                className="inline-flex items-center gap-1.5 rounded-full border border-amber/30 bg-amber/10 px-2 py-0.5 text-12 font-bold uppercase tracking-[0.1em] text-amber"
              >
                <Play size={9} />
                this tab is not driving — resume
              </button>
            )}
          </div>
          <h3 className="mt-2.5 text-16 font-bold tracking-[-0.015em] text-ink">
            Autonomous discovery
          </h3>
          <p className="mt-1 max-w-xl text-12 leading-5 text-muted">
            Runs on the server without an open browser or chat session. Every step
            is persisted, so a restart resumes instead of starting over.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isActive ? (
            <button
              type="button"
              onClick={() => act("pause")}
              disabled={pending !== null}
              className="btn-secondary btn-sm"
            >
              {pending === "pause" ? <LoaderCircle size={13} className="spin" /> : <Pause size={13} />}
              Pause
            </button>
          ) : (
            <button
              type="button"
              onClick={() => act(current.status === "budget_paused" ? "resume" : "start")}
              disabled={pending !== null || !canStart}
              title={!configured ? "Add a DeepSeek API key first" : undefined}
              className="btn-primary btn-sm"
            >
              {pending === "start" || pending === "resume" ? (
                <LoaderCircle size={13} className="spin" />
              ) : (
                <Play size={13} />
              )}
              {current.status === "paused" || current.status === "budget_paused"
                ? "Resume"
                : "Start research"}
            </button>
          )}
          <button
            type="button"
            onClick={() => act("tick")}
            disabled={pending !== null || !isActive}
            className="btn-ghost btn-sm"
            title="Run one bounded step now"
          >
            {pending === "tick" ? <LoaderCircle size={13} className="spin" /> : <Zap size={13} />}
            Step
          </button>
          {!isTerminal && (
            <button
              type="button"
              onClick={() => act("cancel")}
              disabled={pending !== null}
              className="btn-ghost btn-sm text-rust"
            >
              {pending === "cancel" ? <LoaderCircle size={13} className="spin" /> : <Ban size={13} />}
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={() => void load()}
            className="btn-ghost btn-sm"
            aria-label="Refresh engine status"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {!configured && (
        <div className="mt-4">
          <Notice tone="warning" title="DeepSeek is not configured.">
            Autonomous research needs a DeepSeek API key. Add one under{" "}
            <span className="font-semibold">Settings → AI integrations</span>, then
            start the job. Nothing will be researched or spent until then.
          </Notice>
        </div>
      )}

      <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
        {[
          { label: "Verified", value: current.verifiedCount, icon: Gauge },
          { label: "Candidates", value: current.candidatesDiscovered, icon: Search },
          { label: "Duplicates", value: current.duplicatesRejected, icon: Ban },
          { label: "Failed checks", value: current.failedVerifications, icon: RefreshCw },
        ].map((item) => (
          <div key={item.label}>
            <div className="flex items-center gap-1.5">
              <item.icon size={11} className="text-faint" />
              <span className="text-12 font-bold uppercase tracking-[0.12em] text-faint">
                {item.label}
              </span>
            </div>
            <div className="mt-1.5 text-20 font-bold leading-none text-ink">
              {item.value}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5">
        <ProgressBar value={current.verifiedCount} max={current.targetCount} />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-12 text-faint">
          <span>
            {current.verifiedCount} of {current.targetCount} verified ·{" "}
            {current.candidatesPending} pending · {current.candidatesQualified} qualified
          </span>
          <span>{current.remaining} remaining</span>
        </div>
      </div>

      <ResearchActivityFeed
        jobId={job.id}
        active={isActive}
        onBudgetChange={() => void load()}
      />

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-line bg-paper/60 p-3">
          <div className="flex items-center gap-1.5 text-12 font-bold uppercase tracking-[0.12em] text-faint">
            <CircleDollarSign size={11} /> DeepSeek spend
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-20 leading-none text-ink">
              {money(budget.spentUsd)}
            </span>
            <span className="text-12 text-faint">
              of ${budget.budgetUsd.toFixed(2)} budget
            </span>
          </div>
          <div className="mt-2">
            <ProgressBar
              value={budget.spentUsd}
              max={budget.budgetUsd}
              tone={budget.exhausted ? "amber" : "lime"}
            />
          </div>
          <p className="mt-2 text-12 leading-4 text-faint">
            {budget.exhausted
              ? "Budget exhausted. Progress is preserved; raise the budget to continue."
              : `${money(budget.remainingUsd)} remaining. Cost is recorded per real API operation.`}
          </p>
        </div>

        <div className="rounded-xl border border-line bg-paper/60 p-3">
          <div className="text-12 font-bold uppercase tracking-[0.12em] text-faint">
            Recorded operations
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {[
              ["Searches", snapshot?.usage?.searches ?? current.searchQueriesUsed],
              ["Fetches", snapshot?.usage?.fetches ?? 0],
              ["Model calls", snapshot?.usage?.modelCalls ?? 0],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <div className="text-16 font-bold leading-none text-ink">
                  {value as number}
                </div>
                <div className="mt-1 text-12 font-bold uppercase tracking-[0.1em] text-faint">
                  {label}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-12 leading-4 text-faint">
            Search and Fetch bill per successful request. Model cost is token-based.
          </p>
        </div>
      </div>

      {current.stopReason && (
        <div className="mt-4 rounded-xl border border-line bg-white/50 p-3">
          <div className="text-12 font-bold uppercase tracking-[0.12em] text-faint">
            Why it stopped
          </div>
          <p className="mt-1.5 text-12 leading-5 text-muted">{current.stopReason}</p>
        </div>
      )}

      {notes.length > 0 && (
        <details className="mt-3 rounded-xl border border-line bg-white/50 p-3">
          <summary className="cursor-pointer text-12 font-bold uppercase tracking-[0.12em] text-faint">
            Last step ({notes.length} note{notes.length === 1 ? "" : "s"})
          </summary>
          <ul className="mt-2 space-y-1 text-12 leading-5 text-muted">
            {notes.map((note, index) => (
              <li key={index} className="flex gap-2">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-line-strong" />
                {note}
              </li>
            ))}
          </ul>
        </details>
      )}

      <InlineError>{error}</InlineError>

      {isActive && (
        <p className="mt-3 rounded-xl border border-line bg-white/50 p-3 text-12 leading-4 text-muted">
          {pump.paused ? (
            <>
              This tab has stopped driving the job. Nothing will advance until the
              server cron runs or you resume here.
            </>
          ) : (
            <>
              This tab is advancing the job while it is open, one bounded step at a
              time, and the progress above is written to the database as it happens.
              Closing the page does not lose progress: the scheduled server worker
              continues from exactly this point.{" "}
              <button
                type="button"
                onClick={() => pump.setPaused(true)}
                className="font-semibold text-ink underline decoration-line-strong underline-offset-2"
              >
                Stop driving from this tab
              </button>
            </>
          )}
        </p>
      )}

      <p className="mt-4 text-12 leading-4 text-faint">
        Research jobs only save leads and drafts for founder review. They never send
        email, and no lead is counted without a published contact email and evidence.
      </p>
    </div>
  );
}
