import { describe, expect, it } from "vitest";
import {
  checkDraftMechanics,
  complianceFooterPreview,
  type DraftMechanicsInput,
} from "@/lib/email/draft-check";

/**
 * The mechanical draft check: deterministic, no AI call, leaves drafts untouched. One case per rule the
 * founder named, plus a clean draft that must pass. It proves the failure classes are caught — never
 * that a claim is true.
 */

function draft(overrides: Partial<DraftMechanicsInput> = {}): DraftMechanicsInput {
  return {
    id: "draft-1",
    subject: "A quick question about Delta Signals",
    body:
      "Hi Delta Signals,\n\nI noticed your Telegram signal channel and had one idea worth a short call.\n\nBest,",
    companyName: "Delta Signals",
    complianceFooter: "Nomeriq\n1 Test Street\nUnsubscribe: <generated per recipient at send>",
    ...overrides,
  };
}

function rules(input: DraftMechanicsInput): string[] {
  return checkDraftMechanics(input).map((refusal) => refusal.rule);
}

describe("mechanical draft check", () => {
  it("passes a clean draft with no refusals", () => {
    expect(checkDraftMechanics(draft())).toEqual([]);
  });

  it("refuses an unresolved placeholder, naming the rule and the draft id", () => {
    for (const body of [
      "Hi {{first_name}},\n\nBest,",
      "Hi [name],\n\nBest,",
      "Hi there at [company],\n\nBest,",
      "TODO: finish this\n\nBest,",
      "XXX draft\n\nBest,",
    ]) {
      const refusals = checkDraftMechanics(draft({ id: "placeholder-1", body }));
      expect(refusals.map((r) => r.rule)).toContain("unresolved_placeholder");
      expect(refusals.every((r) => r.draftId === "placeholder-1")).toBe(true);
    }
  });

  it("refuses a currency amount and a percentage claim", () => {
    expect(rules(draft({ body: "It costs $49 per month.\n\nBest," }))).toContain(
      "currency_or_percentage",
    );
    expect(rules(draft({ body: "We grew 40% last quarter.\n\nBest," }))).toContain(
      "currency_or_percentage",
    );
    expect(rules(draft({ body: "Priced at 2500 pkr.\n\nBest," }))).toContain(
      "currency_or_percentage",
    );
  });

  it('refuses a body that does not end with "Best,"', () => {
    const refusals = checkDraftMechanics(
      draft({ id: "signoff-1", body: "Hi Delta Signals,\n\nRegards,\nA founder" }),
    );
    expect(refusals.map((r) => r.rule)).toContain("missing_signoff");
    // A trailing blank line after "Best," still counts as ending with it.
    expect(rules(draft({ body: "Hi Delta Signals,\n\nBest,\n\n" }))).not.toContain("missing_signoff");
  });

  it("refuses an empty subject", () => {
    expect(rules(draft({ subject: "   " }))).toContain("empty_subject");
  });

  it("refuses a draft that never names the recipient's business or contact", () => {
    const body = "Hi there,\n\nI noticed your channel and had one idea.\n\nBest,";
    expect(
      rules(draft({ subject: "A quick question", body, companyName: "Delta Signals" })),
    ).toContain("no_recipient_mention");
    // Naming the contact person also satisfies the rule.
    expect(
      rules(draft({ subject: "A quick question", body: "Hi Ayesha,\n\nI noticed your channel.\n\nBest,", companyName: "Delta Signals", recipientName: "Ayesha" })),
    ).not.toContain("no_recipient_mention");
  });

  it("refuses a draft with no unsubscribe footer, and only judges it when the recipient is unknown", () => {
    expect(rules(draft({ complianceFooter: null }))).toContain("no_unsubscribe_footer");
    expect(rules(draft({ complianceFooter: "Nomeriq\n1 Test Street" }))).toContain(
      "no_unsubscribe_footer",
    );
    // With no recipient at all the mention rule is not judged (it cannot be proven), but the footer rule is.
    const noName = rules(draft({ companyName: null, recipientName: null }));
    expect(noName).not.toContain("no_recipient_mention");
    expect(noName).not.toContain("no_unsubscribe_footer");
  });

  it("builds a footer preview that always carries an unsubscribe line", () => {
    const footer = complianceFooterPreview({
      legalBusinessName: "Nomeriq",
      postalAddress: "1 Test Street",
      postalAddressEnabled: true,
      footerNote: "You received this because we found your public contact.",
    });
    expect(footer).toContain("Unsubscribe:");
    expect(checkDraftMechanics(draft({ complianceFooter: footer }))).toEqual([]);
  });
});
