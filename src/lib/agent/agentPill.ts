import type { AgentTag } from "@/lib/types";

import { AGENT_LABELS } from "./agentTag";

/**
 * How an agent tag looks. Colour is decoration, never the message: every pill carries the agent's
 * name as text, so the tag stays readable in greyscale, to a colour-blind founder, and in a printed
 * screenshot. These are the only strings involved — no React here, so the map can be tested directly.
 *
 * The size is deliberately one step larger and bolder than the domain text beside it (11px, semibold),
 * because the agent is what the founder scans a list for.
 */
export const AGENT_PILL_CLASS: Record<AgentTag, string> = {
  // warm orange
  claude: "border-[#efb083] bg-[#fff2e8] text-[#8a3d05]",
  // green
  chatgpt: "border-[#9ed4ae] bg-[#e9f7ee] text-[#14653a]",
  // blue
  gemini: "border-[#a7c7f2] bg-[#e9f1fd] text-[#123f7a]",
  // indigo
  deepseek: "border-[#b7b3ee] bg-[#edecfc] text-[#2f2a8d]",
  // purple
  hermes: "border-[#d2ade8] bg-[#f7ecfc] text-[#6a1f8b]",
  // dark ink, inverted
  founder: "border-[#1f2422] bg-[#1f2422] text-[#f7f8f6]",
  // grey, dashed: a name we could not confirm against a known agent
  other: "border-dashed border-[#9b9b94] bg-[#f5f5f2] text-[#3f3f3a]",
  // light grey: nothing recorded at all
  unknown: "border-[#e3e3dd] bg-[#fafaf7] text-[#7c7c74]",
};

/** Shared shape: larger and bolder than the domain text, same height on every row. */
export const AGENT_PILL_BASE =
  "inline-flex max-w-full shrink-0 items-center gap-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-full border px-2.5 py-[3px] text-[12.5px] font-bold leading-[1.35] tracking-[0.01em]";

/**
 * "Claude", or "Other · Claude Pro" — the connector's own name is shown whenever the agent could not
 * be matched to a known one, so the founder can see who actually saved the row.
 */
export function agentPillLabel(tag: AgentTag | null, client?: string | null): string {
  const label = tag ? AGENT_LABELS[tag] : AGENT_LABELS.unknown;
  if (tag === "other" && client && client.trim()) return `${label} · ${client.trim()}`;
  return label;
}