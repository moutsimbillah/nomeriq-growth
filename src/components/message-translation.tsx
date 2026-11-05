"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiRequest } from "@/components/client-ui";
import type { CachedTranslation } from "@/lib/services/message-translations";

type Props = {
  messageId: string;
  initialTranslation?: CachedTranslation | null;
  excerpt?: boolean;
};

function languageName(code: string) {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function MessageTranslation({ messageId, initialTranslation, excerpt }: Props) {
  const router = useRouter();
  const [translation, setTranslation] = useState<CachedTranslation | null>(initialTranslation ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setTranslation(initialTranslation ?? null), [initialTranslation]);

  async function translate() {
    setPending(true);
    setError(null);
    try {
      const outcome = await apiRequest(`/api/email/messages/${messageId}/translate`, { method: "POST" });
      if (outcome.ok) {
        setTranslation(outcome.translation as CachedTranslation);
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

  const language = translation?.sourceLanguage ?? "";
  return (
    <aside className="rounded-xl border border-line bg-paper/40 p-3">
      {!translation ? (
        <div className="flex flex-col gap-2">
          <button type="button" onClick={translate} disabled={pending} className="btn-secondary btn-xs self-start">
            {pending ? "Translating…" : "Translate"}
          </button>
          <p className="text-12 text-muted">Translate to English on demand.</p>
        </div>
      ) : translation.status === "english" ? (
        <p className="text-12 text-muted">Already in English</p>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-12 text-muted">Machine translation from {languageName(language)}</p>
          <p className="whitespace-pre-wrap break-words text-13 text-ink">{translation.translatedText}</p>
          {excerpt && <p className="text-12 text-muted">Excerpt only</p>}
        </div>
      )}
      {error && (
        <p role="status" className="mt-2 text-12 text-rust">
          {error}{" "}
          <button type="button" onClick={translate} disabled={pending} className="underline">
            Retry
          </button>
        </p>
      )}
    </aside>
  );
}
