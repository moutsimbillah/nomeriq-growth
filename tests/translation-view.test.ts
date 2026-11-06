import { describe, expect, it } from "vitest";
import { translationViewState } from "@/lib/email/translation-view";
import type { CachedTranslation } from "@/lib/services/message-translations";

/**
 * The in-place flip that replaced the side panel.
 *
 * Four rules from item 0, each of which a reader would notice immediately if it broke:
 * the body flips to the translation, the label names the language and offers "Show original",
 * flipping back gives the exact original text, and an English message offers no button at all.
 */

const arabic: CachedTranslation = {
  messageId: "m1",
  sourceLanguage: "ar",
  translatedText: "Hello, what does the subscription cost?",
  provider: "fixture",
  model: "fixture",
  status: "translated",
  cached: true,
};

const english: CachedTranslation = {
  messageId: "m2",
  sourceLanguage: "en",
  translatedText: "Thanks, this looks interesting.",
  provider: "fixture",
  model: "fixture",
  status: "english",
  cached: true,
};

const ORIGINAL = "مرحبا، ما هو سعر الاشتراك؟";

describe("the body flips in place", () => {
  it("shows the original when nothing has been translated yet", () => {
    const view = translationViewState({
      original: ORIGINAL,
      stored: null,
      showingOriginal: true,
      offers: true,
    });
    expect(view.text).toBe(ORIGINAL);
    expect(view.showingTranslation).toBe(false);
    expect(view.showTranslateButton).toBe(true);
    expect(view.translatedLabel).toBeNull();
  });

  it("shows the stored translation immediately, without asking the AI again", () => {
    // `cached: true` is how a stored row arrives: flipping to it costs no provider call.
    const view = translationViewState({
      original: ORIGINAL,
      stored: arabic,
      showingOriginal: false,
      offers: true,
    });
    expect(view.text).toBe(arabic.translatedText);
    expect(view.showingTranslation).toBe(true);
    expect(view.showTranslateButton).toBe(false);
  });

  it("labels the translation with its language and offers Show original", () => {
    const view = translationViewState({
      original: ORIGINAL,
      stored: arabic,
      showingOriginal: false,
      offers: true,
    });
    expect(view.translatedLabel).toBe("Translated from Arabic");
  });

  it("flips back to the exact original text, never a copy of the translation", () => {
    const view = translationViewState({
      original: ORIGINAL,
      stored: arabic,
      showingOriginal: true,
      offers: true,
    });
    expect(view.text).toBe(ORIGINAL);
    expect(view.showingTranslation).toBe(false);
    expect(view.translatedLabel).toBeNull();
    // Flipping back leaves the way to flip forward again: "Show translation" serves the cached row,
    // so there is no second Translate button that could call the AI again.
    expect(view.canFlip).toBe(true);
    expect(view.showTranslateButton).toBe(false);
    expect(view.producedBy).toMatch(/^Translated by /);
  });
});

describe("an English message gets no button", () => {
  it("offers nothing when the provider already said the message is English", () => {
    const view = translationViewState({
      original: "Thanks, this looks interesting.",
      stored: english,
      showingOriginal: true,
      offers: true,
    });
    expect(view.showTranslateButton).toBe(false);
    expect(view.showingTranslation).toBe(false);
    expect(view.text).toBe("Thanks, this looks interesting.");
  });

  it("offers nothing when the server's hint says the message is English", () => {
    // The hint is decided server-side (offline) by `translationOffered`, and it excludes English.
    const view = translationViewState({
      original: "Can you send the pricing?",
      stored: null,
      showingOriginal: true,
      offers: false,
    });
    expect(view.showTranslateButton).toBe(false);
  });
});

describe("flipping never invents text", () => {
  it("falls back to the original when a translation row is missing its text", () => {
    const view = translationViewState({
      original: ORIGINAL,
      stored: { ...arabic, translatedText: "" },
      showingOriginal: false,
      offers: true,
    });
    // An empty translation string would blank the message; the original is the honest fallback.
    expect(view.text).toBe(ORIGINAL);
    expect(view.showingTranslation).toBe(false);
  });

  it("names no language when the provider did not report one", () => {
    const view = translationViewState({
      original: ORIGINAL,
      stored: { ...arabic, sourceLanguage: "" },
      showingOriginal: false,
      offers: true,
    });
    expect(view.translatedLabel).toBe("Translated");
  });
});