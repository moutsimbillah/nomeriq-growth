import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The layout contract that the long-URL bug broke, pinned in the files themselves.
 *
 * A 2,000-character tracking URL stretched the message column and pushed the Write reply panel
 * off-screen. Three things have to hold, and each one alone is not enough:
 *
 *   1. `overflow-wrap: anywhere` — `break-word` does NOT reduce a box's min-content width, so the
 *      grid track still grew to fit the URL. Only `anywhere` counts the break opportunities.
 *   2. `min-w-0` on the grid children — the default `min-width: auto` on a grid item floors it at
 *      its content's min-content width, which is the whole URL.
 *   3. grid tracks written as `minmax(0, …)` — a bare `1fr` track is `minmax(auto, 1fr)`, so one
 *      long word widens it.
 *
 * The theme sets `break-anywhere` (globals.css). Behaviour is covered by `message-links.test.ts`;
 * this file covers the shape.
 */

const THREAD = "src/app/(app)/email/[id]/page.tsx";
const MESSAGE = "src/components/conversation-message.tsx";
const ACTIONS = "src/components/conversation-actions.tsx";
const CSS = "src/app/globals.css";

const thread = readFileSync(THREAD, "utf8");
const message = readFileSync(MESSAGE, "utf8");
const actions = readFileSync(ACTIONS, "utf8");
const css = readFileSync(CSS, "utf8");

describe("the message column keeps its width", () => {
  it("defines break-anywhere as a utility, including the -webkit- form", () => {
    expect(css).toContain("@utility break-anywhere");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("-webkit-line-break: anywhere");
    expect(css).toContain("-webkit-overflow-wrap: anywhere");
  });

  it("wraps message bodies with anywhere, not break-word", () => {
    // The whole .email-body rule, up to its closing brace.
    const start = css.indexOf(".email-body {");
    const body = css.slice(start, css.indexOf("}", start));
    expect(body).toContain("break-anywhere");
    // `break-word` is the exact property that failed: its min-content width still counted the URL.
    expect(body).not.toContain("break-words");
  });

  it("sizes both grid tracks as minmax(0, …) so no track is floored by a long word", () => {
    expect(thread).toContain("xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]");
    expect(thread).not.toContain("xl:grid-cols-[1.5fr_1fr]");
  });

  it("gives both grid children min-w-0", () => {
    const grid = thread.slice(thread.indexOf("minmax(0,1.5fr)"));
    expect(grid).toContain('className="min-w-0 space-y-3"');
    expect(grid).toContain('className="min-w-0 space-y-4"');
  });

  it("lets the reply panel hold a width instead of being pushed out, and wraps its recipient line", () => {
    expect(actions).toContain('className="card min-w-0 overflow-hidden"');
    expect(actions).toContain('className="mt-0.5 break-anywhere text-12 text-faint"');
  });
});

describe("long URLs are shown shortened but still open in full", () => {
  it("renders the body through the link renderer", () => {
    expect(message).toContain("<TextWithLinks text={view.text} />");
    expect(message).toContain('from "@/components/message-links"');
    // The renderer keeps its own min-w-0 and anywhere, so it is safe inside the column.
    expect(message).toContain('className="email-body min-w-0 break-anywhere text-muted"');
  });

  it("shortens the visible text while the href keeps the whole address", () => {
    const renderer = readFileSync("src/components/message-links.tsx", "utf8");
    expect(renderer).toContain("{shortenUrl(segment.text)}");
    expect(renderer).toContain("href={segment.href}");
    expect(renderer).toContain("title={segment.href}");
    // Opening the link must not navigate the app itself away from the thread.
    expect(renderer).toContain('target="_blank"');
    expect(renderer).toContain('rel="noreferrer noopener"');
  });
});
