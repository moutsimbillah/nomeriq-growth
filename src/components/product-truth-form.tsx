"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Download,
  LoaderCircle,
  Save,
  ShieldCheck,
  Upload,
} from "lucide-react";
import type { ProductTruth } from "@/lib/types";
import {
  changedProductTruthFields,
  parseProductTruthImport,
  PRODUCT_TRUTH_FIELD_LABELS,
  PRODUCT_TRUTH_IMPORT_MAX_BYTES,
  productTruthExportFileName,
  productTruthExportJson,
  productTruthSaveBody,
  productTruthToFormState,
  savedFormOf,
  type ProductTruthContentField,
  type ProductTruthFormState,
  type ProductTruthImportMetadata,
} from "@/lib/product-truth-transfer";
import { apiRequest, InlineError, SubmitBar } from "./client-ui";
import { Notice } from "./ui";

interface PendingImport {
  fileName: string;
  form: ProductTruthFormState;
  metadata: ProductTruthImportMetadata;
  changed: ProductTruthContentField[];
  /** Fields with unsaved edits that the import would overwrite. */
  overwritesUnsaved: ProductTruthContentField[];
}

function fieldList(fields: ProductTruthContentField[]) {
  return fields.map((field) => PRODUCT_TRUTH_FIELD_LABELS[field]).join(", ");
}

