/**
 * Turning URLs inside a message body into displayable links.
 *
 * The bug this exists for: a real tracking URL with no spaces in it (2,000 characters is
 * realistic) made the message column grow instead of wrapping, which pushed the reply panel off
 * the screen. Two things are needed, and they are separate concerns:
 *
 *   1. never let the text impose a minimum width — that is CSS (`overflow-wrap: anywhere` plus
 *      `min-w-0` on the grid children), and it is what actually stops the column stretching;
 *   2. never draw 2,000 characters of URL as visible text — that is this module.
 *
 * So a long URL is displayed shortened (host + "…" + the end of the path) while `href` keeps the
 * full address, so the link still opens the real page. The shortening is deterministic and pure so
 * it can be asserted in a test; the segmentation keeps the original text byte-for-byte, so nothing
 * in a stored message is ever altered by being displayed.
 */

/** Matches http/https URLs and stops at whitespace or a character that cannot be in a URL here. */
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;

/** Punctuation that usually belongs to the sentence, not to the URL. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

export interface TextSegment {
  type: "text" | "link";
  /** Exactly the characters from the source text. */
  text: string;
  /** Present on a link segment: the full, unshortened address. */
  href?: string;
}

/**
 * Split text into plain runs and URLs. Joining every segment's `text` reproduces the input
 * exactly, which is what keeps displaying a message from altering it.
 */
export function splitTextWithLinks(text: string): TextSegment[] {
  if (typeof text !== "string" || text.length === 0) return [];

  const segments: TextSegment[] = [];
  URL_PATTERN.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = URL_PATTERN.exec(text)) !== null) {
    let url = match[0];
    let trailing = "";

    // A URL at the end of a sentence arrives as "https://x/y)." — keep the punctuation as text.
    const punctuation = TRAILING_PUNCTUATION.exec(url);
    if (punctuation) {
      trailing = punctuation[0];
      url = url.slice(0, url.length - trailing.length);
    }

    // A bare "https://" is not a link worth drawing.
    if (url.length > "https://".length) {
      if (match.index > cursor) {
        segments.push({ type: "text", text: text.slice(cursor, match.index) });
      }
      segments.push({ type: "link", text: url, href: url });
      if (trailing) segments.push({ type: "text", text: trailing });
      cursor = match.index + match[0].length;
    }
  }

  if (cursor < text.length) {
    segments.push({ type: "text", text: text.slice(cursor) });
  }
  return segments;
}

/** Every URL in the text, in order, without surrounding punctuation. */
export function extractUrls(text: string): string[] {
  return splitTextWithLinks(text)
    .filter((segment) => segment.type === "link")
    .map((segment) => segment.href as string);
}

/**
 * Host plus the tail of the path, with a "…" where the middle was: short enough to read, long
 * enough that two URLs to the same host are still distinguishable. The result never exceeds
 * `maxLength`.
 */
export function shortenUrl(url: string, maxLength = 64): string {
  if (typeof url !== "string" || url.length <= maxLength) return url;
  if (maxLength < 8) return "…";

  const scheme = url.startsWith("https://") ? "https://" : "http://";
  const withoutScheme = url.slice(scheme.length);
  const firstSlash = withoutScheme.indexOf("/");
  const host = firstSlash === -1 ? withoutScheme : withoutScheme.slice(0, firstSlash);
  const rest = firstSlash === -1 ? "" : withoutScheme.slice(firstSlash);

  // Keep the end of the path: it is the part that usually identifies the page or the campaign.
  const room = maxLength - host.length - 2; // the ellipsis and the leading slash of the tail
  if (room <= 1) return `${host.slice(0, maxLength - 1)}…`;

  const tail = rest.length > room ? rest.slice(rest.length - room) : rest;
  const shortened = `${host}/…${tail.replace(/^\//, "")}`;
  return shortened.length <= maxLength ? shortened : `${shortened.slice(0, maxLength - 1)}…`;
}
