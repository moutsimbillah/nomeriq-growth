import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The type scale is a rule, not a preference: one set of sizes, nothing below 12px, every UI
 * component in the sans face. These tests scan the source, because the failure mode is a new
 * `text-[11px]` slipping into a file nobody re-read.
 */

const SRC = "src";
const SCALE = new Set([
  "text-12", "text-13", "text-14", "text-16", "text-20", "text-28",
  // serif page titles
  "text-display-sm", "text-display", "text-display-lg", "text-display-hero",
]);
const MIN_PX = 12;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(tsx|ts|css)$/.test(name) ? [full] : [];
  });
}

const SOURCES = files(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

describe("one type scale", () => {
  it("has no hard-coded pixel font size anywhere", () => {
    const offenders: string[] = [];
    for (const { path, text } of SOURCES) {
      for (const match of text.matchAll(/text-\[\d+(?:\.\d+)?px\]/g)) {
        offenders.push(`${path}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has nothing below 12px, including footnotes, sub-lines and badges", () => {
    const offenders: string[] = [];
    for (const { path, text } of SOURCES) {
      // font-size in CSS, and any arbitrary pixel size, must be at least 12
      for (const match of text.matchAll(/font-size:\s*([\d.]+)px/g)) {
        if (Number(match[1]) < MIN_PX) offenders.push(`${path}: font-size ${match[1]}px`);
      }
      for (const match of text.matchAll(/text-\[([\d.]+)px\]/g)) {
        if (Number(match[1]) < MIN_PX) offenders.push(`${path}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses only sizes from the scale", () => {
    const unknown = new Set<string>();
    for (const { text } of SOURCES) {
      // the theme declares its tokens as --text-… custom properties; only utility CLASS names count
      for (const match of text.matchAll(/(?<!-)text-(display[a-z-]*|\d+)\b/g)) {
        if (!SCALE.has(match[0])) unknown.add(match[0]);
      }
    }
    expect([...unknown]).toEqual([]);
  });

  it("keeps the scale small — six sans steps and the serif titles", () => {
    const sans = [...SCALE].filter((token) => !token.startsWith("text-display"));
    expect(sans).toEqual(["text-12", "text-13", "text-14", "text-16", "text-20", "text-28"]);
  });
});

describe("serif stays on titles", () => {
  it("is never used inside a pill, badge or other UI chrome", () => {
    const chrome = SOURCES.filter(({ path }) => /agentPill\.ts$/.test(path));
    expect(chrome.length).toBeGreaterThan(0);
    for (const { path, text } of chrome) {
      expect(text, path).not.toContain("font-display");
      expect(text, path).not.toContain("font-serif");
    }
  });

  it("renders the pill in the sans face with normal tracking", () => {
    const pill = readFileSync("src/lib/agent/agentPill.ts", "utf8");
    expect(pill).toContain("font-sans");
    expect(pill).toContain("tracking-normal");
    expect(pill).not.toMatch(/tracking-\[-/);
  });

  it("keeps the display serif on page titles only", () => {
    const allowed = new Set([
      "src/components/ui.tsx",            // PageHeader h1
      "src/components/auth-shell.tsx",    // sign-in titles
      "src/components/unsubscribe-form.tsx",
      "src/app/(app)/dashboard/page.tsx", // an h2 page title
      "src/app/globals.css",              // the token definitions themselves
    ]);
    const offenders: string[] = [];
    for (const { path, text } of SOURCES) {
      const uses = text.includes("display-title") || text.includes("font-display");
      const normalised = path.replace(/\\/g, "/");
      if (uses && ![...allowed].some((a) => normalised.endsWith(a.replace("src/", "")) || normalised === a)) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("UI chrome is sans with normal letter spacing", () => {
  it("has no negative tracking inside the shared badge, pill or button classes", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    for (const block of [".badge", ".pill", ".btn", ".table th", ".table td"]) {
      const start = css.indexOf(block);
      expect(start, block).toBeGreaterThan(-1);
      const body = css.slice(start, css.indexOf("}", start));
      expect(body, block).not.toMatch(/tracking-\[-/);
    }
  });
});