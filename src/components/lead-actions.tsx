"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  FilePlus2,
  LoaderCircle,
  Mail,
  Plus,
  RotateCcw,
  Save,
  Send,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import {
  CATEGORIES,
  PIPELINE,
  PIPELINE_LABELS,
  type Category,
  type Draft,
  type PipelineStatus,
  type ProspectDetail,
  type ResearchJob,
} from "@/lib/types";
import { cn } from "@/lib/cn";
import { apiRequest, CopyButton, InlineError, Modal, SubmitBar } from "./client-ui";
import { Notice } from "./ui";

const inputClass = "input";

export function AddLeadButton({
  jobs,
  defaultJobId,
}: {
  jobs: Pick<ResearchJob, "id" | "name" | "status">[];
  defaultJobId?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{
    id: string;
    name: string;
    matchedOn: string[];
  } | null>(null);

  const [businessName, setBusinessName] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [country, setCountry] = useState("");
  const [categories, setCategories] = useState<Category[]>(["forex"]);
  const [email, setEmail] = useState("");
  const [emailSourceUrl, setEmailSourceUrl] = useState("");
  const [signalDescription, setSignalDescription] = useState("");
  const [pricingDetails, setPricingDetails] = useState("");
  const [evidenceSummary, setEvidenceSummary] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceLabel, setSourceLabel] = useState("Official pricing or signal page");
  const [signalNotes, setSignalNotes] = useState("");
  const [researchJobId, setResearchJobId] = useState(
    defaultJobId || jobs.find((job) => job.status === "active")?.id || "",
  );
  const [instagramUrl, setInstagramUrl] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [xUrl, setXUrl] = useState("");
  const [telegramUrl, setTelegramUrl] = useState("");

  function resetDuplicate() {
    setDuplicate(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setDuplicate(null);
    try {
      const result = await apiRequest("/api/leads", {
        body: {
          businessName,
          websiteUrl,
          country,
          categories,
          email,
          emailSourceUrl,
          signalDescription,
          pricingDetails,
          evidenceSummary,
          sources: [
            {
              url: sourceUrl || emailSourceUrl,
              label: sourceLabel,
              notes: signalNotes,
            },
          ],
          researchJobId: researchJobId || null,
          instagramUrl,
          youtubeUrl,
          xUrl,
          telegramUrl,
          aliases: [],
          qualificationStatus: "verified",
        },
      });
      if (result.duplicate) {
        setDuplicate({
          id: result.prospect.id,
          name: result.prospect.businessName,
          matchedOn: result.matchedOn || [],
        });
        return;
      }
      setOpen(false);
      router.push(`/leads/${result.prospect.id}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save lead.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
        <Plus size={14} />
        Add verified lead
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add a verified commercial signal provider"
        description="Only save a business whose paid signal service and public email are confirmed by a source. Growth will reject duplicates."
        width="lg"
      >
        {duplicate ? (
          <div className="space-y-4">
            <Notice tone="warning" title="This business already exists in Growth.">
              Matched on {duplicate.matchedOn.join(", ") || "an existing identity"}.
              One business keeps one prospect record.
            </Notice>
            <div className="rounded-xl border border-line bg-white/60 p-4">
              <div className="text-[13px] font-semibold text-ink">{duplicate.name}</div>
              <p className="mt-1 text-[11px] leading-5 text-muted">
                Return to the existing research rather than overwriting it.
              </p>
            </div>
            <SubmitBar>
              <button type="button" className="btn-secondary" onClick={resetDuplicate}>
                Back to form
              </button>
              <Link href={`/leads/${duplicate.id}`} className="btn-primary">
                Open existing record <ArrowRight size={14} />
              </Link>
            </SubmitBar>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Business name *</label>
                <input
                  className={inputClass}
                  value={businessName}
                  onChange={(event) => setBusinessName(event.target.value)}
                  placeholder="FXPremiere"
                  required
                />
              </div>
              <div>
                <label className="label">Official website *</label>
                <input
                  className={inputClass}
                  value={websiteUrl}
                  onChange={(event) => setWebsiteUrl(event.target.value)}
                  placeholder="https://example.com"
                  required
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Published business email *</label>
                <input
                  className={inputClass}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="founder@business.com"
                  required
                />
                <p className="field-hint">
                  Exactly as published. Never guessed or pattern-generated.
                </p>
              </div>
              <div>
                <label className="label">Email source URL *</label>
                <input
                  className={inputClass}
                  value={emailSourceUrl}
                  onChange={(event) => setEmailSourceUrl(event.target.value)}
                  placeholder="Official contact / footer URL"
                  required
                />
                <p className="field-hint">
                  The page where this address is actually visible.
                </p>
              </div>
            </div>

            <div>
              <div className="label">Trading markets *</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {CATEGORIES.map((category) => {
                  const active = categories.includes(category.value);
                  return (
                    <button
                      type="button"
                      key={category.value}
                      onClick={() =>
                        setCategories((current) =>
                          active
                            ? current.filter((value) => value !== category.value)
                            : [...current, category.value],
                        )
                      }
                      className={cn(
                        "rounded-xl border px-2.5 py-2 text-[10.5px] font-semibold transition",
                        active
                          ? "border-forest/25 bg-lime/25 text-forest"
                          : "border-line bg-white/50 text-muted",
                      )}
                    >
                      {category.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Country</label>
                <input
                  className={inputClass}
                  value={country}
                  onChange={(event) => setCountry(event.target.value)}
                  placeholder="Verified country, or leave unknown"
                />
              </div>
              <div>
                <label className="label">Research target</label>
                <select
                  className="select"
                  value={researchJobId}
                  onChange={(event) => setResearchJobId(event.target.value)}
                >
                  <option value="">No target</option>
                  {jobs.map((job) => (
                    <option key={job.id} value={job.id}>
                      {job.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="label">Commercial signal service *</label>
              <textarea
                className="textarea min-h-[78px]"
                value={signalDescription}
                onChange={(event) => setSignalDescription(event.target.value)}
                placeholder="What exactly do they sell, in which markets, and how is it delivered?"
                required
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Public pricing / subscription details</label>
                <textarea
                  className="textarea min-h-[70px]"
                  value={pricingDetails}
                  onChange={(event) => setPricingDetails(event.target.value)}
                  placeholder="Plan names, prices, cadence — only what the source shows."
                />
              </div>
              <div>
                <label className="label">Evidence summary</label>
                <textarea
                  className="textarea min-h-[70px]"
                  value={evidenceSummary}
                  onChange={(event) => setEvidenceSummary(event.target.value)}
                  placeholder="Why this is a genuine paid signal business, not a broker or education-only site."
                />
              </div>
            </div>

            <div className="rounded-xl border border-line bg-paper/40 p-3.5">
              <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.12em] text-faint">
                Public evidence source
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  className={inputClass}
                  value={sourceUrl}
                  onChange={(event) => setSourceUrl(event.target.value)}
                  placeholder="Pricing / signal product URL"
                />
                <input
                  className={inputClass}
                  value={sourceLabel}
                  onChange={(event) => setSourceLabel(event.target.value)}
                  placeholder="Source label"
                />
              </div>
              <textarea
                className="textarea mt-3 min-h-[54px]"
                value={signalNotes}
                onChange={(event) => setSignalNotes(event.target.value)}
                placeholder="What does this source prove? (optional)"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Instagram URL", instagramUrl, setInstagramUrl],
                ["YouTube URL", youtubeUrl, setYoutubeUrl],
                ["X / Twitter URL", xUrl, setXUrl],
                ["Telegram URL", telegramUrl, setTelegramUrl],
              ].map(([label, value, setter]) => (
                <div key={label as string}>
                  <label className="label">{label as string}</label>
                  <input
                    className={inputClass}
                    value={value as string}
                    onChange={(event) =>
                      (setter as (value: string) => void)(event.target.value)
                    }
                    placeholder="Optional"
                  />
                </div>
              ))}
            </div>

            <InlineError>{error}</InlineError>
            <SubmitBar>
              <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={pending || categories.length === 0}
              >
                {pending ? <LoaderCircle size={14} className="spin" /> : <ShieldAlert size={14} />}
                {pending ? "Checking identity…" : "Save verified lead"}
              </button>
            </SubmitBar>
          </form>
        )}
      </Modal>
    </>
  );
}

const STATUS_ORDER = PIPELINE;

export function PipelineCard({
  prospect,
}: {
  prospect: Pick<
    ProspectDetail,
    "id" | "status" | "nextAction" | "nextActionAt" | "founderNotes" | "qualificationStatus"
  >;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<PipelineStatus>(prospect.status);
  const [nextAction, setNextAction] = useState(prospect.nextAction || "");
  const [notes, setNotes] = useState(prospect.founderNotes || "");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setSaved(false);
    setError(null);
    try {
      await apiRequest(`/api/leads/${prospect.id}`, {
        method: "PATCH",
        body: {
          status,
          nextAction: nextAction || null,
          founderNotes: notes || null,
        },
      });
      setSaved(true);
      router.refresh();
      window.setTimeout(() => setSaved(false), 1800);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={save} className="card p-5">
      <div className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-faint">
        Sales stage
      </div>
      <select
        className="select mt-2"
        value={status}
        onChange={(event) => setStatus(event.target.value as PipelineStatus)}
      >
        {STATUS_ORDER.map((value) => (
          <option key={value} value={value}>
            {PIPELINE_LABELS[value]}
          </option>
        ))}
      </select>
      <div className="mt-4">
        <label className="label">Next action</label>
        <input
          className="input"
          value={nextAction}
          onChange={(event) => setNextAction(event.target.value)}
          placeholder="What happens next?"
        />
      </div>
      <div className="mt-3">
        <label className="label">Founder notes</label>
        <textarea
          className="textarea min-h-[76px]"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Private context, not AI-generated."
        />
      </div>
      <InlineError>{error}</InlineError>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-[9.5px] text-faint">
          {saved ? "Saved." : "Updates immediately."}
        </span>
        <button type="submit" className="btn-secondary btn-sm" disabled={pending}>
          {pending ? <LoaderCircle size={12} className="spin" /> : <Save size={12} />}
          Save stage
        </button>
      </div>
    </form>
  );
}

export function ArchiveLeadButton({ prospectId }: { prospectId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function archive() {
    setPending(true);
    setError(null);
    try {
      await apiRequest(`/api/leads/${prospectId}/archive`, { method: "POST" });
      router.push("/leads");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not archive.");
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn-ghost btn-sm text-faint"
        onClick={() => setOpen(true)}
      >
        <Archive size={12} /> Archive
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Archive this prospect?"
        description="This hides the lead, cancels open drafts, and adds the contact to the suppression list. Historical messages remain for audit."
        width="sm"
      >
        <InlineError>{error}</InlineError>
        <SubmitBar>
          <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
            Keep lead
          </button>
          <button type="button" className="btn-danger" onClick={archive} disabled={pending}>
            {pending ? "Archiving…" : "Archive and suppress"}
          </button>
        </SubmitBar>
      </Modal>
    </>
  );
}

export function AddSourceButton({ prospectId }: { prospectId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setPending(true);
    setError(null);
    try {
      await apiRequest(`/api/leads/${prospectId}/source`, {
        body: { url, label: label || "Public evidence", notes },
      });
      setOpen(false);
      setUrl("");
      setLabel("");
      setNotes("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add source.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" className="btn-ghost btn-xs" onClick={() => setOpen(true)}>
        <FilePlus2 size={11} /> Add source
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add a public evidence source"
        description="Sources are timestamped and remain attached to this prospect."
        width="sm"
      >
        <div className="space-y-3">
          <div>
            <label className="label">URL</label>
            <input
              className="input"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://…"
            />
          </div>
          <div>
            <label className="label">What it shows</label>
            <input
              className="input"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Pricing page / contact footer / signal channel"
            />
          </div>
          <div>
            <label className="label">Notes</label>
            <textarea
              className="textarea min-h-[70px]"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          <InlineError>{error}</InlineError>
          <SubmitBar>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={add} disabled={pending || !url}>
              {pending ? "Saving…" : "Add source"}
            </button>
          </SubmitBar>
        </div>
      </Modal>
    </>
  );
}

function warningTone(code: string) {
  if (["pricing_not_approved", "unsupported_claim", "feature_not_approved"].includes(code)) {
    return "border-amber/25 bg-amber/[0.06] text-[#76501a]";
  }
  return "border-line bg-white/60 text-muted";
}

export function DraftEditor({
  prospectId,
  businessName,
  initialDraft,
  verifiedEmails,
  sandboxMode,
  canSend,
  sendBlockedReason,
  liveMode,
}: {
  prospectId: string;
  businessName: string;
  initialDraft: Draft | null;
  verifiedEmails: string[];
  sandboxMode: boolean;
  canSend: boolean;
  sendBlockedReason: string | null;
  liveMode: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(initialDraft);
  const [subject, setSubject] = useState(initialDraft?.subject || "");
  const [body, setBody] = useState(initialDraft?.body || "");
  const [recipient, setRecipient] = useState(
    initialDraft?.recipientEmail || verifiedEmails[0] || "",
  );
  const [warnings, setWarnings] = useState(initialDraft?.warnings || []);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setDraft(initialDraft);
    setSubject(initialDraft?.subject || "");
    setBody(initialDraft?.body || "");
    setRecipient(initialDraft?.recipientEmail || verifiedEmails[0] || "");
    setWarnings(initialDraft?.warnings || []);
  }, [initialDraft?.id, initialDraft?.updatedAt, initialDraft?.status, initialDraft?.subject, initialDraft?.body, initialDraft?.recipientEmail, verifiedEmails]);

  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const dirty =
    !!draft &&
    (subject !== draft.subject ||
      body !== draft.body ||
      recipient !== draft.recipientEmail);
  const sent = draft?.status === "sent";

  async function generate() {
    setPending("generate");
    setError(null);
    try {
      await apiRequest(`/api/leads/${prospectId}/draft`, {
        body: { force: Boolean(draft) },
      });
      setNotice(draft ? "Draft regenerated. Review every claim." : "Draft prepared.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not generate.");
    } finally {
      setPending(null);
    }
  }

  async function persist(): Promise<Draft | null> {
    if (!draft) return null;
    if (!dirty) return draft;
    const saved = await apiRequest(`/api/drafts/${draft.id}`, {
      method: "PATCH",
      body: { subject, body, recipientEmail: recipient },
    });
    setDraft(saved);
    setWarnings(saved.warnings || []);
    return saved;
  }

  async function save() {
    setPending("save");
    setError(null);
    setNotice(null);
    try {
      const saved = await persist();
      if (saved) setNotice("Draft saved. Founder edits are preserved.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save.");
    } finally {
      setPending(null);
    }
  }

  async function approve() {
    if (!draft) return;
    setPending("approve");
    setError(null);
    setNotice(null);
    try {
      await persist();
      await apiRequest(`/api/drafts/${draft.id}/approve`, { method: "POST" });
      setNotice("Draft approved. It is ready to send.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not approve.");
    } finally {
      setPending(null);
    }
  }

  async function send() {
    if (!draft) return;
    setPending("send");
    setError(null);
    setNotice(null);
    try {
      await persist();
      const result = await apiRequest(`/api/drafts/${draft.id}/send`, {
        body: { approveFirst: true },
      });
      setConfirmOpen(false);
      if (draft.kind === "first_contact") {
        setNotice(
          sandboxMode
            ? "Recorded in the sandbox mailbox. No message left Growth."
            : "Accepted by the sending server. Inbox delivery is not guaranteed.",
        );
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send.");
      setConfirmOpen(false);
    } finally {
      setPending(null);
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(`To: ${recipient}\nSubject: ${subject}\n\n${body}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  if (!draft) {
    return (
      <div className="card p-5">
        <div className="flex items-start gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-full bg-lime/30 text-forest">
            <Sparkles size={16} />
          </div>
          <div>
            <h2 className="text-[14px] font-bold text-ink">First-contact draft</h2>
            <p className="mt-1 text-[11px] leading-5 text-muted">
              No draft exists yet. Generate one personalized note grounded in
              the research above. Nothing is sent.
            </p>
          </div>
        </div>
        <InlineError>{error}</InlineError>
        <button
          type="button"
          className="btn-primary mt-4 w-full"
          onClick={generate}
          disabled={pending === "generate"}
        >
          {pending === "generate" ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <Sparkles size={14} />
          )}
          {pending === "generate" ? "Writing…" : "Generate personalized draft"}
        </button>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <Mail size={14} className="text-muted" />
            <h2 className="text-[13px] font-bold text-ink">
              {draft.kind === "first_contact" ? "First-contact draft" : "Follow-up draft"}
            </h2>
            <span
              className={cn(
                "badge capitalize",
                draft.status === "approved" && "border-forest/20 bg-lime/25 text-forest",
                draft.status === "sent" && "border-forest bg-forest text-lime",
              )}
            >
              {draft.status.replace("_", " ")}
            </span>
          </div>
          <p className="mt-1 text-[10.5px] text-muted">
            {draft.aiGenerated ? `AI-assisted · ${draft.sourceClient || draft.aiModel || "model"}` : "Deterministic writer"}{" "}
            · {words} words
            {draft.founderEdited ? " · founder-edited" : ""}
          </p>
        </div>
        {draft.founderEdited && (
          <span className="badge border-amber/20 bg-amber/[0.06] text-amber">
            <Check size={9} /> Your edits preserved
          </span>
        )}
      </div>

      <div className="space-y-3 p-5">
        <div>
          <label className="label">Recipient</label>
          <input
            className="input"
            value={recipient}
            list="verified-emails"
            onChange={(event) => setRecipient(event.target.value)}
            disabled={sent}
            autoComplete="off"
          />
          <datalist id="verified-emails">
            {verifiedEmails.map((email) => (
              <option key={email} value={email} />
            ))}
          </datalist>
          {!verifiedEmails.includes(recipient) && (
            <p className="mt-1 text-[10px] font-medium text-rust">
              This address is not a source-confirmed contact email. Sending will be blocked.
            </p>
          )}
        </div>
        <div>
          <label className="label">Subject</label>
          <input
            className="input"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            disabled={sent}
          />
        </div>
        <div>
          <label className="label">Message</label>
          <textarea
            className="textarea min-h-[370px] bg-[#fffefb] font-[450]"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            disabled={sent}
          />
          <div className="mt-1 flex items-center justify-between text-[9.5px] text-faint">
            <span>Signature and lawful unsubscribe footer are added at send.</span>
            <span className={words < 40 || words > 100 ? "text-amber" : "text-faint"}>
              {words} words
            </span>
          </div>
        </div>

        {warnings.length > 0 && (
          <div className="space-y-1.5">
            {warnings.map((warning) => (
              <div
                key={warning.code}
                className={cn(
                  "rounded-lg border px-2.5 py-2 text-[10.5px] leading-4",
                  warningTone(warning.code),
                )}
              >
                {warning.message}
              </div>
            ))}
          </div>
        )}

        {!sandboxMode && (
          <div className="rounded-lg border border-line bg-paper/60 px-2.5 py-2 text-[10px] leading-4 text-muted">
            Live sending is enabled. SMTP acceptance does not guarantee inbox
            delivery. The app will append the opt-out footer and sender identity.
          </div>
        )}

        {error && <InlineError>{error}</InlineError>}
        {notice && (
          <div className="rounded-lg border border-forest/20 bg-lime/15 px-2.5 py-2 text-[10.5px] text-forest">
            {notice}
          </div>
        )}
        {sendBlockedReason && !sent && (
          <div className="rounded-lg border border-amber/20 bg-amber/[0.05] px-2.5 py-2 text-[10px] leading-4 text-[#76501a]">
            {sendBlockedReason}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-4">
          {!sent && (
            <>
              <button
                type="button"
                onClick={save}
                disabled={!!pending || !dirty}
                className="btn-secondary btn-sm"
              >
                {pending === "save" ? (
                  <LoaderCircle size={12} className="spin" />
                ) : (
                  <Save size={12} />
                )}
                Save
              </button>
              {draft.status !== "approved" && (
                <button
                  type="button"
                  onClick={approve}
                  disabled={!!pending}
                  className="btn-secondary btn-sm"
                >
                  <CheckCircle2 size={12} /> Approve
                </button>
              )}
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={!!pending || !canSend}
                className="btn-primary btn-sm"
              >
                {pending === "send" ? (
                  <LoaderCircle size={12} className="spin" />
                ) : (
                  <Send size={12} />
                )}
                {sandboxMode ? "Record sandbox send" : draft.status === "approved" ? "Send email" : "Approve & send"}
              </button>
            </>
          )}
          <button type="button" onClick={copy} className="btn-ghost btn-sm">
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy"}
          </button>
          {!sent && (
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    "Regenerate this draft? Your current edits will be kept in revision history but replaced in the editor.",
                  )
                ) {
                  generate();
                }
              }}
              className="btn-ghost btn-sm ml-auto text-faint"
              disabled={!!pending}
            >
              <RotateCcw size={11} /> Regenerate
            </button>
          )}
        </div>
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={
          sandboxMode
            ? "Record this as a sandbox send?"
            : "Send this email to a real prospect?"
        }
        description={
          sandboxMode
            ? "Growth will record the message and thread in the sandbox mailbox. No SMTP connection is made and nothing reaches the prospect."
            : `This will send from the connected mailbox to ${recipient}. SMTP acceptance is not a guarantee of inbox delivery.`
        }
        width="sm"
      >
        <div className="rounded-xl border border-line bg-paper/50 p-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-faint">
            {sandboxMode ? "Sandbox preview" : "Live send"}
          </div>
          <div className="mt-1 text-[12px] font-semibold text-ink">{subject}</div>
          <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-[10.5px] leading-5 text-muted">
            {body}
          </div>
        </div>
        {error && <InlineError>{error}</InlineError>}
        <SubmitBar>
          <button type="button" className="btn-ghost" onClick={() => setConfirmOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className={liveMode ? "btn-primary" : "btn-lime"}
            onClick={send}
            disabled={pending === "send"}
          >
            {pending === "send" ? <LoaderCircle size={13} className="spin" /> : <Send size={13} />}
            {pending === "send"
              ? "Working…"
              : sandboxMode
                ? "Record sandbox send"
                : "Send now"}
          </button>
        </SubmitBar>
      </Modal>
    </div>
  );
}
