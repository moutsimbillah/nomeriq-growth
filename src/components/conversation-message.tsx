"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Languages, Mail, Paperclip, Reply } from "lucide-react";
import { apiRequest } from "@/components/client-ui";
import { translationViewState } from "@/lib/email/translation-view";
import type { CachedTranslation } from "@/lib/services/message-translations";

export type MessageBodyKind = "body" | "excerpt" | "pending";

export interface ConversationMessageProps {
  messageId: string;
  inbound: boolean;
  fromName: string | null;
  fromEmail: string;
  subject: string;
  bodyKind: MessageBodyKind;
  /** The original text exactly as stored. Never altered, never sent anywhere by the flip. */
  originalText: string;
  isSandbox: boolean;
  external: boolean;
  deliveryStatus: string;
  timeLabel: string;
  attachments: { id?: string; filename: string }[];
  translation: CachedTranslation | null;
  /** Decided on the server, offline, from the text and any stored translation. */
  offersTranslation: boolean;
  latest: boolean;
}

/**
 * One message in a thread: header (who, when, the Translate control) and the body beneath it.
 *
 * Translating flips the body **in place** — the side panel is gone. The swap is between two strings
 * this component already holds, so it is instant and calls the AI exactly once; the server keeps the
 * cached row and serves it on the next render as `translation`. The original text is never rewritten
 * and "Show original" returns to it verbatim.
 */
export function ConversationMessage(props: ConversationMessageProps) {
  const {
    messageId,
    inbound,
    fromName,
    fromEmail,
    subject,
    bodyKind,
    originalText,
    isSandbox,
    external,
    deliveryStatus,
    timeLabel,
    attachments,
    offersTranslation,
    latest,
  } = props;

  const router = useRouter();
  const [translation, setTranslation] = useState<CachedTranslation | null>(props.translation);
  const [showingOriginal, setShowingOriginal] = useState(
    props.translation?.status !== "translated",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // All the flip logic lives in one pure function, so the rules are tested without a renderer.
  const view = translationViewState({
    original: originalText,
    stored: translation,
    showingOriginal,
    offers: offersTranslation,
  });

  async function translate() {
    setPending(true);
    setError(null);
    try {
      const outcome = await apiRequest(`/api/email/messages/${messageId}/translate`, {
        method: "POST",
      });
      if (outcome.ok) {
        const fresh = outcome.translation as CachedTranslation;
        setTranslation(fresh);
        setShowingOriginal(fresh.status !== "translated");
        router.refresh();
      } else {
        setError(outcome.reason);
      }
    } catch {
      setError("Translation failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <article
      className={`relative rounded-[18px] border p-5 ${
        inbound ? "border-amber/15 bg-[#fffaf0]" : "border-line bg-panel"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={`grid h-7 w-7 place-items-center rounded-full ${
              inbound ? "bg-amber/15 text-amber" : "bg-forest text-lime"
            }`}
          >
            {inbound ? <Reply size={12} /> : <Mail size={12} />}
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2 text-12 font-bold uppercase tracking-[0.1em] text-faint">
              {inbound ? "Received" : "Sent"}
              {isSandbox && (
                <span className="rounded-full bg-amber/10 px-1.5 py-0.5 text-12 text-amber">
                  sandbox
                </span>
              )}
              {external && (
                <span className="rounded-full bg-ink/[0.05] px-1.5 py-0.5 text-12">
                  synced from IONOS
                </span>
              )}
            </div>
            <div className="mt-0.5 text-12 text-ink">
              {fromName ? `${fromName} · ` : ""}
              {fromEmail}
            </div>
          </div>
        </div>
        {/* The Translate control sits beside the date, and only for a message that is not English. */}
        <div className="flex flex-wrap items-center justify-end gap-2 text-right text-12 text-faint">
          {view.showTranslateButton && (
            <button
              type="button"
              onClick={translate}
              disabled={pending}
              className="btn-secondary btn-xs whitespace-nowrap"
              title="Translate this message to English. The original text is kept."
            >
              <Languages size={10} />
              {pending ? "Translating…" : "Translate"}
            </button>
          )}
          <div>
            {timeLabel}
            {!inbound && (
              <div className="mt-0.5">{isSandbox ? "not delivered" : deliveryStatus}</div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 border-t border-line/60 pt-3">
        <div className="mb-2 text-12 font-semibold text-ink">{subject}</div>

        {view.showingTranslation && (
          <p className="mb-1.5 flex flex-wrap items-center gap-1.5 text-12 text-muted">
            <span>{view.translatedLabel}</span>
            <span className="text-faint">·</span>
            <button
              type="button"
              onClick={() => setShowingOriginal(true)}
              className="font-semibold text-ink underline underline-offset-4"
            >
              Show original
            </button>
          </p>
        )}
        {inbound && !view.showingTranslation && bodyKind !== "pending" && (
          <p className="mb-1.5 text-12 font-semibold text-ink">Original</p>
        )}

        <div className={bodyKind === "body" ? "email-body" : "email-body text-muted"}>
          {view.text}
        </div>

        {bodyKind === "excerpt" && (
          <p className="mt-1 text-12 text-faint">
            {view.showingTranslation
              ? "Translated from an excerpt — the full message appears when the mailbox is connected."
              : "Excerpt only — the full message appears when the mailbox is connected."}
          </p>
        )}

        {error && (
          <p role="status" className="mt-2 text-12 text-rust">
            {error}{" "}
            <button type="button" onClick={translate} disabled={pending} className="underline">
              Retry
            </button>
          </p>
        )}

        {attachments.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5 border-t border-line/60 pt-3">
            {attachments.map((attachment, attachmentIndex) =>
              attachment.id ? (
                <a
                  key={attachment.id}
                  href={`/api/email/attachments/${attachment.id}`}
                  className="badge hover:border-ink/25 hover:text-ink"
                >
                  <Paperclip size={9} /> {attachment.filename}
                </a>
              ) : (
                <span key={attachmentIndex} className="badge">
                  <Paperclip size={9} /> {attachment.filename}
                </span>
              ),
            )}
          </div>
        )}
      </div>

      {/* Newest first: the first card is the latest message in the thread. */}
      {latest && (
        <div className="absolute -bottom-2.5 left-5 rounded-full border border-amber/20 bg-[#fffaf0] px-2 py-0.5 text-12 font-semibold uppercase tracking-[0.1em] text-amber">
          Latest
        </div>
      )}
    </article>
  );
}
