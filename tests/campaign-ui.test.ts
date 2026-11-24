import React from "react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NO_PER_MINUTE_LABEL, PER_MINUTE_RANGE_HINT } from "@/lib/campaigns/pacing";
import * as agentTag from "@/lib/agent/agentTag";
import * as types from "@/lib/types";
import { compileTsx } from "./helpers/tsx-loader";

/**
 * The campaign screens, rendered from the real shipped TSX. Next preserves JSX, so the presentational
 * module is compiled here; only the presentation children (`./ui`) are stubbed, because they import
 * server-side modules this test does not need. This proves the markup the founder actually sees — the
 * empty per-minute label, a named failing draft, an overdue sync, a named skip.
 *
 * The builder's form is presentational (`CampaignBuilderPanel`), so the ORDER of the real shipped markup
 * is asserted here too: every control above the candidate list, and the action bar sticky.
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
  // The app's own modules the component imports at runtime, resolved the way the app resolves them.
  if (id === "@/lib/types") return types;
  if (id === "@/lib/agent/agentTag") return agentTag;
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

describe("the builder keeps every control above the candidate list", () => {
  const preview = {
    matches: 32,
    selected: 32,
    draftIds: Array.from({ length: 32 }, (_, index) => `draft-${index}`),
    sample: [
      { id: "a", prospectName: "Delta Signals", subject: "A quick question about Delta Signals" },
      { id: "b", prospectName: "Meridian FX", subject: "An idea for Meridian FX" },
    ],
    failing: [1, 2, 3, 4].map((n) => ({
      draftId: `bad-${n}`,
      rule: "empty_subject",
      message: "It has an empty subject line.",
    })),
    failingPreviews: [1, 2, 3, 4].map((n) => ({
      draftId: `bad-${n}`,
      prospectName: `Broken Draft ${n}`,
      subject: "",
      message: "It has an empty subject line.",
    })),
    ready: false,
  };

  const renderPanel = (overrides: Record<string, unknown> = {}) =>
    render("CampaignBuilderPanel", {
      accounts: [
        { id: "acct-1", emailAddress: "founder@nomeriq.test", provider: "smtp", status: "connected" },
      ],
      name: "Tier 1 signals — November",
      accountId: "acct-1",
      filters: { agent: "", market: "", stage: "", tier: "", sender: "", hasEmail: false, notContacted: true },
      batchSize: "",
      timing: "now",
      whenLocal: "",
      perMinute: "",
      perMinuteSummary: NO_PER_MINUTE_LABEL,
      perMinuteHint: PER_MINUTE_RANGE_HINT,
      timezone: "Asia/Karachi",
      preview,
      previewLoading: false,
      previewError: null,
      error: null,
      matches: 32,
      overMatched: false,
      queueCount: 32,
      failingCount: 4,
      passingCount: 28,
      pending: false,
      onNameChange: () => {},
      onAccountChange: () => {},
      onFilterChange: () => {},
      onBatchSizeChange: () => {},
      onTimingChange: () => {},
      onWhenChange: () => {},
      onPerMinuteChange: () => {},
      onApprove: () => {},
      onApprovePassingOnly: () => {},
      onClose: () => {},
      ...overrides,
    });

  it("renders the count, the batch size, the start choice and the per-minute field before the list", () => {
    const html = renderPanel();
    const list = html.indexOf("A few of the emails that will go");
    expect(list).toBeGreaterThan(-1);
    // the live count is the anchor, and every control sits BETWEEN it and the list
    expect(html.indexOf("data-campaign-count")).toBeGreaterThan(-1);
    expect(html.indexOf("data-campaign-count")).toBeLessThan(html.indexOf("Batch size"));
    expect(html.indexOf("Batch size")).toBeLessThan(list);
    expect(html.indexOf("At a date and time")).toBeLessThan(list);
    expect(html.indexOf("Per-minute limit")).toBeLessThan(list);
    expect(html.indexOf("Approve and queue 32 emails")).toBeLessThan(list);
    // and the batch-size field is inside the action bar, with the one approve button
    const actions = html.slice(
      html.indexOf("data-campaign-actions"),
      html.indexOf("data-campaign-candidates"),
    );
    expect(actions).toContain("Batch size");
    expect(actions).toContain("Approve and queue 32 emails");
  });

  it("puts the candidate list in its own bounded, scrollable region, last in the panel", () => {
    const html = renderPanel();
    const at = html.indexOf("data-campaign-candidates");
    const region = html.slice(at, html.indexOf(">", at));
    expect(region).toContain("overflow-y-auto");
    expect(region).toContain("max-h-");
    expect(at).toBeGreaterThan(html.indexOf("data-campaign-actions"));
    // the failing drafts are still listed, inside that region
    expect(html.slice(at)).toContain("Broken Draft 1");
  });

  it("stays sticky at the bottom so a long list cannot bury the approve control", () => {
    const html = renderPanel();
    const at = html.indexOf("data-campaign-actions");
    const bar = html.slice(at, html.indexOf(">", at));
    expect(bar).toContain("sticky");
    expect(bar).toContain("bottom-0");
    expect(bar).toContain("z-20");
  });

  it("keeps the all-or-nothing refusal: the failing drafts are named and the one button is disabled", () => {
    const html = renderPanel();
    expect(html).toContain(
      "Fix any failing draft first — the batch is all-or-nothing, so one bad draft blocks the whole batch.",
    );
    expect(html).toMatch(/data-campaign-approve[^>]*disabled/);
    expect(html).toContain("Broken Draft 1");
    expect(html).toContain("It has an empty subject line.");
    // the honest labels are untouched by the reordering
    expect(html).toContain("No per-minute limit — sends go back to back");
    expect(html).toContain("Times are Asia/Karachi.");
    expect(html).toContain("Up to 32 match. Leave empty to take them all.");
  });

  it("offers ONE explicit alternative that states the reduced count and how many are excluded", () => {
    const html = renderPanel();
    expect(html).toContain("28 of 32 selected drafts passed");
    expect(html).toContain("4 failing drafts stay unapproved");
    expect(html).toContain("Approve the 28 that pass instead");
    // the alternative is a real enabled control, beside the disabled refusal
    const at = html.indexOf("data-campaign-approve-passing");
    expect(at).toBeGreaterThan(-1);
    const tag = html.slice(html.lastIndexOf("<button", at), html.indexOf(">", at));
    expect(tag).not.toContain("disabled");
  });

  it("offers no alternative when every draft passes, or when nothing would pass", () => {
    const allPass = renderPanel({
      queueCount: 32,
      failingCount: 0,
      passingCount: 32,
      preview: { ...preview, failing: [], failingPreviews: [], ready: true },
    });
    expect(allPass).not.toContain("that pass instead");
    expect(allPass).toContain("One click approves these 32 drafts and queues them.");

    const allFail = renderPanel({
      queueCount: 4,
      failingCount: 4,
      passingCount: 0,
      preview: { ...preview, selected: 4 },
    });
    expect(allFail).not.toContain("that pass instead");
    expect(allFail).toContain("Broken Draft 4");
  });
});

describe("the outcome notice after 'only the ones that pass'", () => {
  it("states the reduced count and names every failing draft that was left out", () => {
    const html = render("CampaignBatchApprovedNotice", {
      approved: 28,
      excluded: [
        { draftId: "bad-1", prospectName: "Broken Draft 1", message: "It has an empty subject line." },
        { draftId: "bad-4", prospectName: "Broken Draft 4", message: "It has an empty subject line." },
      ],
    });
    expect(html).toContain('data-campaign-passing-notice');
    expect(html).toContain("Approved and queued 28 emails — only the drafts that passed");
    expect(html).toContain("2 failing drafts were left out and NOT approved");
    expect(html).toContain("Broken Draft 1");
    expect(html).toContain("Broken Draft 4");
  });

  it("renders nothing when nothing was excluded", () => {
    expect(render("CampaignBatchApprovedNotice", { approved: 5, excluded: [] })).toBe("");
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

  it("sends the reduced-batch flag for the founder's own alternative click alone", () => {
    expect(builder).toMatch(/approvePassingOnly/);
    expect(builder).toMatch(/approvePassingOnly: passingOnly/);
    expect(builder).toMatch(/onApprovePassingOnly=\{\(\) => void approve\(\{ passingOnly: true \}\)\}/);
    expect(builder).toMatch(/onApprove=\{\(\) => void approve\(\)\}/);
    expect(builder).toMatch(/setPassingOutcome\(\{ approved: result\.approvedCount, excluded: result\.excludedFailing \}\)/);
    expect(builder).toMatch(/Approved and queued \$\{result\.approvedCount\}/);
  });

  it("the list can pause, resume, cancel, start a manual campaign and save pacing while running", () => {
    expect(status).toMatch(/\/status/);
    expect(status).toMatch(/\/start/);
    expect(status).toMatch(/\/pacing/);
  });
});
