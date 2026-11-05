"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Keeping a lead out of the automatic follow-up job, without banning contact.
 *
 * One click, no dialog. When the lead is excluded the marker says so and the button puts it back;
 * otherwise the button excludes it. The hint stays beside the button because the distinction matters:
 * this stops the 04:00 job, not the founder — a deliberate email still goes out. A refusal from the
 * server is shown here, inline, beside the marker.
 */
export function FollowUpExclusionControl({
  prospectId,
  excluded,
}: {
  prospectId: string;
  excluded: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: boolean) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/leads/${prospectId}/follow-up-exclusion`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ excluded: next }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || "Could not change the follow-up exclusion.");
      }
      router.refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {excluded ? (
        <span
          className="badge border-amber/20 bg-amber/[0.06] text-amber"
          title="The automatic follow-up job skips this lead. Deliberate email is still allowed."
        >
          Excluded from automatic follow-ups
        </span>
      ) : null}
      <button
        type="button"
        className="btn-ghost"
        onClick={() => save(!excluded)}
        disabled={pending}
      >
        {pending
          ? "Saving..."
          : excluded
            ? "Include in automatic follow-ups"
            : "Exclude from automatic follow-ups"}
      </button>
      <span className="text-12 text-faint">
        Automatic only — you can still write to this lead yourself.
      </span>
      {error ? <span className="text-12 font-semibold text-amber">{error}</span> : null}
    </span>
  );
}