export function ProductTruthForm({ truth }: { truth: ProductTruth }) {
  const router = useRouter();
  const [form, setForm] = useState<ProductTruthFormState>(() =>
    productTruthToFormState(truth),
  );
  const {
    oneLiner,
    offerSummary,
    howItWorks,
    pricingNotes,
    integrations,
    limitations,
    approvedClaims,
    prohibitedClaims,
    discoveryQuestions,
  } = form;
  const setField = (field: ProductTruthContentField) => (value: string) =>
    setForm((current) => ({ ...current, [field]: value }));
  const setOneLiner = setField("oneLiner");
  const setOfferSummary = setField("offerSummary");
  const setHowItWorks = setField("howItWorks");
  const setPricingNotes = setField("pricingNotes");
  const setIntegrations = setField("integrations");
  const setLimitations = setField("limitations");
  const setApprovedClaims = setField("approvedClaims");
  const setProhibitedClaims = setField("prohibitedClaims");
  const setDiscoveryQuestions = setField("discoveryQuestions");
  const [pending, setPending] = useState<"draft" | "approve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[] | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // What Save would change compared with the saved version shown in the header.
  const unsavedFields = changedProductTruthFields(
    savedFormOf(productTruthToFormState(truth)),
    savedFormOf(form),
  );
  const savedLabel = `version ${truth.version} (${truth.status === "approved" ? "approved" : "draft, not approved"})`;

  // Export the SAVED record exactly as Growth stores and reads it. No request is made.
  function exportSaved() {
    setError(null);
    setImportErrors(null);
    const blob = new Blob([productTruthExportJson(truth)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = productTruthExportFileName(truth);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setNotice(
      unsavedFields.length
        ? `Exported saved ${savedLabel}. Your unsaved edits (${fieldList(unsavedFields)}) are not in this file — save first to include them.`
        : `Exported saved ${savedLabel}.`,
    );
  }

  // Read a file into a preview. Nothing is applied, saved or approved here; no request is made.
  async function chooseImportFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const file = input.files?.[0];
    // Reset so choosing the same file again (after fixing it) fires change again.
    input.value = "";
    if (!file) return;
    setError(null);
    setNotice(null);
    setImportErrors(null);
    setPendingImport(null);
    if (file.size > PRODUCT_TRUTH_IMPORT_MAX_BYTES) {
      setImportErrors([
        `${file.name} is larger than ${Math.round(PRODUCT_TRUTH_IMPORT_MAX_BYTES / 1024)} KB.`,
      ]);
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setImportErrors([`Could not read ${file.name}.`]);
      return;
    }
    const result = parseProductTruthImport(text);
    if (!result.ok) {
      setImportErrors(result.errors);
      return;
    }
    const imported = productTruthToFormState(result.content);
    const changed = changedProductTruthFields(form, imported);
    if (!changed.length) {
      setNotice(`${file.name} matches the form already. Nothing changed.`);
      return;
    }
    setPendingImport({
      fileName: file.name,
      form: imported,
      metadata: result.metadata,
      changed,
      overwritesUnsaved: changed.filter((field) => unsavedFields.includes(field)),
    });
  }

  function applyImport() {
    if (!pendingImport) return;
    setForm(pendingImport.form);
    setNotice(
      `Loaded ${pendingImport.changed.length} field${pendingImport.changed.length === 1 ? "" : "s"} from ${pendingImport.fileName} into the form. Nothing is saved yet: review, then choose Save draft version or Save & approve. The file's version, status and approval were not applied.`,
    );
    setPendingImport(null);
  }

  async function save(approve: boolean) {
    setPending(approve ? "approve" : "draft");
    setError(null);
    setNotice(null);
    try {
      await apiRequest("/api/product-truth", {
        method: "PUT",
        body: productTruthSaveBody(form, approve),
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

        <div
          data-product-truth-transfer
          className="rounded-lg border border-line px-3 py-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => fileInput.current?.click()}
              disabled={!!pending}
            >
              <Upload size={13} /> Import JSON
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={exportSaved}
              disabled={!!pending}
            >
              <Download size={13} /> Export saved JSON (v{truth.version})
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="hidden"
              aria-label="Product Truth JSON file to import"
              data-product-truth-import-input
              onChange={chooseImportFile}
            />
          </div>
          <p className="field-hint">
            Export downloads saved {savedLabel} in the exact format Growth
            saves and reads. Import loads a file in that format into this form
            only — nothing is saved or approved until you choose a save button.
            {unsavedFields.length > 0 &&
              ` The form has unsaved edits (${fieldList(unsavedFields)}); Export does not include them.`}
          </p>
        </div>

        {importErrors && (
          <div data-product-truth-import-errors>
            <InlineError>
              <div className="font-semibold">
                Import refused — the form was not changed.
              </div>
              <ul className="mt-1 list-disc pl-4">
                {importErrors.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </InlineError>
          </div>
        )}

        {pendingImport && (
          <div
            data-product-truth-import-preview
            className="rounded-lg border border-amber/25 bg-amber/[0.06] px-3 py-3 text-12 leading-5 text-ink"
          >
            <div className="font-semibold">
              Replace form fields from {pendingImport.fileName}?
            </div>
            <p className="mt-1 text-muted">
              Will replace: {fieldList(pendingImport.changed)}.
            </p>
            {pendingImport.overwritesUnsaved.length > 0 && (
              <p className="mt-1 font-semibold text-rust">
                This discards your unsaved edits to:{" "}
                {fieldList(pendingImport.overwritesUnsaved)}.
              </p>
            )}
            <p className="mt-1 text-muted">
              {pendingImport.metadata.version !== undefined ||
              pendingImport.metadata.status
                ? `The file says ${[
                    pendingImport.metadata.version !== undefined
                      ? `version ${pendingImport.metadata.version}`
                      : null,
                    pendingImport.metadata.status === "approved"
                      ? "approved"
                      : pendingImport.metadata.status
                        ? "not approved"
                        : null,
                  ]
                    .filter(Boolean)
                    .join(", ")}; that is ignored. `
                : ""}
              Nothing is saved or approved until you choose Save draft version
              or Save &amp; approve.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-primary"
                onClick={applyImport}
              >
                Replace form fields
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setPendingImport(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

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

        <div data-discovery-questions>
          <label className="label" htmlFor="discovery-questions">
            Questions to ask prospects (one per line)
          </label>
          <textarea
            id="discovery-questions"
            className="textarea min-h-[140px] font-mono text-12"
            value={discoveryQuestions}
            onChange={(event) => setDiscoveryQuestions(event.target.value)}
            placeholder={"How do your subscribers receive signals today?\nWho handles payments and access for your VIP group?"}
          />
          <p className="field-hint">
            Discovery questions every AI draft, suggestion and follow-up may ask — and connected
            assistants can read. Write them in your own words.
          </p>
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
            disabled={!!pending || !!pendingImport || !oneLiner.trim()}
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
            disabled={!!pending || !!pendingImport || !oneLiner.trim()}
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
