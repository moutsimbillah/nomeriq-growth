"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Ban,
  CheckCircle2,
  CircleDollarSign,
  FileText,
  Globe,
  LoaderCircle,
  Pause,
  Play,
  Radar,
  Search,
  ShieldCheck,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { apiRequest, InlineError } from "./client-ui";

type Tone = "neutral" | "progress" | "good" | "warn" | "bad";

interface ActivityItem {
  id: string;
  at: string;
  kind:
    | "job"
    | "run"
    | "plan"
    | "search"
    | "found"
    | "fetch"
    | "verdict"
    | "lead"
    | "draft"
    | "duplicate"
    | "rejected"
    | "failed"
    | "spend"
    | "note";
  tone: Tone;
  title: string;
  detail: string | null;
  costUsd: number | null;
  businessName: string | null;
}

function toneClasses(tone: Tone): string {
  if (tone === "good") return "border-forest/25 bg-lime/25 text-forest";
  if (tone === "progress") return "border-forest/20 bg-forest/[0.06] text-forest";
  if (tone === "warn") return "border-amber/30 bg-amber/10 text-amber";
  if (tone === "bad") return "border-rust/30 bg-rust/[0.07] text-rust";
  return "border-line bg-paper text-muted";
}

function KindIcon({ kind }: { kind: ActivityItem["kind"] }) {
  const size = 10;
  if (kind === "search") return <Search size={size} />;
  if (kind === "found") return <Radar size={size} />;
  if (kind === "fetch") return <Globe size={size} />;
  if (kind === "verdict") return <FileText size={size} />;
  if (kind === "lead") return <CheckCircle2 size={size} />;
  if (kind === "draft") return <FileText size={size} />;
  if (kind === "duplicate") return <ShieldCheck size={size} />;
  if (kind === "rejected") return <Ban size={size} />;
  if (kind === "failed") return <XCircle size={size} />;
  if (kind === "spend") return <CircleDollarSign size={size} />;
  if (kind === "job") return <Play size={size} />;
  if (kind === "run") return <LoaderCircle size={size} />;
  return <TriangleAlert size={size} />;
}

function clockTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * The live transcript of one research job.
 *
 * The founder sees the engine's real steps appear as they are persisted —
 * searches, pages read, verdicts, rejections and drafts. Nothing here is
 * simulated: if a line is missing, that step has not happened.
 */
