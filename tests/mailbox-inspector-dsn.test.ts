import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { analyze, mailFacts, NEEDS_REPLY_NAMES, type Facts } from "../src/lib/email/mailbox-inspector";

function facts(): Facts {
  return { accountId: "synthetic", leads: NEEDS_REPLY_NAMES.map((business_name, i) => ({ id: `lead-${i}`, business_name })), conversations: [], messages: [], emails: [], suppressions: [], bounces: [], legacy: [], states: [], mailbox: [], firstSync: 0, primarySent: "Sent Items" };
}

describe("read-only inspector DSN and alias evidence", () => {
  it("counts quoted report-type DSNs before excluding auto-replied responses", async () => {
    const f = facts();
    for (let i = 0; i < 3; i++) {
      const raw = Buffer.from([
        "From: MAILER-DAEMON@synthetic.invalid", "To: owner@synthetic.invalid",
        `Message-ID: <dsn-${i}@synthetic.invalid>`, "Subject: Delivery status notification",
        "Auto-Submitted: auto-replied", "MIME-Version: 1.0",
        'Content-Type: multipart/report; report-type="delivery-status"; boundary="synthetic"', "",
        "--synthetic", "Content-Type: text/plain", "", "Delivery failed.", "",
        "--synthetic", "Content-Type: message/delivery-status", "",
        "Reporting-MTA: dns; synthetic.invalid", "", `Final-Recipient: rfc822; dead${i}@synthetic.invalid`,
        "Action: failed", "Status: 5.1.1", "", "--synthetic--", "",
      ].join("\r\n"));
      const m = mailFacts(await simpleParser(raw), raw, { direction: "inbound", folder: "INBOX", uid: i + 1, uidvalidity: "1" }, f.leads);
      expect(m).toMatchObject({ bounceKind: "permanent", autoReply: false });
      f.mailbox.push(m);
    }
    expect(analyze(f).bounces).toMatchObject({ reportMessages: 3, permanent: 3, autoRepliesExcluded: 0 });
    expect(analyze(f).alternateAddressCandidates).toEqual([]);
  });

  it("does not use a vacation reply's quoted failure or signature as a bounce or alias", async () => {
    const raw = Buffer.from([
      "From: away@synthetic.invalid", "To: owner@synthetic.invalid", "Subject: Out of office",
      "Auto-Submitted: auto-replied", "Content-Type: text/plain", "",
      "OnwardBTC\nFinal-Recipient: rfc822; quoted@synthetic.invalid\nStatus: 5.1.1",
    ].join("\r\n"));
    const f = facts();
    const m = mailFacts(await simpleParser(raw), raw, { direction: "inbound", folder: "INBOX", uid: 1, uidvalidity: "1" }, f.leads);
    expect(m).toMatchObject({ bounceKind: "none", autoReply: true });
    f.mailbox.push(m);
    expect(analyze(f).alternateAddressCandidates).toEqual([]);
    expect(analyze(f).bounces.reportMessages).toBe(0);
  });

  it("a stored thread owner does not prove the sender is in the address book", () => {
    const f = facts();
    const m = { id: "stored", account_id: f.accountId, message_id: "<alias@synthetic.invalid>", direction: "inbound", from_email: "alternate@synthetic.invalid", to_emails: [], references_json: [], in_reply_to: null, prospect_id: "lead-6", conversation_id: "conversation", bounceKind: "none", autoReply: false, signatureCandidates: [], when: 1, bodyLength: 0, folder: "INBOX", uid: 1, uidvalidity: "1" };
    f.conversations.push({ id: "conversation", prospect_id: "lead-6" });
    f.messages.push(m);
    f.mailbox.push(m);
    expect(analyze(f).alternateAddressCandidates[0]).toMatchObject({ currentOwner: "OnwardBTC", threadMatched: true, linked: false });
  });
});
