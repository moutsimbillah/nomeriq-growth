import React from "react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NO_PER_MINUTE_LABEL } from "@/lib/campaigns/pacing";
import { compileTsx } from "./helpers/tsx-loader";

/**
 * The campaign screens, rendered from the real shipped TSX. Next preserves JSX, so the presentational
 * module is compiled here; only the presentation children (`./ui`) are stubbed, because they import
 * server-side modules this test does not need. This proves the markup the founder actually sees — the
 * empty per-minute label, a named failing draft, an overdue sync, a named skip.
 */

const code = compileTsx("src/components/campaign-ui.tsx");
const nativeRequire = createRequire(import.meta.url);

function load(id: string) {
  if (id === "./ui") {
    return {
      Notice: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) =>
        React.createElement("div", { "data-notice": "1" }, title, children),
    };
  }
  return nativeRequire(id);
}

const components = (() => {
  const mod = { exports: {} as Record<string, React.ComponentType<any>> };
  new Function("require", "module", "exports", code)(load, mod, mod.exports);
  return mod.exports;
})();

const render = (name: string, props: object = {}) =>
  renderToStaticMarkup(React.createElement(components[name], props));

describe("the honest mailbox sync line renders its verdict loudly", () => {
  it("spells an overdue sync out and never invents a next-sync claim", () => {
    const html = render("MailboxSyncStatusLine", {
      status: { verdict: "overdue", at: "2026-11-22T10:00:00.000Z", ageMinutes: 55 },
      atLabel: "22 Nov 2026, 15:00",
    });
    expect(html).toContain("Last sync");
    expect(html).toContain("22 Nov 2026, 15:00");
    expect(html).toContain("overdue");
    expect(html).toContain('data-sync-verdict="overdue"');
    expect(html).toContain("text-rust"); // loud
    expect(html).toContain("Auto-sync every 15 minutes");
    expect(html).not.toContain("next sync");
  });

  it("renders succeeded and never honestly", () => {
    expect(
      render("MailboxSyncStatusLine", {
        status: { verdict: "succeeded", at: "2026-11-22T11:55:00.000Z", ageMinutes: 5 },
        atLabel: "22 Nov 2026, 16:55",
      }),
    ).toContain('data-sync-verdict="succeeded"');
    const never = render("MailboxSyncStatusLine", {
      status: { verdict: "never", at: null, ageMinutes: null },
      atLabel: null,
    });
    expect(never).toContain('data-sync-verdict="never"');
    expect(never).toContain("Last sync");
  });

  it("shows a failed run's own reason and never leaves a bare 'failed'", () => {
    const withReason = render("MailboxSyncStatusLine", {
      status: {
        verdict: "failed",
        at: "2026-11-22T10:00:00.000Z",
        ageMinutes: 120,
        reason: "IMAP login failed for moutsim@nomeriq.com.",
      },
      atLabel: "22 Nov 2026, 15:00",
    });
    expect(withReason).toContain('data-sync-verdict="failed"');
    expect(withReason).toContain('data-sync-reason');
    expect(withReason).toContain("IMAP login failed for moutsim@nomeriq.com.");

    // A failed run that recorded no reason says so rather than presenting "failed" as the explanation.
    const noReason = render("MailboxSyncStatusLine", {
      status: { verdict: "failed", at: "2026-11-22T10:00:00.000Z", ageMinutes: 120, reason: null },
      atLabel: "22 Nov 2026, 15:00",
    });
    expect(noReason).toContain("The newest run failed and recorded no reason.");
  });
});

