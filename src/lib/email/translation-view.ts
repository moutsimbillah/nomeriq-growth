import type { CachedTranslation } from "@/lib/services/message-translations";

/**
 * The pure decisions behind the in-place translation flip.
 *
 * Kept out of the React component so they can be tested directly: the component only renders what
 * these return, and the rules that matter — the original is always available verbatim, a stored
 * translation is shown without another call, and English messages offer no control at all — are
 * decided here.
 */

export interface TranslationViewState {
  /** The text to put in the body right now. */
  text: string;
  /** True when the body currently shows the translation rather than the original. */
  showingTranslation: boolean;
  /** True when the header offers a Translate button. */
  showTranslateButton: boolean;
  /** The `Translated from <language> · Show original` line, or null when the body is the original. */
  translatedLabel: string | null;
  /** "Translated by <provider> · <model>", whenever a stored translation exists. */
  producedBy: string | null;
  /** True when a stored translation exists, so the header can offer Show original / Show translation. */
  canFlip: boolean;
}

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * What the message should render.
 *
 * `stored` is the cached translation the server already sent (null when there is none), and
 * `showingOriginal` is the founder's current choice. The original text is returned untouched
 * whenever the translation is not being shown, so flipping back is always the exact text that
 * arrived.
 */
export function translationViewState(input: {
  original: string;
  stored: CachedTranslation | null;
  showingOriginal: boolean;
  /** Whether the server decided this message is worth offering a translation for. */
  offers: boolean;
}): TranslationViewState {
  const stored = input.stored?.status === "translated" ? input.stored : null;
  // A blank translation would empty the message, which is worse than showing the original.
  const translated = stored && stored.translatedText.trim().length > 0 ? stored : null;
  const english = input.stored?.status === "english";
  const producedBy = translated
    ? `Translated by ${[translated.provider, translated.model].filter((part) => part && String(part).trim()).join(" · ") || "an AI provider"}`
    : null;

  if (translated && !input.showingOriginal) {
    const language = translated.sourceLanguage
      ? languageName(translated.sourceLanguage) || translated.sourceLanguage
      : "";
    return {
      text: translated.translatedText,
      showingTranslation: true,
      showTranslateButton: false,
      translatedLabel: language ? `Translated from ${language}` : "Translated",
      producedBy,
      canFlip: true,
    };
  }

  return {
    text: input.original,
    showingTranslation: false,
    // An English result settles it: the provider said so, so no button. Otherwise the server's hint
    // decides, and it has already excluded outbound messages and empty bodies.
    // With a stored translation the header offers "Show translation" instead of a second Translate.
    showTranslateButton: input.offers && !english && !translated,
    translatedLabel: null,
    producedBy,
    canFlip: Boolean(translated),
  };
}