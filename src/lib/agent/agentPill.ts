import type { AgentTag } from "@/lib/types";

import { AGENT_LABELS } from "./agentTag";

/**
 * How an agent tag looks, in two candidate treatments. Colour is decoration, never the message: every
 * pill spells the agent's name, so the tag survives greyscale, colour blindness and a printed page.
 *
 * Plain strings and numbers only — no React — so the palette, the class maps and the contrast ratios
 * can all be tested directly.
 *
 * Deliberately distinct from the other two pill families: a stage pill is a soft pastel with a leading
 * dot and a market pill is a neutral grey outline, both at 12px. An agent pill is 13px bold (14px in a
 * page header) and either solid filled or a striped card, so the three never read as the same thing.
 */

export type AgentPillVariant = "A" | "B";

/** The treatment the whole app uses. Set by the founder's choice; the preview page renders both. */
export const AGENT_PILL_VARIANT: AgentPillVariant = "A";

export interface AgentColour {
  /** the agent's true colour: the dot, the stripe and the border */
  accent: string;
  /** the fill (option A), as the accent at FILL_ALPHA opacity over the panel behind it */
  tint: string;
  /** text on the tinted fill (option A) */
  onFill: string;
  /** text on white (option B) */
  ink: string;
  /** option A's background */
  fill: string;
  /** the small leading mark (option A) */
  mark: string;
  dashed?: boolean;
}

/**
 * The panel the pill sits on, and the fraction of the agent's colour its fill keeps.
 *
 * The fill and border are BAKED as hex rather than written as `/50` opacity utilities: Tailwind v4
 * composites an opacity modifier in oklab, which lands on a slightly different colour from the sRGB
 * blend the contrast test measures. Baking keeps the pill and its test talking about one colour.
 */
export const PANEL = "#fbfaf6";
export const FILL_ALPHA = 0.5;
export const BORDER_ALPHA = 0.7;

