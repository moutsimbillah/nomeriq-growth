"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, CheckCheck, LoaderCircle, Sparkles } from "lucide-react";
import { apiRequest } from "./client-ui";
import { FollowUpReview } from "./email-actions";
import { draftProvenance } from "@/lib/ai/provenance";
import { truncate } from "@/lib/utils";
import type { Draft } from "@/lib/types";

/** Mirrors FOLLOW_UP_BATCH_MAX in the follow-up service (kept here so this file stays browser-safe). */
const BATCH_MAX = 50;

export interface EligibleFollowUp {
  conversationId: string;
  prospectId: string;
  businessName: string;
  daysSinceLastOutbound: number;
  nextSequence: number;
}

function Message({ text, tone }: { text: string | null; tone: "muted" | "error" }) {
  if (!text) return null;
  return (
    <p className={`text-12 ${tone === "error" ? "text-rust" : "text-muted"}`} role="status" data-bulk-message>
      {text}
    </p>
  );
}

/**
 * "Eligible but not yet prepared": tick rows and Prepare selected, or Prepare next N (newest contacts
 * first). Preparing only writes drafts for review; nothing is sent. Works with "Automatic follow-ups"
 * off — that switch is for the scheduled job — and stays within "Follow-ups per day".
 */
export function FollowUpEligibleList({
  candidates,
  dailyLimit,
}: {
  candidates: EligibleFollowUp[];
  dailyLimit: number;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState(Math.min(10, BATCH_MAX));
  const [pending, setPending] = useState<"selected" | "next" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allSelected = candidates.length > 0 && selected.size === candidates.length;

  function toggle(prospectId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(prospectId)) next.delete(prospectId);
      else next.add(prospectId);
      return next;
    });
  }

  async function prepare(kind: "selected" | "next") {
    setPending(kind);
    setMessage(null);
    setError(null);
    try {
      const body = kind === "selected"
        ? { prospectIds: [...selected].slice(0, BATCH_MAX) }
        : { limit: Math.max(1, Math.min(BATCH_MAX, Math.floor(batch) || 1)) };
      const result = await apiRequest("/api/followups/prepare", { body });
      setMessage(
        result.prepared
          ? `${result.prepared} follow-up draft${result.prepared === 1 ? "" : "s"} prepared for your review below. Nothing was sent.`
          : result.reason || "Nothing was prepared.",
      );
      setSelected(new Set());
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not prepare.");
    } finally {
      setPending(null);
    }
  }

  if (candidates.length === 0) {
    return <p className="mt-3 text-12 text-faint">Nothing is due.</p>;
  }

  return (
    <div className="mt-3 space-y-3" data-follow-up-eligible>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-paper/40 px-3 py-2">
        <label className="flex items-center gap-2 text-12 font-semibold text-ink">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => setSelected(allSelected ? new Set() : new Set(candidates.map((c) => c.prospectId)))}
            data-select-all
          />
          Select all ({candidates.length})
        </label>
        <button
          type="button"
          className="btn-secondary btn-xs"
          disabled={pending !== null || selected.size === 0}
          onClick={() => prepare("selected")}
          data-prepare-selected
        >
          {pending === "selected" ? <LoaderCircle size={11} className="spin" /> : <Sparkles size={11} />}
          Prepare selected{selected.size ? ` (${Math.min(selected.size, BATCH_MAX)})` : ""}
        </button>
        <span className="mx-1 hidden h-4 w-px bg-line sm:inline-block" />
        <label className="flex items-center gap-1.5 text-12 text-muted" htmlFor="follow-up-batch">
          Prepare next
          <input
            id="follow-up-batch"
            type="number"
            min={1}
            max={BATCH_MAX}
            className="input h-7 w-16 px-2 py-0 text-12"
            value={batch}
            onChange={(event) => setBatch(Number(event.target.value))}
          />
        </label>
        <button
          type="button"
          className="btn-secondary btn-xs"
          disabled={pending !== null}
          onClick={() => prepare("next")}
          data-prepare-next
        >
          {pending === "next" ? <LoaderCircle size={11} className="spin" /> : <Sparkles size={11} />}
          Prepare next {Math.max(1, Math.min(BATCH_MAX, Math.floor(batch) || 1))}
        </button>
      </div>
      <p className="text-12 text-faint">
        Newest contacts first. At most {dailyLimit} a day (Settings → Follow-ups per day). Drafts go to
        the review list below; nothing is sent.
      </p>
      <Message text={message} tone="muted" />
      <Message text={error} tone="error" />
      <div className="grid gap-2 sm:grid-cols-2">
        {candidates.map((candidate) => (
          <label
            key={candidate.conversationId}
            className="flex cursor-pointer items-center gap-3 rounded-lg border border-line bg-paper/40 px-3 py-2.5"
          >
            <input
              type="checkbox"
              checked={selected.has(candidate.prospectId)}
              onChange={() => toggle(candidate.prospectId)}
              data-eligible-row
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-12 font-semibold text-ink">{candidate.businessName}</div>
              <div className="text-12 text-faint">
                {candidate.daysSinceLastOutbound} days since contact · next #{candidate.nextSequence}
              </div>
            </div>
            <Link href={`/email/${candidate.conversationId}`} className="btn-ghost btn-xs">
              Thread <ArrowRight size={10} />
            </Link>
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * The prepared follow-ups: review one by one as before, or tick and Approve selected / Approve all
 * ready. Approving never sends; approved drafts go out only through a campaign the founder starts,
 * within each sending profile's daily limit.
 */
export function FollowUpDraftList({ drafts, sandbox }: { drafts: Draft[]; sandbox: boolean }) {
  const router = useRouter();
  const ready = drafts.filter((draft) => draft.status === "draft");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<"selected" | "all" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function approve(kind: "selected" | "all") {
    const ids = kind === "all" ? ready.map((draft) => draft.id) : [...selected];
    if (!ids.length) return;
    setPending(kind);
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
      setPending(null);
    }
  }

  return (
    <div className="mt-4 space-y-2" data-follow-up-drafts>
      {ready.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-paper/40 px-3 py-2">
          <button
            type="button"
            className="btn-secondary btn-xs"
            disabled={pending !== null || selected.size === 0}
            onClick={() => approve("selected")}
            data-approve-selected
          >
            {pending === "selected" ? <LoaderCircle size={11} className="spin" /> : <CheckCheck size={11} />}
            Approve selected{selected.size ? ` (${selected.size})` : ""}
          </button>
          <button
            type="button"
            className="btn-secondary btn-xs"
            disabled={pending !== null}
            onClick={() => approve("all")}
            data-approve-all
          >
            {pending === "all" ? <LoaderCircle size={11} className="spin" /> : <CheckCheck size={11} />}
            Approve all ready ({ready.length})
          </button>
          <span className="text-12 text-faint">Approving does not send. Send approved drafts with a campaign.</span>
        </div>
      )}
      <Message text={message} tone="muted" />
      <Message text={error} tone="error" />
      {drafts.map((draft) => (
        <div
          key={draft.id}
          className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-white/50 px-3.5 py-3"
        >
          {draft.status === "draft" ? (
            <input
              type="checkbox"
              aria-label={`Select the follow-up for ${draft.prospectName}`}
              checked={selected.has(draft.id)}
              onChange={() => toggle(draft.id)}
              data-draft-row
            />
          ) : (
            <span className="w-[13px]" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-12 font-semibold text-ink">{draft.prospectName}</span>
              <span className="badge">#{draft.sequence}</span>
              <span className="badge capitalize">{draft.status}</span>
            </div>
            <div className="mt-0.5 truncate text-12 text-muted">
              {draft.subject} · {truncate(draft.body.replace(/\n+/g, " "), 130)}
            </div>
            <div className="mt-0.5 text-12 text-faint" data-draft-provenance>
              {draftProvenance(draft)}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <FollowUpReview draft={draft} sandbox={sandbox} />
            <Link href={`/leads/${draft.prospectId}`} className="btn-ghost btn-xs">
              Lead <ArrowRight size={10} />
            </Link>
          </div>
        </div>
      ))}
    </div>
  );
}
