import { describe, expect, it } from "vitest";
import {
  BOUNCE_LIMIT,
  BOUNCE_WINDOW,
  MAX_SOFT_BOUNCES,
  bounceDecision,
  bounceRateExceeded,
  parseBounce,
  suppressionReasonFor,
} from "@/lib/email/bounces";

/**
 * Bounce handling, before it touches a mailbox.
 *
 * The two ways to get this wrong both cost something real. A permanent bounce that is retried wastes
 * sends and hurts deliverability; a real prospect suppressed on a transient failure can never be
 * contacted again. So the parser is required to be conservative: when it cannot read a status it must
 * answer "transient", never "permanent".
 */

const DSN = `Reporting-MTA: dns; mx.example.net
Arrival-Date: Tue, 03 Nov 2026 10:00:00 +0000

Final-Recipient: rfc822; contact@p4provider.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 <contact@p4provider.com>: Recipient address rejected: User unknown`;

describe("recognising a delivery report", () => {
  it("reads a permanent failure with its address and code", () => {
    const report = parseBounce({
      fromEmail: "MAILER-DAEMON@mx.example.net",
      subject: "Undelivered Mail Returned to Sender",
      bodyText: DSN,
      contentType: "multipart/report; report-type=delivery-status",
    });
    expect(report.kind).toBe("permanent");
    expect(report.recipient).toBe("contact@p4provider.com");
    expect(report.status).toBe("5.1.1");
    expect(report.diagnostic).toMatch(/User unknown/);
  });

  it("reads a transient failure as transient", () => {
    const report = parseBounce({
      fromEmail: "postmaster@example.net",
      subject: "Delivery Status Notification (Delay)",
      bodyText: `Final-Recipient: rfc822; someone@example.test
Action: delayed
Status: 4.2.2
Diagnostic-Code: smtp; 452 4.2.2 Mailbox full`,
    });
    expect(report.kind).toBe("transient");
    expect(report.recipient).toBe("someone@example.test");
    expect(report.status).toBe("4.2.2");
  });

  it("reads an abuse feedback report as a complaint", () => {
    const report = parseBounce({
      fromEmail: "staff@abuse.example.net",
      subject: "Abuse report",
      bodyText: "Original-Recipient: rfc822; victim@example.test\nFeedback-Type: abuse",
      contentType: 'multipart/report; report-type=feedback-report',
    });
    expect(report.kind).toBe("complaint");
    expect(suppressionReasonFor(report.kind)).toBe("complaint");
  });

  it("takes the failed address from the header when the body has no Final-Recipient", () => {
    const report = parseBounce({
      fromEmail: "mailer-daemon@example.net",
      subject: "failure notice",
      bodyText: "",
      headers: { "x-failed-recipients": "gone@example.test" },
    });
    expect(report.kind).toBe("transient");
    expect(report.recipient).toBe("gone@example.test");
  });
});

describe("never treats a person as a bounce", () => {
  it("ignores ordinary mail from a person", () => {
    const report = parseBounce({
      fromEmail: "contact@p4provider.com",
      subject: "Re: your message",
      bodyText: "Thanks, not interested.",
    });
    expect(report.kind).toBe("none");
  });

  it("ignores a person who happens to write 'undeliverable' in the subject", () => {
    // A human reply quoting our own bounce is not a delivery report, and must stay a reply.
    const report = parseBounce({
      fromEmail: "founder@example.test",
      subject: "Re: Undeliverable: hello",
      bodyText: "That address bounced for me too.",
    });
    expect(report.kind).toBe("none");
  });

  it("ignores a report-shaped message with no usable status, except to say transient", () => {
    const report = parseBounce({
      fromEmail: "mailer-daemon@example.net",
      subject: "Returned mail",
      bodyText: "Your message could not be delivered.",
    });
    // Unclassifiable, so the safe answer: transient, which retries rather than suppressing.
    expect(report.kind).toBe("transient");
    expect(report.recipient).toBeNull();
  });

  it("treats an empty sender and empty body as ordinary mail", () => {
    expect(parseBounce({ fromEmail: "", subject: "", bodyText: "" }).kind).toBe("none");
  });
});

describe("what to do about a report", () => {
  it("suppresses a permanent failure and a complaint at once", () => {
    expect(bounceDecision({ kind: "permanent", priorSoftBounces: 0 })).toBe("suppress");
    expect(bounceDecision({ kind: "complaint", priorSoftBounces: 0 })).toBe("suppress");
  });

  it("retries a transient failure until the address has collected three", () => {
    expect(bounceDecision({ kind: "transient", priorSoftBounces: 0 })).toBe("retry");
    expect(bounceDecision({ kind: "transient", priorSoftBounces: 1 })).toBe("retry");
    // The third report is the one that ends it.
    expect(bounceDecision({ kind: "transient", priorSoftBounces: MAX_SOFT_BOUNCES - 1 })).toBe(
      "suppress",
    );
  });

  it("does nothing for a message that is not a report", () => {
    expect(bounceDecision({ kind: "none", priorSoftBounces: 99 })).toBe("retry");
  });
});

describe("the bounce rate that pauses a profile", () => {
  it("uses the plan's numbers: more than 3% over the last 50 sends", () => {
    expect(BOUNCE_WINDOW).toBe(50);
    expect(BOUNCE_LIMIT).toBeCloseTo(0.03);
  });

  it("does not judge a mailbox that has not sent 50 yet", () => {
    // Two bounces out of two sends is 100%, and pausing a warm-up mailbox on that would be wrong.
    const early = bounceRateExceeded({ sends: 2, bounces: 2 });
    expect(early.exceeded).toBe(false);
    expect(early.sampled).toBe(false);
    expect(early.rate).toBe(1);
  });

  it("pauses above the limit over a full window", () => {
    // 2 of 50 is 4%, above the 3% ceiling.
    expect(bounceRateExceeded({ sends: 50, bounces: 2 }).exceeded).toBe(true);
    // 1 of 50 is 2%, below it.
    expect(bounceRateExceeded({ sends: 50, bounces: 1 }).exceeded).toBe(false);
  });

  it("is exactly at the limit, which does not pause", () => {
    expect(bounceRateExceeded({ sends: 100, bounces: 3 }).exceeded).toBe(false);
  });

  it("answers safely with no sends at all", () => {
    expect(bounceRateExceeded({ sends: 0, bounces: 0 })).toEqual({
      exceeded: false,
      rate: 0,
      sampled: false,
    });
  });
});