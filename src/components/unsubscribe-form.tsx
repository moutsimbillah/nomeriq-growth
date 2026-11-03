"use client";

import { useState } from "react";
import { Check, LoaderCircle } from "lucide-react";

export function UnsubscribeForm({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function unsubscribe() {
    setState("pending");
    try {
      const response = await fetch(`/api/unsubscribe/${encodeURIComponent(token)}`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || "This link could not be used.");
      }
      setMessage(payload?.data?.email || "Your address");
      setState("done");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Something went wrong.");
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <div className="text-center">
        <div className="mx-auto mb-5 grid h-12 w-12 place-items-center rounded-full bg-lime text-forest">
          <Check size={20} strokeWidth={2.4} />
        </div>
        <h1 className="display-title text-[38px]">You’re unsubscribed.</h1>
        <p className="mt-3 text-[13px] leading-6 text-muted">
          {message} has been added to the Nomeriq Growth suppression list. No
          further promotional email will be sent to this address.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="eyebrow mb-3">Email preference</div>
      <h1 className="display-title text-[42px]">Unsubscribe from Nomeriq outreach.</h1>
      <p className="mt-4 text-[13px] leading-6 text-muted">
        This will immediately add this address to Nomeriq Growth’s suppression
        list and cancel any prepared follow-up emails to this contact. You will
        not need to do anything else.
      </p>
      {state === "error" && (
        <div className="mt-5 rounded-xl border border-rust/20 bg-rust/[0.05] px-3 py-2.5 text-[12px] text-rust">
          {message}
        </div>
      )}
      <button
        type="button"
        onClick={unsubscribe}
        disabled={state === "pending"}
        className="btn-primary mt-7 h-11 w-full"
      >
        {state === "pending" ? (
          <>
            <LoaderCircle size={15} className="spin" /> Removing…
          </>
        ) : (
          "Confirm unsubscribe"
        )}
      </button>
      <p className="mt-4 text-[10.5px] leading-5 text-faint">
        This page is provided by Nomeriq Growth, an independent outreach system
        operated for Nomeriq. It does not require a login.
      </p>
    </div>
  );
}
