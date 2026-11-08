import { ASSISTANT_SKILL } from "@/lib/agent/instructions";
import { EMAIL_BODY_ONLY_RULE } from "@/lib/email/message-content";
import { describe, expect, it } from "vitest";
import { complianceLines, draftBodyOnly, draftEditorBody, generatedBodyOnly, previewEmailContent, withEmailIdentity, type EmailIdentitySettings } from "@/lib/email/message-content";

const identity: EmailIdentitySettings = {
  senderSignature: "Best regards,\nFixture Founder\nFounder | Nomeriq\nhttps://nomeriq.example",
  senderSignatureEnabled: true, postalAddress: "1 Fixture Street\nFixture City",
  postalAddressEnabled: true, legalBusinessName: "Fixture Business", footerNote: "You may reply to opt out.",
};
const body = "How does your team currently manage subscriber access?";

describe("Settings, never AI, own email signature and postal address", () => {
  it("strips an AI-invented signature without deleting the same founder-authored text", () => {
    const generated = `${body}\n\nBest,\nInvented Model Name\nFounder | Invented Company\nhttps://invented.example`;
    expect(generatedBodyOnly(generated, [identity.senderSignature])).toBe(body);
    expect(draftBodyOnly(generated, [identity.senderSignature])).toBe(generated);
    expect(generatedBodyOnly("Best,\nInvented Model Name")).toBe("");
    expect(generatedBodyOnly(`${body}\n\n> Best,\n> Quoted Person`)).toContain("> Quoted Person");
  });
  it("uses the same body-only rule for MCP first-contact and thread/reply instructions", () => {
    for (const heading of ["## First-contact drafts", "## Threads and replies"]) {
      const section = ASSISTANT_SKILL.split(/\n(?=## )/).find(block => block.startsWith(heading));
      expect(section).toBeDefined();
      expect(section).toContain(EMAIL_BODY_ONLY_RULE);
    }
    expect(ASSISTANT_SKILL).not.toMatch(/End with .?Best,/);
  });
  it.each(["Thanks", "Thanks ", "Words with spaces ", "\n  Indented founder text\n"])("preserves actively typed input byte-for-byte: %j", typed => {
    expect(draftEditorBody(typed, [identity.senderSignature], true)).toBe(typed);
    expect(draftEditorBody(`${body}\n\nBest,\n${identity.senderSignature}`, [identity.senderSignature], false)).toBe(body);
  });
  it("removes the screenshot's duplicate Best, plus saved signature without changing the message", () => {
    const legacy = `${body}\n\nBest,\n${identity.senderSignature}`;
    expect(draftBodyOnly(legacy, [identity.senderSignature])).toBe(body);
    const composed = previewEmailContent(legacy, identity);
    expect(composed).toContain(`${body}\n\n${identity.senderSignature}`);
    expect(composed.split(identity.senderSignature)).toHaveLength(2);
    expect(composed).not.toContain("\nBest,\n");
    expect(composed).toContain(identity.postalAddress);
    expect(legacy).toBe(`${body}\n\nBest,\n${identity.senderSignature}`);
  });
  it.each([[true, true], [true, false], [false, true], [false, false]])("signature %s / postal address %s inherit independently", (signature, address) => {
    const preview = previewEmailContent(`${body}\n\nBest,\n${identity.senderSignature}`, {
      ...identity, senderSignatureEnabled: signature, postalAddressEnabled: address,
    });
    expect(preview.startsWith(body)).toBe(true);
    expect(preview.includes(identity.senderSignature)).toBe(signature);
    expect(preview.includes(identity.postalAddress)).toBe(address);
    expect(preview).toContain(identity.legalBusinessName);
    expect(preview).toContain(identity.footerNote);
    expect(preview).not.toContain("Unsubscribe:"); // Never invent a usable recipient token in a read-only preview.
  });
  it("uses one mailbox override and the global toggle suppresses both signatures", () => {
    const profile = "Regards,\nFixture Mailbox";
    const legacy = `${body}\n\n${identity.senderSignature}`;
    expect(withEmailIdentity(legacy, identity, profile)).toBe(`${body}\n\n${profile}`);
    expect(withEmailIdentity(legacy, { ...identity, senderSignatureEnabled: false }, profile)).toBe(body);
  });
  it("is idempotent and handles Windows line endings and repeated known tails", () => {
    const legacy = `${body}\r\n\r\nBest,\r\n${identity.senderSignature.replace(/\n/g, "\r\n")}\r\n\r\n${identity.senderSignature}`;
    const once = withEmailIdentity(legacy, identity);
    expect(withEmailIdentity(once, identity)).toBe(once);
    expect(once).toBe(`${body}\n\n${identity.senderSignature}`);
  });
  it("normalizes whitespace only within a known trailing identity", () => {
    const legacy = `${body}\n\nBest,\n  Best   regards, \n\n Fixture  Founder \nFounder  |  Nomeriq\n https://nomeriq.example `;
    expect(withEmailIdentity(legacy, identity)).toBe(`${body}\n\n${identity.senderSignature}`);
  });
  it("does not infer or delete arbitrary founder names, address-like content or quotations", () => {
    const authored = "The best, most useful next step is a written demo.\n\nOur question mentions 2 Example Road.\n\n> Best,\n> Someone Else";
    expect(draftBodyOnly(authored, [identity.senderSignature])).toBe(authored);
    const unsigned = "Please forward this to the person managing subscriptions.\n\nAnother Person";
    expect(draftBodyOnly(unsigned, [identity.senderSignature])).toBe(unsigned);
  });
  it("empty optional identity never manufactures a name, address or signature", () => {
    const blank = { ...identity, senderSignature: "", postalAddress: "" };
    expect(withEmailIdentity(body, blank)).toBe(body);
    expect(complianceLines(blank)).toEqual([identity.legalBusinessName, identity.footerNote]);
  });
  it("changing toggles or signature composes a fresh unsent message without mutating body", () => {
    expect(previewEmailContent(body, identity)).toContain(identity.senderSignature);
    expect(previewEmailContent(body, { ...identity, senderSignature: "Regards,\nNew Fixture Founder" })).not.toContain("Fixture Founder\nFounder");
    expect(previewEmailContent(body, { ...identity, senderSignatureEnabled: false, postalAddressEnabled: false })).not.toContain(identity.senderSignature);
    expect(body).toBe("How does your team currently manage subscriber access?");
  });
});
