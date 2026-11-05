/**
 * Local, offline language hinting for the translation control.
 *
 * The Translate button must appear only on messages that are **not** in English, and deciding that
 * must not cost an AI call, a network round trip or money: a thread of 40 messages would otherwise
 * bill 40 classifications just to render a header. So the hint is computed from the text itself.
 *
 * Two independent signals:
 *  1. **Script.** Arabic, Hebrew, Cyrillic, Greek, Devanagari, Thai, Han, Kana and Hangul are
 *     unambiguous — a message written in one of them is not English, whatever else it contains.
 *  2. **English-ness of Latin text.** Latin letters are shared by most European languages, so the
 *     only honest offline test is the proportion of high-frequency English function words. A
 *     message that is mostly words like "the", "and", "for", "your" is English; a short reply or a
 *     signature is not confidently anything.
 *
 * The result is deliberately conservative and is only ever used to *offer* a translation:
 * `null` (unknown) offers the button, because a missing translation is a dead end for the reader
 * while an unneeded button costs one click. The provider's own detection is what actually names the
 * language once the founder asks for it.
 */

/** Script ranges that cannot be English, most specific first. */
const SCRIPTS: { code: string; label: string; test: RegExp }[] = [
  { code: "ar", label: "Arabic", test: /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/ },
  { code: "he", label: "Hebrew", test: /[\u0590-\u05FF\uFB1D-\uFB4F]/ },
  { code: "el", label: "Greek", test: /[\u0370-\u03FF\u1F00-\u1FFF]/ },
  { code: "ru", label: "Cyrillic", test: /[\u0400-\u04FF\u0500-\u052F]/ },
  { code: "hi", label: "Devanagari", test: /[\u0900-\u097F]/ },
  { code: "th", label: "Thai", test: /[\u0E00-\u0E7F]/ },
  { code: "ko", label: "Hangul", test: /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/ },
  { code: "ja", label: "Kana", test: /[\u3040-\u30FF]/ },
  { code: "zh", label: "Han", test: /[\u4E00-\u9FFF\u3400-\u4DBF]/ },
];

/** Words that make a Latin-script message English with high confidence. */
const ENGLISH_STOPWORDS = new Set([
  "the", "and", "you", "your", "yours", "for", "with", "that", "this", "have", "has", "had",
  "from", "our", "ours", "we", "are", "is", "was", "were", "be", "been", "will", "would", "can",
  "could", "should", "not", "but", "about", "into", "over", "after", "before", "when", "where",
  "which", "who", "how", "why", "what", "there", "their", "them", "they", "his", "her", "its",
  "it", "of", "to", "in", "on", "at", "as", "if", "or", "an", "a", "i", "my", "me", "please",
  "thanks", "thank", "regards", "best", "hi", "hello", "dear", "let", "know", "get", "got",
  "send", "sent", "email", "us", "am", "do", "does", "did", "so", "than", "then", "also", "just",
]);

/**
 * A minimum of countable words before the stopword ratio means anything. Two is enough for a
 * signature ("Best regards, Moutsim" is English) while still refusing to classify a single word,
 * which is handled separately below.
 */
const MIN_WORDS_FOR_RATIO = 2;
/** Share of English function words in a Latin-script message that makes it English. */
const ENGLISH_RATIO = 0.12;

export interface LanguageHint {
  /** A BCP 47 / ISO 639-1 code when the hint identified one, otherwise null. */
  code: string | null;
  /** True when {@link LanguageHint.code} is trustworthy, false when it is a guess or null. */
  confident: boolean;
}

/**
 * A cheap, offline guess at the language of `text`. Never throws, never calls out.
 *
 * Returns `{ code: "en", confident: true }` only for text that really reads as English, an
 * unambiguous script code for the non-Latin scripts, and `{ code: null, confident: false }`
 * otherwise.
 */
export function detectLanguageHint(text: string | null | undefined): LanguageHint {
  const value = typeof text === "string" ? text : "";
  if (value.trim().length === 0) return { code: null, confident: false };

  for (const script of SCRIPTS) {
    if (script.test.test(value)) return { code: script.code, confident: true };
  }

  const words = value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s'-]+/gu, " ")
    .split(/\s+/)
    .filter((word) => /[a-z]/.test(word));
  if (words.length === 0) return { code: null, confident: false };

  const stopwords = words.filter((word) => ENGLISH_STOPWORDS.has(word)).length;
  const ratio = words.length >= MIN_WORDS_FOR_RATIO ? stopwords / words.length : 0;
  if (ratio >= ENGLISH_RATIO || (words.length === 1 && ENGLISH_STOPWORDS.has(words[0]))) {
    return { code: "en", confident: true };
  }
  // Latin letters, no English shape: probably another Latin-script language (Spanish, German,
  // Indonesian, Turkish...). We cannot name it offline, so we say so rather than guess wrong.
  return { code: null, confident: false };
}

/**
 * Whether a message should offer the Translate control.
 *
 * A stored translation settles the question without any detection at all: the provider already
 * answered it. Failing that, the local hint decides, and "not confidently English" offers the
 * button. An outbound message or one with no text at all never offers it — Growth translates what
 * a prospect wrote to us, not what we wrote.
 */
export function translationOffered(input: {
  direction: "inbound" | "outbound";
  text: string;
  cachedStatus?: "translated" | "english" | null;
}): boolean {
  if (input.direction !== "inbound") return false;
  if (input.text.trim().length === 0) return false;
  if (input.cachedStatus === "english") return false;
  if (input.cachedStatus === "translated") return true;
  return detectLanguageHint(input.text).code !== "en";
}
