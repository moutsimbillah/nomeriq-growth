import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { replyContactName, replyGreeting, withReplyGreeting } from "@/lib/ai/reply-greeting";
import { suggestionFailure } from "@/lib/ai/suggestion-failure";

const incoming = (fromName: string | null, bodyText = "Thanks for the information.") =>
  ({ direction: "inbound" as const, fromName, fromEmail: "cryptosenseiservice@example.test", bodyText });

describe("reply names are recorded evidence, never email-derived", () => {
  it("uses a message's display name or an explicitly recorded lead contact name", () => {
    expect(replyContactName([incoming("Sara Ahmed")])).toBe("Sara Ahmed");
    expect(replyContactName([incoming(null)], "Mariam Khan")).toBe("Mariam Khan");
    expect(replyContactName([incoming(null, "Yes, let's talk.\n\nBest,\nSara Ahmed")])).toBe("Sara Ahmed");
  });
  it("uses the business team when no name is recorded and refuses address-shaped names", () => {
    expect(replyContactName([incoming(null)])).toBeNull();
    expect(replyContactName([incoming("cryptosenseiservice")])).toBeNull();
    expect(replyContactName([incoming("someone@example.test")])).toBeNull();
    expect(replyGreeting(null, "CryptoSense AI")).toBe("Hi CryptoSense AI team,");
  });
  it("localizes the business-team greeting and corrects an invented name without losing the answer", () => {
    expect(replyGreeting(null, "CryptoSense AI", "fr")).toBe("Bonjour l’équipe CryptoSense AI,");
    expect(replyGreeting("Sara Ahmed", "CryptoSense AI", "es")).toBe("Hola Sara,");
    const body = withReplyGreeting("Hi Cryptosenseiservice, thanks for your reply. Here are the details.", replyGreeting(null, "CryptoSense AI"));
    expect(body).toBe("Hi CryptoSense AI team,\n\nthanks for your reply. Here are the details.");
    expect(withReplyGreeting("Bonjour Inventé,\n\nLa réponse est ici.", replyGreeting(null, "CryptoSense AI", "fr")))
      .toBe("Bonjour l’équipe CryptoSense AI,\n\nLa réponse est ici.");
  });
});

describe("suggestion failures are visible, not templates", () => {
  it.each([
    ["rate_limit", "DeepSeek is busy"],
    ["request_timeout", "took too long"],
    ["context_size", "context is too large"],
    ["invalid_reply_response", "incomplete or unreadable"],
    ["provider_error", "could not complete"],
  ])("explains %s in plain words", (code, words) => {
    const failure = suggestionFailure(code, "deepseek");
    expect(failure.message).toContain(words);
    expect(failure.message).not.toContain("standard template");
  });

  it("opens an empty reply box without an automatic suggestion and preserves edits", () => {
    const source = readFileSync("src/components/conversation-actions.tsx", "utf8");
    const composer = source.slice(source.indexOf("export function ReplyComposer"), source.indexOf("export function SimulateReplyButton"));
    expect(composer).not.toContain("autoSuggest");
    expect(composer).not.toContain("void suggest()");
    expect(composer).toContain('useState("")');
    expect(composer).toContain("if (edited.current)");
    expect(composer).toContain("setProposed({ body: result.body");
    expect(composer).toContain("data-suggestion-retry");
    expect(composer).toContain("Your text has not been changed");
    // A suggestion error is handled before any body insertion.
    expect(composer.indexOf("if (result.failure)")).toBeLessThan(composer.indexOf("setBody(result.body)"));
  });
});
