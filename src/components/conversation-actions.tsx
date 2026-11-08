"use client";

import { EmailIdentityPreview, useEmailPresentation } from "./email-identity-preview";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { languageName } from "@/lib/email/translation-view";
import {
  Check,
  Copy,
  FileText,
  LoaderCircle,
  Paperclip,
  Send,
  Sparkles,
  TestTube2,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import {
  CLASSIFICATIONS,
  CLASSIFICATION_LABELS,
  type Classification,
} from "@/lib/types";
import { apiRequest, InlineError, Modal, SubmitBar } from "./client-ui";
import { Notice } from "./ui";

/** "Written by <provider> · <model>", noting a fallback when the assigned provider did not answer. */
export function writtenByLabel(result: { provider?: string | null; model?: string | null; fallbackUsed?: string | null }): string | null {
  const who = [result.provider, result.model].filter((part) => part && String(part).trim()).join(" · ");
  if (!who) return null;
  return `Written by ${who}${result.fallbackUsed ? " (fallback — the assigned provider did not answer)" : ""}`;
}

/** The body with each sentence that needs the founder's confirmation highlighted in place. */
export function HighlightedDraft({ body, sentences }: { body: string; sentences: string[] }) {
  const parts: { text: string; mark: boolean }[] = [];
  let rest = body;
  while (rest) {
    const hits = sentences
      .map((sentence) => ({ sentence, at: rest.indexOf(sentence) }))
      .filter((hit) => hit.at >= 0)
      .sort((a, b) => a.at - b.at);
    const first = hits[0];
    if (!first) { parts.push({ text: rest, mark: false }); break; }
    if (first.at > 0) parts.push({ text: rest.slice(0, first.at), mark: false });
    parts.push({ text: first.sentence, mark: true });
    rest = rest.slice(first.at + first.sentence.length);
  }
  return (
    <div className="whitespace-pre-wrap break-anywhere rounded-lg border border-amber/30 bg-[#fffaf0] px-3 py-2 text-12 leading-5 text-ink" data-confirm-preview>
      {parts.map((part, index) =>
        part.mark
          ? <mark key={index} className="rounded bg-amber/30 px-0.5 text-ink" data-confirm-sentence>{part.text}</mark>
          : <span key={index}>{part.text}</span>,
      )}
    </div>
  );
}

/** A small link that opens exactly what the AI received. */
export function ContextUsedLink({ context }: { context: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="text-12 font-semibold text-muted underline underline-offset-4 hover:text-ink" onClick={() => setOpen(true)} data-context-used>
        Context used
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Context used" description="Exactly what the AI received for this result: instructions first, then the request." width="lg">
        <pre className="max-h-[65dvh] overflow-auto whitespace-pre-wrap break-anywhere rounded-lg border border-line bg-white/70 p-3 text-12 leading-5 text-ink">{context}</pre>
      </Modal>
    </>
  );
}

interface SuggestionMeta {
  writtenBy: string | null;
  englishBody: string | null;
  language: string | null;
  confirmSentences: string[];
  context: string | null;
  aiBody: string;
}

export function MarkConversationRead({ conversationId }: { conversationId: string }) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    fetch(`/api/conversations/${conversationId}/read`, { method: "POST" }).catch(
      () => undefined,
    );
  }, [conversationId]);
  return null;
}