/** A colour laid over the panel at the given strength. */
export function overPanel(colour: string, alpha: number): string {
  const parse = (h: string) => [0, 2, 4].map((i) => parseInt(h.replace("#", "").slice(i, i + 2), 16));
  const [r1, g1, b1] = parse(colour);
  const [r2, g2, b2] = parse(PANEL);
  const mix = (a: number, b: number) => Math.round(alpha * a + (1 - alpha) * b);
  return `#${[mix(r1, r2), mix(g1, g2), mix(b1, b2)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** The fill colour: the accent at half strength over the panel. */
export function tintOf(accent: string): string {
  return overPanel(accent, FILL_ALPHA);
}

/** The border: the same colour, a little stronger than the fill. */
export function borderOf(accent: string): string {
  return overPanel(accent, BORDER_ALPHA);
}

export const AGENT_COLOURS: Record<AgentTag, AgentColour> = {
  // terracotta
  claude:   { accent: "#a83a1b", tint: tintOf("#a83a1b"), onFill: "#17221a", ink: "#17221a", fill: "#a83a1b", mark: "#a83a1b" },
  // green
  chatgpt:  { accent: "#1a7a45", tint: tintOf("#1a7a45"), onFill: "#17221a", ink: "#17221a", fill: "#1a7a45", mark: "#1a7a45" },
  // blue
  gemini:   { accent: "#1a4fd6", tint: tintOf("#1a4fd6"), onFill: "#17221a", ink: "#17221a", fill: "#1a4fd6", mark: "#1a4fd6" },
  // indigo
  deepseek: { accent: "#3a34a8", tint: tintOf("#3a34a8"), onFill: "#17221a", ink: "#17221a", fill: "#3a34a8", mark: "#3a34a8" },
  // purple
  hermes:   { accent: "#7a1fa2", tint: tintOf("#7a1fa2"), onFill: "#17221a", ink: "#17221a", fill: "#7a1fa2", mark: "#7a1fa2" },
  // near-black
  founder:  { accent: "#14181b", tint: tintOf("#14181b"), onFill: "#17221a", ink: "#17221a", fill: "#14181b", mark: "#14181b" },
  // a name we could not match: dashed outline, never a fill
  other:    { accent: "#8a8a80", tint: "#f5f5f2", onFill: "#3f3f3a", ink: "#3f3f3a", fill: "#f5f5f2", mark: "#8a8a80", dashed: true },
  // nothing recorded at all: the palest outline that still clears 4.5:1
  unknown:  { accent: "#c9c9c0", tint: "#fafaf7", onFill: "#67675f", ink: "#67675f", fill: "#fafaf7", mark: "#b4b4a9" },
};

/**
 * Option A, as chosen: the agent's colour at half strength for the fill, a stronger version of the same
 * colour for the border, a full-strength dot, and dark text. White text was not survivable at this
 * opacity — it would need 82% or more to clear 4.5:1 — so the fill lightened and the text darkened.
 */
export const AGENT_PILL_A: Record<AgentTag, string> = {
  claude:  "border border-[#c1745d] bg-[#d29a89] text-[#17221a]",
  chatgpt:  "border border-[#5ea07a] bg-[#8bba9e] text-[#17221a]",
  gemini:  "border border-[#5e82e0] bg-[#8ba5e6] text-[#17221a]",
  deepseek:  "border border-[#746fbf] bg-[#9b97cf] text-[#17221a]",
  hermes:  "border border-[#a161bb] bg-[#bb8dcc] text-[#17221a]",
  founder:  "border border-[#595c5d] bg-[#888989] text-[#17221a]",
  other:    "border border-dashed border-[#8a8a80] bg-[#f5f5f2] text-[#3f3f3a]",
  unknown:  "border border-[#c9c9c0] bg-[#fafaf7] text-[#67675f]",
};

/** Option A's leading mark. */
export const AGENT_PILL_A_MARK: Record<AgentTag, string> = {
  claude: "bg-[#a83a1b]", chatgpt: "bg-[#1a7a45]", gemini: "bg-[#1a4fd6]",
  deepseek: "bg-[#3a34a8]", hermes: "bg-[#7a1fa2]", founder: "bg-[#14181b]",
  other: "bg-[#8a8a80]", unknown: "bg-[#a9a9a0]",
};

/** Option B: white card, a 2px coloured left stripe, a coloured dot, dark text, a thin coloured border. */
export const AGENT_PILL_B: Record<AgentTag, string> = {
  claude:   "border border-[#a83a1b]/40 bg-white text-[#17221a]",
  chatgpt:  "border border-[#1a7a45]/40 bg-white text-[#17221a]",
  gemini:   "border border-[#1a4fd6]/40 bg-white text-[#17221a]",
  deepseek: "border border-[#3a34a8]/40 bg-white text-[#17221a]",
  hermes:   "border border-[#7a1fa2]/40 bg-white text-[#17221a]",
  founder:  "border border-[#14181b]/45 bg-white text-[#17221a]",
  other:    "border border-dashed border-[#8a8a80]/60 bg-white text-[#3f3f3a]",
  unknown:  "border border-[#c9c9c0] bg-white text-[#67675f]",
};

/** Option B's left stripe. */
export const AGENT_PILL_B_STRIPE: Record<AgentTag, string> = {
  claude: "bg-[#a83a1b]", chatgpt: "bg-[#1a7a45]", gemini: "bg-[#1a4fd6]",
  deepseek: "bg-[#3a34a8]", hermes: "bg-[#7a1fa2]", founder: "bg-[#14181b]",
  other: "bg-[#8a8a80]", unknown: "bg-[#c9c9c0]",
};

/**
 * Shared shape: sans, normal tracking, never a serif — this is chrome, not a title — and capped to its
 * container so a 290-character connector name cannot widen a row.
 */
export const AGENT_PILL_BASE =
  "inline-flex max-w-full shrink-0 items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap rounded-full font-sans font-bold tracking-normal leading-[1.35]";

export const AGENT_PILL_SIZE = {
  md: "py-1 pl-1.5 pr-2.5 text-13",
  lg: "py-1 pl-2 pr-3 text-14",
} as const;

/** The letter on the mark: the agent's own initial, never a status dot. */
export function agentInitial(tag: AgentTag | null): string {
  return (AGENT_LABELS[tag ?? "unknown"] ?? "?").slice(0, 1).toUpperCase();
}

/**
 * "Claude", or "Other · Claude Pro" — the connector's own name is shown whenever the agent could not
 * be matched to a known one, so the founder can see who actually saved the row.
 */
export function agentPillLabel(tag: AgentTag | null, client?: string | null): string {
  const label = tag ? AGENT_LABELS[tag] : AGENT_LABELS.unknown;
  if (tag === "other" && client && client.trim()) return `${label} · ${client.trim()}`;
  return label;
}

/* ------------------------------------------------------------------ contrast */

function channel(value: number): number {
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours. */
export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}