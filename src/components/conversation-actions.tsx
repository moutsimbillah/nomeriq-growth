"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<
    { filename: string; contentType: string; dataBase64: string; size: number }[]
  >([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [suggestionNote, setSuggestionNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function suggest() {
    setPending("suggest");
    setError(null);
    setSuggestionNote(null);
    try {
      const result = await apiRequest(
        `/api/conversations/${conversationId}/suggest-reply`,
        { method: "POST" },
      );
      if (result.body) {
        setSubject(result.subject || defaultSubject);
        setBody(result.body);
        setSuggestionNote(
          result.note ||
            (result.usedAi
              ? "AI suggestion inserted. Edit anything before sending."
              : "Draft suggestion inserted. This is not a generic pitch; review it against the real thread."),
        );
      } else {
        setSuggestionNote(result.note || "No suggestion available.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not suggest a reply.");
    } finally {
      setPending(null);
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
    await navigator.clipboard.writeText(`To: ${recipient}\nSubject: ${subject}\n\n${body}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
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
    <div className="card overflow-hidden">
      <div className="border-b border-line px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Send size={14} className="text-muted" />
              <h2 className="text-13 font-bold text-ink">Write reply</h2>
            </div>
            <p className="mt-0.5 text-12 text-faint">
              To {recipient} · your click sends the reviewed version
            </p>
          </div>
          <button
            type="button"
            onClick={suggest}
            className="btn-secondary btn-xs"
            disabled={!!pending}
          >
            {pending === "suggest" ? (
              <LoaderCircle size={10} className="spin" />
            ) : (
              <WandSparkles size={10} />
            )}
            {body ? "Suggest again" : "Suggest with AI"}
          </button>
        </div>
      </div>

      <div className="space-y-3 p-5">
        <div>
          <label className="label">Subject</label>
          <input
            className="input"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>
        <div>
          <label className="label">Message</label>
          <textarea
            className="textarea min-h-[240px] bg-[#fffefb]"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Write a real answer to their message. Or generate a suggestion and edit it."
          />
        </div>

        {suggestionNote && (
          <div className="rounded-lg border border-line bg-lime/10 px-2.5 py-2 text-12 leading-4 text-forest">
            {suggestionNote}
          </div>
        )}

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
            disabled={!!pending || !body.trim() || !subject.trim()}
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
            <label className="label">Test message</label>
            <textarea
              className="textarea min-h-[130px]"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
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
