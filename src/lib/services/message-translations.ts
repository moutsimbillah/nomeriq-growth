import { createHash } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { translateToEnglish } from "@/lib/ai/translation";

export interface CachedTranslation {
  messageId: string;
  sourceLanguage: string;
  translatedText: string;
  provider: string;
  model: string | null;
  status: "translated" | "english";
  cached: boolean;
}
export type TranslationOutcome =
  | { ok: true; translation: CachedTranslation; cached: boolean }
  | { ok: false; code: string; reason: string };
type MessageRow = { direction: string; body_text: string | null; snippet: string | null };
type TranslationRow = Record<"source_hash" | "source_language" | "translated_text" | "provider" | "status", string> & {
  model: string | null;
};

// Tagged, exact source: an excerpt row goes stale once its full body arrives.
function selectSource(m: Pick<MessageRow, "body_text" | "snippet">) {
  const body = m.body_text ?? "";
  if (body.trim()) return { hashed: `body:${body}`, original: body };
  const snippet = m.snippet ?? "";
  return snippet.trim() ? { hashed: `excerpt:${snippet}`, original: snippet } : null;
}
const hashSource = (hashed: string) => createHash("sha256").update(hashed).digest("hex");
function mapRow(messageId: string, row: TranslationRow, cached: boolean): CachedTranslation {
  return {
    messageId,
    sourceLanguage: row.source_language,
    translatedText: row.translated_text,
    provider: row.provider,
    model: row.model ?? null,
    status: row.status === "english" ? "english" : "translated",
    cached,
  };
}

/** Reads the stored translation. Never calls the AI provider. */
export async function getMessageTranslation(id: string): Promise<CachedTranslation | null> {
  const db = await getDb();
  const { rows } = await db.query<MessageRow & Partial<TranslationRow>>(
    `SELECT m.body_text, m.snippet, m.direction, t.*
       FROM messages m
       LEFT JOIN message_translations t ON t.message_id = m.id
      WHERE m.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row || row.direction !== "inbound" || !row.source_hash) return null;
  const source = selectSource(row);
  if (!source || hashSource(source.hashed) !== row.source_hash) return null;
  return mapRow(id, row as TranslationRow, true);
}

/** Translates one inbound message through the provider, then caches it. */
export async function translateMessage(id: string): Promise<TranslationOutcome> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<MessageRow>(`SELECT * FROM messages WHERE id = $1 FOR UPDATE`, [id]);
    const message = rows[0];
    if (!message) return { ok: false, code: "not_found", reason: "Message not found." };
    if (message.direction !== "inbound")
      return { ok: false, code: "not_inbound", reason: "Only inbound messages are translated." };
    const source = selectSource(message);
    if (!source) return { ok: false, code: "empty", reason: "Message has no text to translate." };
    const sourceHash = hashSource(source.hashed);

    const stored = (
      await tx.query<TranslationRow>(`SELECT * FROM message_translations WHERE message_id = $1`, [id])
    ).rows[0];
    if (stored && stored.source_hash === sourceHash)
      return { ok: true, translation: mapRow(id, stored, true), cached: true };

    // Registry reads share the locked transaction, avoiding a second-client queue deadlock in PGlite.
    const translated = await translateToEnglish(source.original, tx);
    if (!translated.ok) return { ok: false, code: translated.code, reason: translated.reason };

    const saved = (
      await tx.query<TranslationRow>(
        `INSERT INTO message_translations
           (message_id, source_hash, source_language, translated_text, provider, model, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (message_id) DO UPDATE SET
           source_hash = EXCLUDED.source_hash,
           source_language = EXCLUDED.source_language,
           translated_text = EXCLUDED.translated_text,
           provider = EXCLUDED.provider,
           model = EXCLUDED.model,
           status = EXCLUDED.status,
           updated_at = now()
         RETURNING *`,
        [id, sourceHash, translated.sourceLanguage, translated.translatedText, translated.provider,
         translated.model ?? null, translated.isEnglish ? "english" : "translated"],
      )
    ).rows[0];
    if (!saved) return { ok: false, code: "save_failed", reason: "Translation could not be saved." };
    return { ok: true, translation: mapRow(id, saved, false), cached: false };
  });
}

/**
 * Best-effort automatic translation on arrival. Item 4 requires the arrival path
 * to translate only "if cheap", so: skip entirely when no provider is configured,
 * and never let a provider failure (or a rejected promise) reach the caller --
 * ingest must not fail because translation could not run.
 * The provider and translate function are injectable so this stays unit-testable
 * without a database or a network call.
 */
export async function translateOnArrival(
  id: string,
  deps: { provider?: string; translate?: (messageId: string) => Promise<TranslationOutcome> } = {},
): Promise<void> {
  const provider = (deps.provider ?? process.env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (provider === "" || provider === "none") return;
  const translate = deps.translate ?? translateMessage;
  try {
    await translate(id);
  } catch {
    // Swallowed on purpose: the automatic path is a convenience, never a gate.
  }
}
