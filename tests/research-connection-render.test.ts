import React from "react";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { ResearchConfiguration } from "@/lib/services/research-routing";
import type { ResearchJob } from "@/lib/types";
import { compileTsx } from "./helpers/tsx-loader";
// The app preserves JSX for Next; compile these real components for SSR without changing the
// repo-wide Vitest transform. Only framework/navigation and presentation children are replaced.
function component(file: string, name: string) {
  const code = compileTsx(file);
  const nativeRequire = createRequire(import.meta.url);
  const load = (id: string) => {
    if (id === "next/navigation") return { useRouter: () => ({ refresh: vi.fn() }) };
    if (id === "next/link") return (props: object) => React.createElement("a", props);
    if (id === "./client-ui") return { apiRequest: vi.fn(() => { throw new Error("Unexpected request"); }), InlineError: () => null };
    if (id === "./ui") return { Notice: () => null, ProgressBar: () => null };
    if (id === "./research-activity") return { ResearchActivityFeed: () => null, useResearchPump: () => ({ paused: false, running: false, setPaused: vi.fn() }) };
    return nativeRequire(id);
  };
  const mod = { exports: {} as Record<string, React.ComponentType<any>> };
  new Function("require", "module", "exports", code)(load, mod, mod.exports);
  return mod.exports[name];
}
const ResearchConnectionCard = component("src/components/research-connection.tsx", "ResearchConnectionCard");
const ResearchEnginePanel = component("src/components/research-engine.tsx", "ResearchEnginePanel");
const row = { id: "synthetic-id", name: "Growth synthetic", provider: "deepseek", kinds: "both", model: "deepseek-v4-pro", priority: 100, isEnabled: true, lastTestOk: true };
const configuration: ResearchConfiguration = { configured: true, assigned: row, selected: row, search: row, chain: [row], error: null, warnings: [] };
afterEach(() => vi.unstubAllGlobals());
function render(config = configuration) {
  vi.stubGlobal("React", React);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network"); }));
  return renderToStaticMarkup(React.createElement(ResearchConnectionCard, { configuration: config }));
}
it("renders effective provider/model, search source, explicit Test and providers link with zero network", () => {
  const html = render();
  expect(html).toContain("Research engine"); expect(html).toContain("Growth synthetic · deepseek-v4-pro");
  expect(html).toContain("Search / Fetch:"); expect(html).toContain("Test connection");
  expect(html).toContain('/settings#providers'); expect(html).not.toContain("DeepSeek is not configured");
  expect(fetch).not.toHaveBeenCalled();
});
it("renders an unavailable reason and Settings remedy instead of a false configured claim", () => {
  const html = render({ ...configuration, configured: false, selected: null, error: "Search source is unsupported", warnings: ["Choose official DeepSeek"] });
  expect(html).toContain("Search source is unsupported"); expect(html).toContain("Choose official DeepSeek");
  expect(html).toContain("Unavailable"); expect(html).not.toContain("Configured —");
});
it("renders the renamed panel, original job controls and budget display", () => {
  vi.stubGlobal("React", React); vi.stubGlobal("fetch", vi.fn());
  const job = { id: "synthetic-job", name: "Synthetic", status: "active", budgetUsd: 1, spentUsd: 0, targetCount: 5, verifiedCount: 0 } as ResearchJob;
  const html = renderToStaticMarkup(React.createElement(ResearchEnginePanel, { job, configured: true }));
  expect(html).toContain("Research engine");
  expect(html).toContain("Research spend");
  expect(html).toContain("Pause");
  expect(html).toContain("This tab is advancing the job");
  expect(fetch).not.toHaveBeenCalled();
});
