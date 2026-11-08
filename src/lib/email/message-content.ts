/** Browser-safe email presentation. Draft bodies never own sender identity or compliance links. */
export interface EmailIdentitySettings {
  senderSignature: string;
  senderSignatureEnabled: boolean;
  postalAddress: string;
  postalAddressEnabled: boolean;
  legalBusinessName: string;
  footerNote: string;
}

export const EMAIL_BODY_ONLY_RULE = "Write only the message body. Do not add a sign-off (including Best, or Regards,), sender name, signature, sender website, registered postal address, legal footer or unsubscribe link. Growth alone adds enabled identity/footer fields from current Settings at preview and send.";

const SIGN_OFF = /^(?:best(?: regards| wishes)?|kind regards|warm regards|regards|sincerely|yours sincerely|thanks(?: again)?|thank you|cheers)[,.!]?$/i;

/**
 * Remove only a known trailing signature and standalone trailing sign-offs. In particular, never
 * infer a person's name/address or delete an arbitrary block of the founder's message. Stored
 * historical bodies are not rewritten: this is used at generation/save and presentation boundaries.
 */
export function draftBodyOnly(body: string, signatures: readonly string[] = []): string {
  let result = body.replace(/\r\n/g, "\n").trimEnd();
  const known = [...new Set(signatures.map(value => value.replace(/\r\n/g, "\n").trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  for (;;) {
    const before = result;
    for (const signature of known) {
      // Match complete known lines only, tolerating blank lines/spacing introduced by old writers.
      const expected = signature.split("\n").map(line => line.trim().replace(/\s+/g, " ")).filter(Boolean);
      const actual = result.split("\n");
      let cursor = actual.length - 1;
      let matched = true;
      for (let index = expected.length - 1; index >= 0; index--) {
        while (cursor >= 0 && !actual[cursor].trim()) cursor--;
        if (cursor < 0 || actual[cursor].trim().replace(/\s+/g, " ") !== expected[index]) { matched = false; break; }
        cursor--;
      }
      if (matched) result = actual.slice(0, cursor + 1).join("\n").trimEnd();
    }
    const lines = result.split("\n");
    if (SIGN_OFF.test(lines.at(-1)?.trim() ?? "")) result = lines.slice(0, -1).join("\n").trimEnd();
    if (result === before) break;
  }
  return result.trim();
}

/** AI/agent output only: remove an invented trailing signature block, never founder-authored text. */
export function generatedBodyOnly(body: string, signatures: readonly string[] = []): string {
  const clean = draftBodyOnly(body, signatures);
  const lines = clean.split("\n");
  for (let index = Math.max(0, lines.length - 20); index < lines.length; index++) {
    if (SIGN_OFF.test(lines[index].trim()) && lines.slice(index).join("\n").length <= 1000) {
      return lines.slice(0, index).join("\n").trim();
    }
  }
  return clean;
}

/** The editable body is never rewritten while the founder types.
 */
export function draftEditorBody(body: string, signatures: readonly string[], edited: boolean): string {
  return edited ? body : draftBodyOnly(body, signatures);
}

/** Current signature, including a mailbox override, appended once irrespective of a legacy body. */
export function withEmailIdentity(body: string, settings: EmailIdentitySettings, profileSignature?: string): string {
  const clean = draftBodyOnly(body, [settings.senderSignature, profileSignature ?? ""]);
  const signature = profileSignature?.trim() || settings.senderSignature.trim();
  return [clean, settings.senderSignatureEnabled && signature ? signature : ""].filter(Boolean).join("\n\n");
}

/** The same postal/legal lines for preview/copy and the real server-created unsubscribe footer. */
export function complianceLines(settings: EmailIdentitySettings): string[] {
  return [
    settings.legalBusinessName.trim(),
    settings.postalAddressEnabled ? settings.postalAddress.trim() : "",
    settings.footerNote.trim(),
  ].filter(Boolean);
}

/** Copyable presentation without inventing a token/link. Real sends add their recipient's opt-out. */
export function previewEmailContent(body: string, settings: EmailIdentitySettings, profileSignature?: string): string {
  const content = withEmailIdentity(body, settings, profileSignature);
  const lines = complianceLines(settings);
  return lines.length ? `${content}\n\n--\n${lines.join("\n")}` : content;
}