describe("the batch preview panel", () => {
  const preview = {
    matches: 12,
    selected: 12,
    draftIds: ["a", "b", "c"],
    sample: [
      { id: "a", prospectName: "Delta Signals", subject: "A quick question about Delta Signals" },
      { id: "b", prospectName: "Meridian FX", subject: "An idea for Meridian FX" },
    ],
    failing: [{ draftId: "c", rule: "empty_subject", message: "It has an empty subject line." }],
    failingPreviews: [
      { draftId: "c", prospectName: "Broken Draft Co", subject: "", message: "It has an empty subject line." },
    ],
    ready: false,
  };

  it("shows the live count and a few of the emails that will go", () => {
    const html = render("CampaignBatchPreviewPanel", { preview, loading: false, error: null });
    expect(html).toContain("12");
    expect(html).toContain("Delta Signals");
    expect(html).toContain("Meridian FX");
  });

  it("names the failing draft rather than hiding it behind the count", () => {
    const html = render("CampaignBatchPreviewPanel", { preview, loading: false, error: null });
    expect(html).toContain("Broken Draft Co");
    expect(html).toContain("It has an empty subject line.");
    expect(html).toContain("failed the check");
  });

  it("shows a loading state and an error verbatim", () => {
    expect(render("CampaignBatchPreviewPanel", { preview: null, loading: true, error: null })).toContain(
      "Counting matching drafts",
    );
    expect(
      render("CampaignBatchPreviewPanel", { preview: null, loading: false, error: "the backend said no" }),
    ).toContain("the backend said no");
  });
});

describe("the per-minute control never leaves an empty value looking unset", () => {
  it("labels the sanctioned empty value explicitly", () => {
    expect(NO_PER_MINUTE_LABEL).toBe("No per-minute limit — sends go back to back");
    const html = render("PerMinuteControl", {
      value: "",
      onChange: () => {},
      summary: NO_PER_MINUTE_LABEL,
      hint: "Leave it empty for no per-minute limit.",
    });
    expect(html).toContain("No per-minute limit — sends go back to back");
    expect(html).toContain('placeholder="Empty"');
  });
});

describe("the run journal names every skip", () => {
  it("renders each skip with its reason", () => {
    const html = render("CampaignJournalList", {
      entries: [
        { id: "1", level: "item_skipped", reason: "The prospect opted out.", draftId: "d1", createdAt: "" },
        { id: "2", level: "auto_start_held", reason: "Missed by over 24 hours.", draftId: null, createdAt: "" },
      ],
    });
    expect(html).toContain("Skipped");
    expect(html).toContain("The prospect opted out.");
    expect(html).toContain("Not auto-started");
    expect(html).toContain("Missed by over 24 hours.");
  });

  it("renders nothing when there are no entries", () => {
    expect(render("CampaignJournalList", { entries: [] })).toBe("");
  });
});

describe("the approve button states exactly how many emails it queues", () => {
  it("pluralises the count", () => {
    expect(render("CampaignApproveButton", { count: 7, disabled: false, pending: false, onClick: () => {} })).toContain(
      "Approve and queue 7 emails",
    );
    expect(render("CampaignApproveButton", { count: 1, disabled: false, pending: false, onClick: () => {} })).toContain(
      "Approve and queue 1 email",
    );
  });
});

describe("the builder and list share one pacing sentence and one schedule conversion", () => {
  const builder = readFileSync("src/components/campaign-builder.tsx", "utf8");
  const status = readFileSync("src/components/campaign-status.tsx", "utf8");

  it("both use the shared per-minute copy", () => {
    expect(builder).toMatch(/NO_PER_MINUTE_LABEL/);
    expect(builder).toMatch(/perMinuteSummary/);
    expect(status).toMatch(/NO_PER_MINUTE_LABEL|perMinuteSummary/);
  });

  it("the builder converts the entered start through the workspace zone and sends the founder's authorisation", () => {
    expect(builder).toMatch(/zonedWallClockToUtc/);
    expect(builder).toMatch(/\/api\/campaigns\/preview/);
    expect(builder).toMatch(/\/api\/campaigns"/);
    expect(builder).toMatch(/approveBatch: true/);
    expect(builder).toMatch(/authorize: true/);
  });

  it("the list can pause, resume, cancel, start a manual campaign and save pacing while running", () => {
    expect(status).toMatch(/\/status/);
    expect(status).toMatch(/\/start/);
    expect(status).toMatch(/\/pacing/);
  });
});
