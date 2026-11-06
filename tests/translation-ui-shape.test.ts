import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The shape of the translation control, pinned so a later edit cannot quietly restore the old one.
 *
 * Item 0 asked for three things that are visible in the files themselves: the side panel is gone, the
 * Translate button sits in the message header beside the date, and the thread renders one message
 * component that owns both. Behaviour is covered by `translation-view.test.ts` and
 * `language-detect.test.ts`; this file covers the layout contract.
 */

const THREAD = "src/app/(app)/email/[id]/page.tsx";
const MESSAGE = "src/components/conversation-message.tsx";

const thread = readFileSync(THREAD, "utf8");
const message = readFileSync(MESSAGE, "utf8");

describe("the side panel is gone", () => {
  it("has no separate translation panel component", () => {
    // The old component rendered an <aside> beside the body; it must not come back.
    expect(existsSync("src/components/message-translation.tsx")).toBe(false);
  });

  it("renders the thread with no <aside> translation panel", () => {
    expect(thread).not.toContain("<aside");
    expect(thread).not.toContain("MessageTranslation");
    expect(message).not.toContain("<aside");
  });

  it("no longer lays the original and the translation out in two columns", () => {
    // The old body used `lg:grid-cols-2` to put the panel beside the message.
    expect(thread).not.toContain("lg:grid-cols-2");
  });
});

describe("the Translate button sits in the message header", () => {
  it("renders it in the same row as the date", () => {
    // One header row: the sender block on the left, the button and the timestamp on the right.
    const headerRow = message.indexOf('flex flex-wrap items-start justify-between gap-2');
    const button = message.indexOf("view.showTranslateButton");
    const timestamp = message.indexOf("{timeLabel}");
    expect(headerRow).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(headerRow);
    expect(timestamp).toBeGreaterThan(button);
    // ...and all of it is before the body, which starts at the divider under the header.
    expect(message.indexOf("mt-4 border-t border-line/60 pt-3")).toBeGreaterThan(timestamp);
  });

  it("only offers it when the message is not in English", () => {
    expect(message).toContain("view.showTranslateButton");
    // The decision itself is server-side and offline; the thread passes it in.
    expect(thread).toContain("offersTranslation={translationOffered({");
    expect(thread).toContain('text: body.kind === "pending" ? "" : body.text');
  });

  it("labels a translated body and offers Show original as a header button, both ways", () => {
    expect(message).toContain("view.translatedLabel");
    expect(message).toContain("data-translated-badge");
    // One header button flips both ways, in the same style as Translate.
    expect(message).toContain("data-translation-flip");
    expect(message).toContain('"Show original" : "Show translation"');
    expect(message).toContain("onClick={() => setShowingOriginal(view.showingTranslation)}");
    // Who produced the translation is shown under the body.
    expect(message).toContain("view.producedBy");
  });

  it("flips the body in place from one text value", () => {
    // A single body node renders `view.text`; there is no second copy of the message alongside it.
    expect(message).toContain("{view.text}");
    expect(message).not.toContain("{originalText}");
  });

  it("calls the translate route, which is the only thing that reaches the AI", () => {
    expect(message).toContain("/api/email/messages/${messageId}/translate");
    expect(message).toContain("router.refresh()");
  });
});

describe("every message in the thread is drawn the same way", () => {
  it("maps the whole thread through the one component, so quoted text follows the same rules", () => {
    const map = thread.indexOf("conversation.messages.map(");
    expect(map).toBeGreaterThan(-1);
    expect(thread.slice(map)).toContain("<ConversationMessage");
    // Quoted earlier text lives inside each message body, so it flips with its own message.
    expect(message).toContain("email-body");
  });
});