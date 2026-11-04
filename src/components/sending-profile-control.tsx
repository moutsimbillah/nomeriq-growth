"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Choosing which mailbox a lead is emailed from.
 *
 * One click, no dialog. Shown only while the lead has not been emailed yet: after that the profile is
 * fixed and the page says so instead, because the prospect has already seen that address and its
 * replies live in that thread. A refusal from the server is shown here, inline, beside the pill.
 */
export function SendingProfileControl({
  prospectId,
  currentId,
  profiles,
}: {
  prospectId: string;
  currentId: string;
  profiles: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [choice, setChoice] = useState(currentId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/leads/${prospectId}/sending-profile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: choice }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || "Could not change the sending profile.");
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
      <select
        className="select w-auto min-w-[150px]"
        value={choice}
        onChange={(event) => setChoice(event.target.value)}
        disabled={pending}
        aria-label="Sending profile"
      >
        <option value="">Choose a profile…</option>
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn-ghost"
        onClick={save}
        disabled={pending || !choice || choice === currentId}
      >
        {pending ? "Saving…" : "Set profile"}
      </button>
      {error ? <span className="text-12 font-semibold text-amber">{error}</span> : null}
    </span>
  );
}
