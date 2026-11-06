"use client";

import { useState, type DragEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { apiRequest } from "./client-ui";
import { cn } from "@/lib/cn";

/**
 * Client parts of the pipeline board and analytics (email item 5). Moves go through the audited
 * stage endpoint only — Demo, Commercial (proposal), Won and Lost are the founder's decisions; the
 * automatic columns accept no drops. Nothing here sends anything.
 */

type Params = Record<string, string | undefined>;

function withParams(path: string, base: Params, change: Params): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...base, ...change })) {
    if (value) next.set(key, value);
  }
  const query = next.toString();
  return `${path}${query ? `?${query}` : ""}`;
}

/** Selects that apply the moment they change. */
export function AutoFilters({
  path,
  base,
  selects,
}: {
  path: string;
  base: Params;
  selects: { name: string; label: string; options: { value: string; label: string }[]; disabled?: boolean; note?: string }[];
}) {
  const router = useRouter();
  return (
    <div className="flex flex-wrap items-center gap-2" data-auto-filters>
      {selects.map((select) => (
        <select
          key={select.name}
          aria-label={select.label}
          title={select.note}
          disabled={select.disabled}
          value={base[select.name] ?? ""}
          onChange={(event) => router.push(withParams(path, base, { [select.name]: event.target.value || undefined }))}
          className="select h-8 w-auto min-w-[140px] text-12 disabled:opacity-60"
          data-filter={select.name}
        >
          {select.options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ))}
    </div>
  );
}

const MOVES = [

  { stage: "demo", label: "Demo" },
  { stage: "proposal", label: "Commercial" },
  { stage: "won", label: "Won" },
  { stage: "lost", label: "Lost" },
] as const;

async function moveLead(prospectId: string, stage: string, via: "board_click" | "board_drag") {
  if (stage === "lost" && !window.confirm("Mark this lead as lost? Its follow-ups stop.")) return false;
  await apiRequest(`/api/leads/${prospectId}/stage`, { body: { stage, via } });
  return true;
}

/** One-click move from a card: a small "Move to…" menu. */
export function CardMove({ prospectId, status }: { prospectId: string; status: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <select
        aria-label="Move to"
        value=""
        disabled={pending}
        onChange={async (event) => {
          const stage = event.target.value;
          if (!stage) return;
          setPending(true);
          setError(null);
          try {
            if (await moveLead(prospectId, stage, "board_click")) router.refresh();
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : "Could not move.");
          } finally {
            setPending(false);
          }
        }}
        className="h-7 w-[104px] min-w-0 shrink-0 rounded-md border border-line bg-white px-1.5 text-12 text-muted"
        data-card-move={prospectId}
      >
        <option value="">{pending ? "Moving…" : "Move to…"}</option>
        {MOVES.filter((move) => move.stage !== status).map((move) => (
          <option key={move.stage} value={move.stage}>{move.label}</option>
        ))}
      </select>
      {error && <p className="mt-1 text-12 text-rust" role="alert">{error}</p>}
    </div>
  );
}

export function DraggableCard({ prospectId, children }: { prospectId: string; children: ReactNode }) {
  return (
    <div
      draggable
      onDragStart={(event: DragEvent) => {
        event.dataTransfer.setData("text/x-prospect", prospectId);
        event.dataTransfer.effectAllowed = "move";
      }}
      className="cursor-grab active:cursor-grabbing"
      data-draggable-card={prospectId}
    >
      {children}
    </div>
  );
}

/** A column body. Founder columns (with a stage) accept a dropped card; automatic ones do not. */
export function DropColumn({ stage, children }: { stage?: string; children: ReactNode }) {
  const router = useRouter();
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div
      onDragOver={(event) => {
        if (!stage) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (event) => {
        setOver(false);
        if (!stage) return;
        event.preventDefault();
        const prospectId = event.dataTransfer.getData("text/x-prospect");
        if (!prospectId) return;
        setError(null);
        try {
          if (await moveLead(prospectId, stage, "board_drag")) router.refresh();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : "Could not move.");
        }
      }}
      className={cn("min-h-[120px] space-y-2 rounded-lg p-1.5 transition", over && "bg-lime/20 ring-2 ring-forest/30")}
      data-drop-column={stage ?? "automatic"}
    >
      {error && <p className="text-12 text-rust" role="alert">{error}</p>}
      {children}
    </div>
  );
}
