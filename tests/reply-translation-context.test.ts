import { describe, expect, it } from "vitest";
import { replyContext, replySystemPrompt } from "@/lib/ai/reply";

const ARABIC_BODY = "مرحبًا، أرغب في معرفة المزيد عن خدماتكم.";

const truth: any = { status: "approved", oneLiner: "One liner fixture", approvedClaims: ["Claim one"] };
const prospect: any = {
  businessName: "Fixture Co",
  websiteUrl: "https://fixture.example.test",
  signalDescription: "Recent expansion signal",
};
const translation = { sourceLanguage: "ar", translatedText: "Hello", status: "translated" };

function turnWith(extra: Record<string, unknown> = {}): any {
  return { direction: "inbound", fromEmail: "fixture@example.test", subject: "Fixture subject", bodyText: ARABIC_BODY, sentAt: null, ...extra };
}

describe("reply translation context", () => {
  it("labels the original and the translated text in a machine translation block", () => {
    const turn = turnWith({ translation });
    const context = replyContext(truth, prospect, [turn]);

    expect(turn.bodyText).toBe(ARABIC_BODY);
    expect(context).toContain(ARABIC_BODY);
    expect(context).toContain(translation.translatedText);
    expect(context).toContain("MACHINE TRANSLATION");
    expect(context.toLowerCase()).toContain("never quote from it");
  });

  it("requires English, verbatim original quotations and untrusted translation", () => {
    const prompt = replySystemPrompt().toLowerCase();

    expect(prompt).toContain("english");
    expect(prompt).toContain("verbatim");
    expect(prompt).toContain("untrusted");
  });

  it("adds no machine translation block when the status is english", () => {
    const context = replyContext(truth, prospect, [
      turnWith({ translation: { ...translation, status: "english" } }),
    ]);

    expect(context).toContain(ARABIC_BODY);
    expect(context).not.toContain("MACHINE TRANSLATION");
  });

  it("preserves the original normal context with no translation", () => {
    const context = replyContext(truth, prospect, [turnWith()]);

    expect(context).toContain(ARABIC_BODY);
    expect(context).toContain("Fixture Co");
    expect(context).not.toContain("MACHINE TRANSLATION");
  });
});
