import { describe, expect, it } from "vitest";
import {
  extractUrls,
  shortenUrl,
  splitTextWithLinks,
} from "@/lib/email/message-links";

/**
 * The long-URL bug: a real tracking URL with no spaces stretched the message column and pushed the
 * reply panel off-screen. Wrapping is CSS, but drawing two thousand characters of URL is not, and
 * neither is the rule that the address behind a shortened link is still the whole address.
 */

/** A realistic offender: an unbroken tracking URL of exactly 2,000 characters. */
const LONG_URL = (() => {
  const prefix = "https://track.example-mailer.com/c/";
  const suffix = "/open";
  return `${prefix}${"a".repeat(2000 - prefix.length - suffix.length)}${suffix}`;
})();

describe("splitting a message body into text and links", () => {
  it("finds a link in the middle of a sentence", () => {
    const segments = splitTextWithLinks("See https://example.com/pricing for the plans.");
    expect(segments.map((segment) => segment.type)).toEqual(["text", "link", "text"]);
    expect(segments[1].href).toBe("https://example.com/pricing");
    expect(segments[2].text).toBe(" for the plans.");
  });

  it("keeps the sentence's punctuation outside the link", () => {
    const segments = splitTextWithLinks("Open (https://example.com/a).");
    expect(segments.find((segment) => segment.type === "link")?.href).toBe(
      "https://example.com/a",
    );
    expect(segments.at(-1)?.text).toBe(").");
  });

  it("never alters the stored text: joining the segments gives it back byte for byte", () => {
    const text = "First https://a.example.com/x?q=1 then https://b.example.org/y#z end";
    expect(splitTextWithLinks(text).map((segment) => segment.text).join("")).toBe(text);
  });

  it("returns plain text untouched when there is no URL", () => {
    const text = "Just a normal reply, no links here.";
    const segments = splitTextWithLinks(text);
    expect(segments).toEqual([{ type: "text", text }]);
  });

  it("handles a 2,000-character unbroken URL", () => {
    expect(LONG_URL.length).toBe(2000);
    const segments = splitTextWithLinks(`Tracking pixel: ${LONG_URL}`);
    const link = segments.find((segment) => segment.type === "link");
    expect(link?.href).toBe(LONG_URL);
  });

  it("ignores a bare scheme with nothing after it", () => {
    expect(extractUrls("broken https:// nothing")).toEqual([]);
  });

  it("lists every URL in order", () => {
    expect(extractUrls("a https://one.example.com b https://two.example.com")).toEqual([
      "https://one.example.com",
      "https://two.example.com",
    ]);
  });
});

describe("shortening a long URL for display", () => {
  it("leaves a short URL exactly as it is", () => {
    expect(shortenUrl("https://example.com/pricing")).toBe("https://example.com/pricing");
  });

  it("keeps the host and the end of a long one, and stays within the limit", () => {
    const shortened = shortenUrl(LONG_URL);
    expect(shortened.startsWith("track.example-mailer.com/…")).toBe(true);
    expect(shortened).toContain("…");
    expect(shortened.length).toBeLessThanOrEqual(64);
    // The end of the path is the part that identifies the page, so it survives the shortening.
    expect(shortened.endsWith("/open")).toBe(true);
    expect(shortened.length).toBeLessThan(LONG_URL.length);
  });

  it("still tells two long URLs on the same host apart", () => {
    const one = `https://track.example.com/c/${"a".repeat(200)}/one`;
    const two = `https://track.example.com/c/${"a".repeat(200)}/two`;
    expect(shortenUrl(one)).not.toBe(shortenUrl(two));
  });

  it("always shows the full address as the link target", () => {
    const segments = splitTextWithLinks(LONG_URL);
    expect(segments).toHaveLength(1);
    expect(segments[0].href).toBe(LONG_URL);
    expect(segments[0].text).toBe(LONG_URL);
  });
});
