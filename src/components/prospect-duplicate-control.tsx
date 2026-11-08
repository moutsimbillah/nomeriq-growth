"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Copy, RotateCcw } from "lucide-react";
import { apiRequest, InlineError, Modal, SubmitBar } from "./client-ui";

/**
 * The founder's "Duplicate of" controls.
 *
 * `MarkDuplicateButton` sits on an active lead: it warns what marking does, lets the founder pick the
 * lead to keep through a search, and asks for an explicit confirmation. `RestoreDuplicateButton` sits
 * on a lead already marked: it explains that restoring brings the lead back but leaves its cancelled
 * drafts and blocked sends cancelled. Both talk only to `/api/leads/[id]/duplicate`, which is
 * founder-only and refuses anything it cannot do exactly.
 */

interface Candidate {
  id: string;
  businessName: string;
  domainKey: string | null;
  contactEmail: string | null;
  qualificationStatus: string;
  status: string;
}

export const DUPLICATE_MARK_WARNING =
  "Marking this lead as a duplicate archives it, marks it do-not-contact, cancels its unsent drafts and stops queued email. History is kept and no address is suppressed by this action. Existing contact restrictions still apply. Keep the lead with the working conversation; history is not moved. You can restore it later if nothing has changed.";

export const DUPLICATE_RESTORE_NOTE =
  "Restoring brings this lead back into the list with its earlier do-not-contact setting. Drafts and queued emails cancelled when it was marked stay cancelled — nothing is approved, queued or sent automatically.";

export function MarkDuplicateButton({
  prospectId,
  businessName,
}: {
  prospectId: string;
  businessName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const response = await fetch(
          `/api/leads/${prospectId}/duplicate?q=${encodeURIComponent(q)}`,
          { cache: "no-store" },
        );
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) throw new Error(payload?.error || "Search failed.");
        if (!cancelled) setCandidates(payload.data.candidates as Candidate[]);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Search failed.");
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, prospectId]);

  function close() {
    setOpen(false);
    setSelected(null);
    setConfirmed(false);
    setError(null);
  }

  async function mark() {
    if (!selected || !confirmed) return;
    setPending(true);
    setError(null);
    try {
      await apiRequest(`/api/leads/${prospectId}/duplicate`, {
        method: "POST",
        body: { action: "mark", canonicalProspectId: selected.id, confirm: true },
      });
      close();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not mark as duplicate.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn-ghost btn-sm text-faint"
        onClick={() => setOpen(true)}
        data-duplicate-mark
      >
        <Copy size={12} /> Duplicate of…
      </button>
      <Modal
        open={open}
        onClose={close}
        title={`Mark ${businessName} as a duplicate?`}
        description={DUPLICATE_MARK_WARNING}
        width="md"
      >
        <label className="block text-12 font-semibold text-ink" htmlFor="duplicate-canonical-search">
          Lead to keep
        </label>
        <input
          id="duplicate-canonical-search"
          className="input mt-1 w-full"
          placeholder="Search by name, website or email"
          value={query}
          maxLength={100}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(null);
          }}
        />
        <div className="mt-2 max-h-64 space-y-1 overflow-y-auto" role="listbox" aria-label="Leads to keep">
          {searching && <p className="text-12 text-faint">Searching…</p>}
          {!searching && query.trim().length >= 2 && candidates.length === 0 && (
            <p className="text-12 text-faint">No active lead matches.</p>
          )}
          {candidates.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="option"
              aria-selected={selected?.id === candidate.id}
              onClick={() => setSelected(candidate)}
              className={`block w-full min-w-0 rounded-lg border px-3 py-2 text-left text-12 ${
                selected?.id === candidate.id
                  ? "border-forest/40 bg-lime/25"
                  : "border-line bg-white/50 hover:border-line-strong"
              }`}
            >
              <span className="block font-semibold text-ink">{candidate.businessName}</span>
              <span className="wrap-anywhere block text-faint">
                {[candidate.domainKey, candidate.contactEmail, candidate.qualificationStatus, candidate.status]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>
          ))}
        </div>
        <label className="mt-3 flex items-start gap-2 text-12 text-muted">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            disabled={!selected}
          />
          <span>
            {selected
              ? `Yes, ${businessName} is the same business as ${selected.businessName}. Archive it and keep ${selected.businessName}.`
              : "Pick the lead to keep first."}
          </span>
        </label>
        <InlineError>{error}</InlineError>
        <SubmitBar>
          <button type="button" className="btn-ghost" onClick={close}>
            Keep both
          </button>
          <button
            type="button"
            className="btn-danger"
            onClick={mark}
            disabled={pending || !selected || !confirmed}
          >
            {pending ? "Marking…" : "Mark as duplicate"}
          </button>
        </SubmitBar>
      </Modal>
    </>
  );
}

export function RestoreDuplicateButton({ prospectId }: { prospectId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setPending(true);
    setError(null);
    try {
      await apiRequest(`/api/leads/${prospectId}/duplicate`, {
        method: "POST",
        body: { action: "restore" },
      });
      setOpen(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not restore.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" className="btn-secondary" onClick={() => setOpen(true)} data-duplicate-restore>
        <RotateCcw size={13} /> Restore lead
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Restore this lead?"
        description={DUPLICATE_RESTORE_NOTE}
        width="sm"
      >
        <InlineError>{error}</InlineError>
        <SubmitBar>
          <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
            Keep as duplicate
          </button>
          <button type="button" className="btn-primary" onClick={restore} disabled={pending}>
            {pending ? "Restoring…" : "Restore lead"}
          </button>
        </SubmitBar>
      </Modal>
    </>
  );
}

/** Read-only list of leads marked as duplicates of the current one, each linked. */
export function DuplicatesOfList({
  duplicates,
}: {
  duplicates: { id: string; prospectId: string; prospectName: string }[];
}) {
  if (duplicates.length === 0) return null;
  return (
    <p className="text-13 text-muted" data-duplicates-of>
      Marked duplicates of this lead:{" "}
      {duplicates.map((item, index) => (
        <span key={item.id}>
          {index > 0 && ", "}
          <Link href={`/leads/${item.prospectId}`} className="font-semibold text-ink underline underline-offset-4">
            {item.prospectName}
          </Link>
        </span>
      ))}
    </p>
  );
}
