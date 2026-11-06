"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, LoaderCircle, Search } from "lucide-react";
import { apiRequest } from "./client-ui";
import { cn } from "@/lib/cn";

/**
 * Client parts of the folder inbox (email item 2). The page itself stays a server component; these
 * only change the URL or call the existing, narrow endpoints — approve-bulk (approval only, never
 * sends) and the audited stage endpoint.
 */

type Base = { folder: string; q?: string; sender?: string; agent?: string };

function inboxHref(base: Base, change: Partial<Base>): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...base, ...change })) {
    if (value) next.set(key, value);
  }
  const query = next.toString();
  return `/email${query ? `?${query}` : ""}`;
}

/** Search on Enter; Sender and Agent apply the moment they change. A new filter clears the open lead. */
export function InboxFilters({
  base,
  senders,
  agents,
}: {
  base: Base;
  senders: { id: string; label: string }[];
  agents: { key: string; label: string }[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState(base.q ?? "");
  const go = (change: Partial<Base>) => router.push(inboxHref(base, change));
  return (
    <div className="space-y-2 border-b border-line p-2.5" data-inbox-filters>
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          go({ q: query.trim() || undefined });
        }}
      >
        <label className="flex items-center gap-2 rounded-lg border border-line bg-white px-2.5 py-1.5">
          <Search size={12} className="text-faint" />
          <input
            name="q"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, domain or email — Enter"
            className="min-w-0 flex-1 bg-transparent text-12 outline-none"
            enterKeyHint="search"
          />
        </label>
      </form>
      <div className="grid grid-cols-2 gap-2">
        <select
          value={base.sender ?? ""}
          onChange={(event) => go({ sender: event.target.value || undefined })}
          className="select h-8 text-12"
          aria-label="Sender"
          data-filter-sender
        >
          <option value="">All senders</option>
          {senders.map((sender) => (
            <option key={sender.id} value={sender.id}>{sender.label}</option>
          ))}
          <option value="none">No sender yet</option>
        </select>
        <select
          value={base.agent ?? ""}
          onChange={(event) => go({ agent: event.target.value || undefined })}
          className="select h-8 text-12"
          aria-label="Agent"
          data-filter-agent
        >
          <option value="">All agents</option>
          {agents.map((agent) => (
            <option key={agent.key} value={agent.key}>{agent.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

/**
 * The To approve folder: a checkbox per row, Select all and Approve selected — the same bulk
 * approval as the Follow-ups tab. Approving never sends; approved drafts go out through a campaign.
 */
export function ApproveSelectionList({
  items,
}: {
  items: { prospectId: string; draftId: string | null; approvable: boolean; row: ReactNode }[];
}) {
  const router = useRouter();
  const approvable = items.filter((item) => item.approvable && item.draftId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const allSelected = approvable.length > 0 && approvable.every((item) => selected.has(item.draftId!));

  function toggle(draftId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(draftId)) next.delete(draftId);
      else next.add(draftId);
      return next;
    });
  }

  async function approve() {
    const ids = [...selected];
    if (!ids.length) return;
    setPending(true);
    setMessage(null);
    setError(null);
    try {
      const result = await apiRequest("/api/drafts/approve-bulk", { body: { draftIds: ids.slice(0, 100) } });
      const refused = result.refused as { id: string; reason: string }[];
      setMessage(
        `${result.approved.length} approved. Nothing was sent.` +
          (refused.length ? ` ${refused.length} not approved: ${refused.map((r) => r.reason).join(" ")}` : ""),
      );
      setSelected(new Set());
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not approve.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div data-approve-list>
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-paper/40 px-3 py-2">
        <label className="flex items-center gap-1.5 text-12 font-semibold text-ink">
          <input
            type="checkbox"
            checked={allSelected}
            disabled={approvable.length === 0 || pending}
            onChange={() =>
              setSelected(allSelected ? new Set() : new Set(approvable.map((item) => item.draftId!)))
            }
            data-select-all
          />
          Select all
        </label>
        <button
          type="button"
          className="btn-secondary btn-xs"
          disabled={pending || selected.size === 0}
          onClick={approve}
          data-approve-selected
        >
          {pending ? <LoaderCircle size={11} className="spin" /> : <CheckCheck size={11} />}
          Approve selected{selected.size ? ` (${selected.size})` : ""}
        </button>
        <span className="text-12 text-faint">Approving never sends.</span>
      </div>
      {message && <p className="px-3 pt-2 text-12 text-muted" role="status" data-bulk-message>{message}</p>}
      {error && <p className="px-3 pt-2 text-12 text-rust" role="alert">{error}</p>}
      <ul className="divide-y divide-line" data-lead-list>
        {items.map((item) => (
          <li key={item.prospectId} className="flex items-stretch">
            <div className="flex w-8 shrink-0 items-start justify-center pt-3">
              {item.approvable && item.draftId ? (
                <input
                  type="checkbox"
                  aria-label="Select this draft"
                  checked={selected.has(item.draftId)}
                  disabled={pending}
                  onChange={() => toggle(item.draftId!)}
                  data-approve-check={item.draftId}
                />
              ) : (
                <span className="text-12 text-forest" title="Already approved">✓</span>
              )}
            </div>
            <div className="min-w-0 flex-1">{item.row}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const STAGES = [
  { value: "interested", label: "Interested" },
  { value: "demo", label: "Demo" },
  { value: "proposal", label: "Proposal" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
] as const;

/** One click sets the stage; every change is audited. Mirrors FOUNDER_STAGES in services/stage. */
export function StageButtons({ prospectId, status }: { prospectId: string; status: string }) {
  const router = useRouter();
  const [current, setCurrent] = useState(status);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function move(stage: string) {
    if (stage === current) return;
    if (stage === "lost" && !window.confirm("Mark this lead as lost? Its follow-ups stop.")) return;
    setPending(stage);
    setError(null);
    try {
      await apiRequest(`/api/leads/${prospectId}/stage`, { body: { stage } });
      setCurrent(stage);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change the stage.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div data-stage-buttons>
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-12 font-semibold text-muted">Set stage</span>
        {STAGES.map((stage) => (
          <button
            key={stage.value}
            type="button"
            onClick={() => move(stage.value)}
            disabled={pending !== null}
            aria-pressed={current === stage.value}
            data-stage-button={stage.value}
            className={cn(
              "rounded-full border px-2.5 py-1 text-12 font-semibold transition",
              current === stage.value
                ? "border-forest bg-forest text-lime"
                : stage.value === "lost"
                  ? "border-line bg-white text-muted hover:border-rust/40 hover:text-rust"
                  : "border-line bg-white text-ink hover:border-forest/40",
            )}
          >
            {pending === stage.value ? <LoaderCircle size={10} className="spin inline" /> : stage.label}
          </button>
        ))}
      </div>
      {error && <p className="mt-1 text-12 text-rust" role="alert">{error}</p>}
    </div>
  );
}