export function ClassificationSelect({
  conversationId,
  value,
}: {
  conversationId: string;
  value: Classification;
}) {
  const router = useRouter();
  const [classification, setClassification] = useState<Classification>(value);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: Classification) {
    if (
      next === "unsubscribe" &&
      !window.confirm(
        "Classifying this as an opt-out immediately adds the contact to the suppression list and blocks all further promotional email. Continue?",
      )
    ) {
      return;
    }
    setClassification(next);
    setPending(true);
    setError(null);
    try {
      await apiRequest(`/api/conversations/${conversationId}/classify`, {
        body: { classification: next },
      });
      router.refresh();
    } catch (caught) {
      setClassification(value);
      setError(caught instanceof Error ? caught.message : "Could not update.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <label className="label">Suggested category</label>
      <div className="relative">
        <select
          className="select"
          value={classification}
          onChange={(event) => change(event.target.value as Classification)}
          disabled={pending}
        >
          {CLASSIFICATIONS.map((item) => (
            <option key={item} value={item}>
              {CLASSIFICATION_LABELS[item]}
            </option>
          ))}
        </select>
        {pending && (
          <LoaderCircle
            size={12}
            className="spin absolute right-8 top-1/2 -translate-y-1/2 text-faint"
          />
        )}
      </div>
      {error && <p className="mt-1 text-12 text-rust">{error}</p>}
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.split(",")[1] || "");
    };
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

export function ReplyComposer({
  conversationId,
  defaultSubject,
  recipient,
  suppressed,
  blockedReason,
  sandbox,
}: {
  conversationId: string;
  defaultSubject: string;
  recipient: string | null;
  suppressed: boolean;
  blockedReason: string | null;
  sandbox: boolean;
}) {
  const router = useRouter();
  const keyRef = useRef<string | null>(null);
  const presentation = useEmailPresentation({ conversationId }, !suppressed && !!recipient);
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<
    { filename: string; contentType: string; dataBase64: string; size: number }[]
  >([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [suggestionNote, setSuggestionNote] = useState<string | null>(null);
  const [meta, setMeta] = useState<SuggestionMeta | null>(null);
  const [copied, setCopied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const edited = useRef(false);
  const mounted = useRef(true);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [proposed, setProposed] = useState<{ body: string; subject: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // No generation on mount. Only the Suggest / Retry buttons call this function.
  async function suggest() {
    setPending("suggest");
    setSuggestionError(null);
    setSuggestionNote(null);
    setProposed(null);
    try {
      const result = await apiRequest(
        `/api/conversations/${conversationId}/suggest-reply`,
        { method: "POST" },
      );
      if (!mounted.current) return;
      if (result.failure) {
        setSuggestionError(result.failure.message);
        return;
      }
      if (result.body) {
        // Typing before OR during the request always wins. Suggestions remain visible beside the
        // editor, never inserted over the founder's text (including when the field was later cleared).
        if (edited.current) {
          setProposed({ body: result.body, subject: result.subject || defaultSubject });
          setSuggestionNote("Suggestion ready below. Your text has not been changed.");
          return;
        }
        setSubject(result.subject || defaultSubject);
        setBody(result.body);
        setMeta(result.usedAi ? {
          writtenBy: writtenByLabel(result),
          englishBody: result.englishBody ?? null,
          language: result.language ?? null,
          confirmSentences: Array.isArray(result.confirmSentences) ? result.confirmSentences : [],
          context: result.context ?? null,
          aiBody: result.body,
        } : null);
        setSuggestionNote(result.note || (result.usedAi ? "AI suggestion inserted. Edit anything before sending." : "No AI suggestion available."));
      } else {
        setSuggestionError(result.note || "No suggestion available. Please try again.");
      }
    } catch (caught) {
      if (mounted.current) setSuggestionError(caught instanceof Error ? caught.message : "Could not suggest a reply.");
    } finally {
      if (mounted.current) setPending(null);
    }
  }

  async function addFiles(files: FileList | null) {
    if (!files) return;
    setError(null);
    const next = [...attachments];
    for (const file of Array.from(files)) {
      if (next.length >= 3) {
        setError("Up to three attachments are allowed.");
        break;
      }
      if (file.size > 2 * 1024 * 1024) {
        setError("Each attachment must be under 2 MB.");
        continue;
      }
      try {
        const dataBase64 = await fileToBase64(file);
        next.push({
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          dataBase64,
          size: file.size,
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not attach file.");
      }
    }
    setAttachments(next);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function send() {
    if (!keyRef.current) keyRef.current = crypto.randomUUID();
    setPending("send");
    setError(null);
    setNotice(null);
    try {
      const result = await apiRequest(`/api/conversations/${conversationId}/reply`, {
        body: {
          subject,
          body,
          attachments: attachments.map(({ filename, contentType, dataBase64 }) => ({
            filename,
            contentType,
            dataBase64,
          })),
        },
        idempotencyKey: keyRef.current,
      });
      keyRef.current = null;
      setBody("");
      setAttachments([]);
      setSuggestionNote(null);
      setMeta(null);
      setNotice(
        sandbox || result.status === "sandbox"
          ? "Reply recorded in the sandbox mailbox. No message left Growth."
          : "Reply accepted by the sending server. Inbox delivery is not guaranteed.",
      );
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the reply.");
    } finally {
      setPending(null);
    }
  }

  async function copy() {
    try {
      const content = presentation.content(body);
      if (content === null) throw new Error(presentation.error || "Wait for the current signature/address preview before copying.");
      await navigator.clipboard.writeText(`To: ${recipient}\nSubject: ${subject}\n\n${content}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not copy the reply."); }
  }

  if (suppressed || !recipient) {
    return (
      <div className="card p-5">
        <div className="flex items-start gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-full bg-rust/[0.08] text-rust">
            <X size={16} />
          </div>
          <div>
            <h2 className="text-13 font-bold text-ink">Replying is blocked</h2>
            <p className="mt-1 text-12 leading-5 text-muted">
              {blockedReason ||
                "This conversation is suppressed or has no valid inbound sender."}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card min-w-0 overflow-hidden">
      <div className="border-b border-line px-5 py-4">
        {/* The row wraps rather than the label: at narrow widths the button takes its own line
            (`w-full`, reset at `sm`) instead of breaking "Suggest with AI" across two lines. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Send size={14} className="text-muted" />
              <h2 className="text-13 font-bold text-ink">Write reply</h2>
            </div>
            <p className="mt-0.5 break-anywhere text-12 text-faint">
              To {recipient} · your click sends the reviewed version
            </p>
          </div>
          <button
            type="button"
            onClick={suggest}
            className="btn-secondary btn-xs w-full whitespace-nowrap sm:w-auto"
            disabled={!!pending}
          >
            {pending === "suggest" ? (
              <LoaderCircle size={10} className="spin" />
            ) : (
              <WandSparkles size={10} />
            )}
            <span className="whitespace-nowrap">
              {body ? "Suggest again" : "Suggest with AI"}
            </span>
          </button>
        </div>
      </div>

      <div className="space-y-3 p-5">
        <div>
          <label className="label">Subject</label>
          <input
            className="input"
            value={subject}
            onChange={(event) => { edited.current = true; setSubject(event.target.value); }}
          />
        </div>
        <div>
          <label className="label">Message</label>
          <textarea
            className="textarea min-h-[240px] bg-[#fffefb]"
            value={body}
            onChange={(event) => { edited.current = true; setBody(event.target.value); }}
            placeholder="Write a real answer to their message. Or generate a suggestion and edit it."
          />
        </div>

        {suggestionError && (
          <div className="rounded-lg border border-rust/25 bg-rust/[0.04] p-3 text-12 text-rust" role="alert" data-suggestion-error>
            <p>{suggestionError}</p>
            <button type="button" className="btn-secondary btn-xs mt-2" onClick={suggest} disabled={!!pending} data-suggestion-retry>
              Retry
            </button>
          </div>
        )}
        {proposed && (
          <div className="rounded-lg border border-line p-3 text-12" data-suggestion-preview>
            <p className="font-semibold">AI suggestion — your reply is unchanged</p>
            <p className="mt-1 whitespace-pre-wrap break-anywhere">{proposed.body}</p>
            <button type="button" className="btn-secondary btn-xs mt-2" onClick={async () => {
              await navigator.clipboard.writeText(proposed.body);
              setSuggestionNote("Suggestion copied. Your text has not been changed.");
            }}>Copy suggestion</button>
          </div>
        )}
        {suggestionNote && (
          <div className="rounded-lg border border-line bg-lime/10 px-2.5 py-2 text-12 leading-4 text-forest">
            {suggestionNote}
          </div>
        )}

        {meta && (
          <div className="space-y-2" data-suggestion-meta>
            {meta.confirmSentences.length > 0 && body === meta.aiBody && (
              <div className="space-y-1">
                <p className="text-12 font-semibold text-amber">
                  Highlighted: {meta.confirmSentences.length === 1 ? "this sentence needs" : "these sentences need"} your confirmation before sending.
                </p>
                <HighlightedDraft body={body} sentences={meta.confirmSentences} />
              </div>
            )}
            {meta.confirmSentences.length > 0 && body !== meta.aiBody && (
              <p className="text-12 text-amber">
                Needs your confirmation: {meta.confirmSentences.map((sentence) => `“${sentence}”`).join(" ")}
              </p>
            )}
            {meta.englishBody && (
              <details className="rounded-lg border border-line bg-white/60 px-2.5 py-2 text-12" open>
                <summary className="cursor-pointer font-semibold text-ink">
                  English version (for you — the reply above is in {meta.language ? languageName(meta.language) : "the prospect's language"} and is what gets sent)
                </summary>
                <p className="mt-1.5 whitespace-pre-wrap break-anywhere leading-5 text-muted">{meta.englishBody}</p>
              </details>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-faint">
              {meta.writtenBy && <span data-written-by>{meta.writtenBy}</span>}
              {meta.context && <ContextUsedLink context={meta.context} />}
            </div>
          </div>
        )}

        <EmailIdentityPreview content={presentation.content(body)} error={presentation.error} />
        {attachments.length > 0 && (
          <div className="space-y-1.5">
            {attachments.map((attachment, index) => (
              <div
                key={`${attachment.filename}-${index}`}
                className="flex items-center justify-between rounded-lg border border-line bg-white/60 px-2.5 py-1.5 text-12"
              >
                <span className="flex items-center gap-1.5 truncate text-muted">
                  <FileText size={10} />
                  {attachment.filename}
                  <span className="text-faint">
                    ({Math.round(attachment.size / 1024)} KB)
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setAttachments((current) =>
                      current.filter((_, itemIndex) => itemIndex !== index),
                    )
                  }
                  className="text-faint hover:text-rust"
                  aria-label="Remove attachment"
                >
                  <Trash2 size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        {error && <InlineError>{error}</InlineError>}
        {notice && (
          <div className="rounded-lg border border-forest/20 bg-lime/15 px-2.5 py-2 text-12 leading-4 text-forest">
            {notice}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => addFiles(event.target.files)}
          />
          <button
            type="button"
            className="btn-ghost btn-xs"
            onClick={() => fileInput.current?.click()}
            disabled={attachments.length >= 3}
          >
            <Paperclip size={11} /> Attach
          </button>
          <button type="button" onClick={copy} className="btn-ghost btn-xs">
            {copied ? <Check size={11} /> : <Copy size={11} />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            className="btn-primary btn-sm ml-auto"
            onClick={send}
            disabled={!!pending || !body.trim() || !subject.trim() || !presentation.presentation}
          >
            {pending === "send" ? (
              <LoaderCircle size={12} className="spin" />
            ) : (
              <Send size={12} />
            )}
            {pending === "send"
              ? "Sending…"
              : sandbox
                ? "Record sandbox reply"
                : "Send reply"}
          </button>
        </div>
        <p className="text-12 leading-4 text-faint">
          Essential safeguards only: verified sender, suppression check,
          idempotent delivery, truthful sender identity and an unsubscribe footer.
          No Product Truth checkbox is required because you are reviewing the
          reply yourself.
        </p>
      </div>
    </div>
  );
}

export function SimulateReplyButton({
  conversationId,
  companyName,
}: {
  conversationId: string;
  companyName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(
    "Thanks for the note. Could you share how pricing works and whether this supports our current signal delivery setup?",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [aiMeta, setAiMeta] = useState<{ writtenBy: string | null; context: string; text: string } | null>(null);

  async function draftWithAi() {
    setDrafting(true);
    setError(null);
    try {
      const result = await apiRequest(`/api/conversations/${conversationId}/simulate-reply/draft`, { method: "POST" });
      setBody(result.body);
      setAiMeta({ writtenBy: writtenByLabel(result), context: result.context, text: result.body });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not draft a test reply.");
    } finally {
      setDrafting(false);
    }
  }

  async function simulate() {
    setPending(true);
    setError(null);
    try {
      await apiRequest(`/api/conversations/${conversationId}/simulate-reply`, {
        body: { body },
      });
      setOpen(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not simulate.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn-secondary btn-sm w-full"
        onClick={() => setOpen(true)}
      >
        <TestTube2 size={12} /> Simulate a test reply
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Simulate a reply from ${companyName}`}
        description="Sandbox only. This inserts a clearly labelled test message into the thread so you can test reply handling and follow-up cancellation without contacting anyone."
        width="md"
      >
        <div className="space-y-3">
          <Notice tone="sandbox">
            The message is stored with the sandbox flag and never leaves Growth.
            It is not a real prospect reply.
          </Notice>
          <div>
            <div className="flex flex-wrap items-end justify-between gap-2">
              <label className="label">Test message</label>
              <button type="button" className="btn-secondary btn-xs" onClick={draftWithAi} disabled={drafting || pending} data-simulate-ai>
                {drafting ? <LoaderCircle size={10} className="spin" /> : <WandSparkles size={10} />}
                {drafting ? "Writing as the prospect…" : "Draft with AI (as the prospect)"}
              </button>
            </div>
            <textarea
              className="textarea min-h-[130px]"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            {aiMeta && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-faint">
                <span data-written-by>{body === aiMeta.text ? aiMeta.writtenBy : `${aiMeta.writtenBy ?? "AI draft"} — edited by you`}</span>
                <ContextUsedLink context={aiMeta.context} />
              </div>
            )}
          </div>
          <InlineError>{error}</InlineError>
          <SubmitBar>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={simulate}
              disabled={pending || !body.trim()}
            >
              {pending ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}
              {pending ? "Inserting…" : "Insert test reply"}
            </button>
          </SubmitBar>
        </div>
      </Modal>
    </>
  );
}
