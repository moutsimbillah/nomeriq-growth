"use client";

import { useEffect, useState } from "react";
import { draftBodyOnly, draftEditorBody, previewEmailContent } from "@/lib/email/message-content";
import type { EmailPresentation } from "@/lib/services/email-presentation";

const CHANGE_EVENT = "growth-email-identity-changed";
export function notifyEmailIdentityChanged() {
  window.dispatchEvent(new Event(CHANGE_EVENT));
  try { localStorage.setItem(CHANGE_EVENT, crypto.randomUUID()); } catch { /* Storage can be disabled. */ }
}

/** Refresh presentation, not the editable body. A setting change never overwrites founder edits. */
export function useEmailPresentation(input: { prospectId?: string; conversationId?: string }, enabled = true) {
  const [presentation, setPresentation] = useState<EmailPresentation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = input.conversationId ? `conversationId=${encodeURIComponent(input.conversationId)}` : `prospectId=${encodeURIComponent(input.prospectId ?? "")}`;
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let sequence = 0;
    async function refresh() {
      const current = ++sequence;
      try {
        const response = await fetch(`/api/email-presentation?${query}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Could not load the current signature/address. Refresh before sending or copying.");
        const result = await response.json();
        if (active && current === sequence) { setPresentation(result.data); setError(null); }
      } catch (caught) {
        if (active && current === sequence) { setPresentation(null); setError(caught instanceof Error ? caught.message : "Could not load email presentation."); }
      }
    }
    const update = () => { void refresh(); };
    const storage = (event: StorageEvent) => { if (event.key === CHANGE_EVENT) update(); };
    update();
    window.addEventListener("focus", update);
    window.addEventListener(CHANGE_EVENT, update);
    window.addEventListener("storage", storage);
    return () => { active = false; window.removeEventListener("focus", update); window.removeEventListener(CHANGE_EVENT, update); window.removeEventListener("storage", storage); };
  }, [query, enabled]);
  const cleanBody = (body: string) => presentation ? draftBodyOnly(body, [presentation.settings.senderSignature, presentation.profileSignature]) : body;
  const editorBody = (body: string, edited: boolean) => presentation
    ? draftEditorBody(body, [presentation.settings.senderSignature, presentation.profileSignature], edited) : body;
  const content = (body: string) => presentation ? previewEmailContent(body, presentation.settings, presentation.profileSignature) : null;
  return { presentation, error, cleanBody, editorBody, content };
}

export function EmailIdentityPreview({ content, error }: { content: string | null; error: string | null }) {
  return <div className="mt-3 rounded-lg border border-line bg-paper/40 p-3" data-email-presentation>
    <div className="text-12 font-semibold uppercase text-faint">Email preview · current Settings</div>
    <div className="mt-2 whitespace-pre-wrap text-12 text-ink" data-email-presentation-content>{content ?? error ?? "Loading current signature and address…"}</div>
    <p className="mt-2 text-12 text-faint">The signature/address above are managed by Settings, not saved into your message. The recipient-specific unsubscribe link is added at send.</p>
  </div>;
}