export function ResearchActivityFeed({
  jobId,
  active,
  onBudgetChange,
}: {
  jobId: string;
  active: boolean;
  onBudgetChange?: () => void;
}) {  const [items, setItems] = useState<ActivityItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  // Held in a ref so an inline arrow from the parent cannot make `load` unstable
  // and drive a fetch loop.
  const onBudgetChangeRef = useRef(onBudgetChange);
  useEffect(() => {
    onBudgetChangeRef.current = onBudgetChange;
  }, [onBudgetChange]);

  const load = useCallback(async () => {
    try {
      const data = (await apiRequest(
        `/api/research/${jobId}/activity?limit=80`,
        { method: "GET" },
      )) as { items: ActivityItem[] };
      setItems(Array.isArray(data.items) ? data.items : []);
      setError(null);
      onBudgetChangeRef.current?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load activity.");
    } finally {
      setLoaded(true);
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll faster while the engine is actually working, so lines land as they
  // happen; fall back to a slow poll so a finished job still updates.
  useEffect(() => {
    const timer = window.setInterval(() => void load(), active ? 2000 : 15000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  // Follow the newest line unless the founder has scrolled up to read history.
  useEffect(() => {
    const node = scroller.current;
    if (!node || !stickToBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [items]);

  return (
    <div className="mt-4 rounded-xl border border-line bg-paper/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.12em] text-faint">
          <Radar size={11} /> Live activity
        </div>
        {active && (
          <span className="inline-flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#a8d846]" />
            working
          </span>
        )}
      </div>

      <div
        ref={scroller}
        onScroll={(event) => {
          const node = event.currentTarget;
          stickToBottom.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 40;
        }}
        className="mt-2.5 max-h-[320px] space-y-1.5 overflow-y-auto pr-1"
      >
        {!loaded ? (
          <p className="py-3 text-[10.5px] text-faint">Loading activity…</p>
        ) : items.length === 0 ? (
          <p className="py-3 text-[10.5px] leading-5 text-muted">
            {active
              ? "Waiting for the first step… the engine records each search, page read and verdict here as it happens."
              : "No activity recorded for this target yet."}
          </p>
        ) : (
          [...items].reverse().map((item) => (
            <div key={item.id} className="flex gap-2.5">
              <span
                className={`mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border ${toneClasses(item.tone)}`}
              >
                <KindIcon kind={item.kind} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 break-words text-[11px] font-medium leading-4 text-ink">
                    {item.title}
                  </span>
                  {item.costUsd ? (
                    <span className="shrink-0 font-mono text-[9px] text-faint">
                      ${item.costUsd.toFixed(4)}
                    </span>
                  ) : null}
                  <span className="shrink-0 font-mono text-[9px] text-faint">
                    {clockTime(item.at)}
                  </span>
                </div>
                {item.detail && (
                  <p className="mt-0.5 break-words text-[10px] leading-4 text-muted">
                    {item.detail}
                  </p>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <InlineError>{error}</InlineError>

      <p className="mt-2.5 border-t border-line pt-2 text-[9.5px] leading-4 text-faint">
        Recorded as it happens. A step only appears once the database has accepted
        it — nothing is streamed ahead of the real work.
      </p>
    </div>
  );
}

/**
 * Advances an active job from the open tab.
 *
 * The durable driver is the cron route, but a deployment (or a local run) with no
 * scheduler would otherwise sit on an active job and do nothing at all. This pump
 * closes that gap: while the panel is open and the job is active, it runs one
 * bounded tick at a time. The job lease makes it safe — a second tab, or the cron
 * firing at the same moment, is refused rather than double-spending.
 */
export function useResearchPump(input: {
  jobId: string;
  active: boolean;
  enabled: boolean;
  onTick?: (notes: string[]) => void;
  onStop?: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const inFlight = useRef(false);

  // Keep the callbacks in refs. Depending on them directly would restart the
  // interval on every parent render, and depending on the `input` object would
  // loop forever because a fresh object is created each render.
  const onTick = useRef(input.onTick);
  const onStop = useRef(input.onStop);
  useEffect(() => {
    onTick.current = input.onTick;
    onStop.current = input.onStop;
  }, [input.onTick, input.onStop]);

  const { jobId, active, enabled } = input;

  useEffect(() => {
    if (!active || !enabled || paused) return;
    let cancelled = false;

    const step = async () => {
      // Never overlap ticks: one bounded step at a time, per the job lease.
      if (cancelled || inFlight.current) return;
      inFlight.current = true;
      setRunning(true);
      try {
        const data = await apiRequest(`/api/research/${jobId}/engine`, {
          body: { action: "tick", runNow: true },
        });
        if (cancelled) return;
        const notes = (data?.tick?.notes ?? []) as string[];
        onTick.current?.(notes);
        const status = data?.job?.status as string | undefined;
        // Anything other than "still active" means the engine stopped itself:
        // target reached, budget reached, cancelled or failed.
        if (status && status !== "active") onStop.current?.();
      } catch {
        // A failed tick must not spin; the next scheduled attempt retries.
      } finally {
        inFlight.current = false;
        setRunning(false);
      }
    };

    void step();
    // Deliberately unhurried. The production driver is a 5-minute cron, and each
    // step spends real money, so this pump exists to make progress visible and to
    // keep a scheduler-less install working — not to outspend the budget gate.
    const timer = window.setInterval(() => void step(), 6000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [jobId, active, enabled, paused]);

  return { running, paused, setPaused };
}
