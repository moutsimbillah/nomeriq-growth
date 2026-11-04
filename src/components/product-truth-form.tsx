"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, LoaderCircle, Save, ShieldCheck } from "lucide-react";
import type { ProductTruth } from "@/lib/types";
import { apiRequest, InlineError, SubmitBar } from "./client-ui";
import { Notice } from "./ui";

function toLines(values: string[]) {
  return values.join("\n");
}

export function ProductTruthForm({ truth }: { truth: ProductTruth }) {
  const router = useRouter();
  const [oneLiner, setOneLiner] = useState(truth.oneLiner);
  const [offerSummary, setOfferSummary] = useState(truth.offerSummary);
  const [howItWorks, setHowItWorks] = useState(truth.howItWorks);
  const [pricingNotes, setPricingNotes] = useState(truth.pricingNotes);
  const [integrations, setIntegrations] = useState(truth.integrations);
  const [limitations, setLimitations] = useState(truth.limitations);
  const [approvedClaims, setApprovedClaims] = useState(
    toLines(truth.approvedClaims),
  );
  const [prohibitedClaims, setProhibitedClaims] = useState(
    toLines(truth.prohibitedClaims),
  );
  const [pending, setPending] = useState<"draft" | "approve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save(approve: boolean) {
    setPending(approve ? "approve" : "draft");
    setError(null);
    setNotice(null);
    try {
      await apiRequest("/api/product-truth", {
        method: "PUT",
        body: {
          oneLiner,
          offerSummary,
          howItWorks,
          pricingNotes,
          integrations,
          limitations,
          approvedClaims: approvedClaims.split("\n").map((line) => line.trim()).filter(Boolean),
          prohibitedClaims: prohibitedClaims.split("\n").map((line) => line.trim()).filter(Boolean),
          approve,
        },
      });
      setNotice(
        approve
          ? "Product Truth approved. AI drafts will use this version."
          : "Saved as a new draft version. It is not marked approved.",
      );
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <div className="text-12 font-bold uppercase tracking-[0.15em] text-faint">
            Version {truth.version}
          </div>
          <h2 className="mt-1 text-16 font-bold tracking-[-0.01em] text-ink">
            Founder-approved product facts
          </h2>
        </div>
        <span
          className={`badge ${
            truth.status === "approved"
              ? "border-forest/20 bg-lime/25 text-forest"
              : "border-amber/20 bg-amber/[0.07] text-amber"
          }`}
        >
          {truth.status === "approved" ? (
            <>
              <CheckCircle2 size={10} /> Approved
            </>
          ) : (
            "Needs founder review"
          )}
        </span>
      </div>

      <div className="space-y-5 p-5">
        <Notice tone="info">
          Product Truth stops AI from inventing features, prices, integrations or
          performance claims. It is not a gate on your own emails: when you
          personally review and send a reply, Growth applies only the essential
          recipient, suppression, authentication and delivery safeguards.
        </Notice>

        <div>
          <label className="label" htmlFor="one-liner">
            One-line description *
          </label>
          <input
            id="one-liner"
            className="input"
            value={oneLiner}
            onChange={(event) => setOneLiner(event.target.value)}
          />
          <p className="field-hint">
            The safest factual sentence an AI may use in a first-contact email.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="offer">
              What Nomeriq offers
            </label>
            <textarea
              id="offer"
              className="textarea min-h-[120px]"
              value={offerSummary}
              onChange={(event) => setOfferSummary(event.target.value)}
              placeholder="Only real, founder-confirmed capabilities."
            />
          </div>
          <div>
            <label className="label" htmlFor="how">
              How it works
            </label>
            <textarea
              id="how"
              className="textarea min-h-[120px]"
              value={howItWorks}
              onChange={(event) => setHowItWorks(event.target.value)}
              placeholder="Implementation, onboarding, delivery model — only if true."
            />
          </div>
          <div>
            <label className="label" htmlFor="pricing">
              Approved pricing and commercial terms
            </label>
            <textarea
              id="pricing"
              className="textarea min-h-[110px]"
              value={pricingNotes}
              onChange={(event) => setPricingNotes(event.target.value)}
              placeholder="Exact approved pricing. If none, say pricing is not approved and must not be quoted."
            />
          </div>
          <div>
            <label className="label" htmlFor="integrations">
              Approved integrations
            </label>
            <textarea
              id="integrations"
              className="textarea min-h-[110px]"
              value={integrations}
              onChange={(event) => setIntegrations(event.target.value)}
              placeholder="Only integrations that actually exist and are supportable."
            />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="limitations">
              Limitations and things not to claim
            </label>
            <textarea
              id="limitations"
              className="textarea min-h-[100px]"
              value={limitations}
              onChange={(event) => setLimitations(event.target.value)}
              placeholder="Performance, guarantees, unsupported modules, client outcomes."
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="approved-claims">
              Approved claims (one per line)
            </label>
            <textarea
              id="approved-claims"
              className="textarea min-h-[140px] font-mono text-12"
              value={approvedClaims}
              onChange={(event) => setApprovedClaims(event.target.value)}
            />
            <p className="field-hint">
              Every factual product sentence available to AI in outreach.
            </p>
          </div>
          <div>
            <label className="label" htmlFor="prohibited-claims">
              Prohibited claims (one per line)
            </label>
            <textarea
              id="prohibited-claims"
              className="textarea min-h-[140px] font-mono text-12"
              value={prohibitedClaims}
              onChange={(event) => setProhibitedClaims(event.target.value)}
            />
            <p className="field-hint">
              Phrases and categories that should always trigger a warning.
            </p>
          </div>
        </div>

        {error && <InlineError>{error}</InlineError>}
        {notice && (
          <div className="rounded-lg border border-forest/20 bg-lime/15 px-3 py-2 text-12 text-forest">
            {notice}
          </div>
        )}

        <SubmitBar>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => save(false)}
            disabled={!!pending || !oneLiner.trim()}
          >
            {pending === "draft" ? (
              <LoaderCircle size={13} className="spin" />
            ) : (
              <Save size={13} />
            )}
            Save draft version
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => save(true)}
            disabled={!!pending || !oneLiner.trim()}
          >
            {pending === "approve" ? (
              <LoaderCircle size={13} className="spin" />
            ) : (
              <ShieldCheck size={13} />
            )}
            {pending === "approve" ? "Approving…" : "Save & approve"}
          </button>
        </SubmitBar>
      </div>
    </div>
  );
}
