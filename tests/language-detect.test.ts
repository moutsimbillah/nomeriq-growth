import { describe, expect, it } from "vitest";
import {
  detectLanguageHint,
  translationOffered,
} from "@/lib/ai/language-detect";

/**
 * The Translate button's visibility is decided here, offline, so a thread never costs one AI call
 * per message. The two failure modes matter in opposite ways: a button on an English message wastes
 * a click, a missing button on a foreign message leaves the founder unable to read the reply at all.
 * These tests pin both edges, and the script cases pin the ones where guessing is unacceptable.
 */

describe("language hint from script", () => {
  it("recognises the non-Latin scripts a signals prospect actually writes in", () => {
    expect(detectLanguageHint("مرحبا، ما هو سعر الاشتراك؟")).toEqual({ code: "ar", confident: true });
    expect(detectLanguageHint("שלום, מה המחיר?")).toEqual({ code: "he", confident: true });
    expect(detectLanguageHint("Здравствуйте, какая цена?")).toEqual({ code: "ru", confident: true });
    expect(detectLanguageHint("Γεια σας, ποια είναι η τιμή;")).toEqual({ code: "el", confident: true });
    expect(detectLanguageHint("नमस्ते, कीमत क्या है?")).toEqual({ code: "hi", confident: true });
    expect(detectLanguageHint("สวัสดี ราคาเท่าไหร่")).toEqual({ code: "th", confident: true });
    expect(detectLanguageHint("안녕하세요 가격이 어떻게 되나요")).toEqual({ code: "ko", confident: true });
    expect(detectLanguageHint("こんにちは、価格はいくらですか")).toEqual({ code: "ja", confident: true });
    expect(detectLanguageHint("你好，价格是多少？")).toEqual({ code: "zh", confident: true });
  });

  it("calls a mixed message non-English when any unambiguous script is present", () => {
    // A reply that is mostly English but carries an Arabic sentence is still in Arabic.
    expect(detectLanguageHint("Please see below. مرحبا بكم")).toEqual({ code: "ar", confident: true });
  });
});

describe("language hint from English function words", () => {
  it("recognises ordinary English prose and signatures", () => {
    expect(detectLanguageHint("Thanks for reaching out, I will get back to you.").code).toBe("en");
    expect(detectLanguageHint("Can you send the pricing for your signals?").code).toBe("en");
    expect(detectLanguageHint("Best regards, Moutsim").code).toBe("en");
  });

  it("does not call a non-English Latin-script message English", () => {
    // Spanish, German and Indonesian: Latin letters, none of the English function words.
    expect(detectLanguageHint("Hola, gracias por tu mensaje. Cuál es el precio?").code).not.toBe("en");
    expect(detectLanguageHint("Guten Tag, vielen Dank für Ihre Nachricht.").code).not.toBe("en");
    expect(detectLanguageHint("Terima kasih atas pesan Anda, berapa harganya?").code).not.toBe("en");
  });

  it("treats text with no letters and empty input as unknown, not English", () => {
    expect(detectLanguageHint("")).toEqual({ code: null, confident: false });
    expect(detectLanguageHint("   ")).toEqual({ code: null, confident: false });
    expect(detectLanguageHint("12345 --- !!!")).toEqual({ code: null, confident: false });
    expect(detectLanguageHint(null)).toEqual({ code: null, confident: false });
    expect(detectLanguageHint(undefined)).toEqual({ code: null, confident: false });
  });

  it("is not fooled by a short Latin-script reply it cannot name", () => {
    // Two words, neither an English function word: unknown, which offers the button.
    expect(detectLanguageHint("Vielen Dank").code).not.toBe("en");
  });
});

describe("whether a message offers the Translate control", () => {
  it("offers it for an inbound message that is not confidently English", () => {
    expect(translationOffered({ direction: "inbound", text: "مرحبا بكم" })).toBe(true);
    expect(translationOffered({ direction: "inbound", text: "Hola, cuál es el precio?" })).toBe(true);
  });

  it("does not offer it for a confidently English inbound message", () => {
    expect(
      translationOffered({
        direction: "inbound",
        text: "Thanks, this looks interesting. Can you tell me more about the platform?",
      }),
    ).toBe(false);
  });

  it("never offers it for our own outbound message", () => {
    expect(translationOffered({ direction: "outbound", text: "مرحبا بكم" })).toBe(false);
  });

  it("does not offer it when there is no text to translate", () => {
    expect(translationOffered({ direction: "inbound", text: "" })).toBe(false);
    expect(translationOffered({ direction: "inbound", text: "   " })).toBe(false);
  });

  it("lets a stored translation settle the question without detecting anything", () => {
    // The provider already decided the language, and a stored result is authoritative.
    expect(translationOffered({ direction: "inbound", text: "Hello there", cachedStatus: "translated" })).toBe(true);
    expect(translationOffered({ direction: "inbound", text: "مرحبا بكم", cachedStatus: "english" })).toBe(false);
  });
});
