/**
 * How a sending profile looks.
 *
 * A third pill family, and deliberately the quietest one: the sender is context, not a claim about who
 * did the work, so it is a neutral outline with a small coloured dot rather than a filled badge. The
 * colours come from their own palette, which shares nothing with the agent palette — an agent pill and
 * a sender pill must never be mistakable for one another. Colour is decoration only: every pill spells
 * the profile's name, so it survives greyscale, colour blindness and a printed page.
 *
 * Plain strings only — no React — so the palette and the contrast ratios can be tested directly.
 */

import { AGENT_COLOURS } from "@/lib/agent/agentPill";

/** The panel behind the pill, as in the agent palette. */
const PANEL = "#fbfaf6";

/** The pill's own colours: an outline, dark ink and a full-strength dot. */
export const SENDER_PILL_FILL = "#f2f2ee";
export const SENDER_PILL_BORDER = "#cfcfc6";
export const SENDER_PILL_INK = "#26261f";
export const SENDER_DEFAULT_DOT = "#7a7a71";

/**
 * The dot palette. Every one of these is checked against the agent palette in the test, so a sender can
 * never wear an agent's colour.
 */
export const SENDER_DOT_COLOURS = [
  "#0f6f73", // teal
  "#5d6a1f", // olive
  "#7a3550", // plum
  "#8a5a1f", // amber-brown
  "#4a5568", // slate
  "#146b8c", // cyan
] as const;

/** What a sender pill needs to know: an id to colour by, and a label to show. */
export interface SenderPillInput {
  id: string | null;
  label: string | null;
}

/** The part after the @: what a prospect actually sees as the sender. */
export function domainOf(address: string | null | undefined): string {
  const value = (address ?? "").trim();
  if (!value) return "unknown";
  const at = value.indexOf("@");
  return at === -1 ? value : value.slice(at + 1) || "unknown";
}

/**
 * A label per profile, by domain — which is what the prospect sees.
 *
 * Two profiles can share a domain (a personal mailbox and a team one); then the domain alone would be
 * ambiguous, so those are shown in full, local part and all. Nothing is truncated to a guess.
 */
export function senderLabels(
  profiles: { id: string; emailAddress?: string | null }[],
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const profile of profiles) {
    const domain = domainOf(profile.emailAddress);
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const profile of profiles) {
    const domain = domainOf(profile.emailAddress);
    const shared = (counts.get(domain) ?? 0) > 1;
    labels.set(profile.id, shared ? (profile.emailAddress ?? domain).trim() : domain);
  }
  return labels;
}

/**
 * What a lead with no sender of its own shows, wherever the sender is shown.
 *
 * The lead has not been pinned to a mailbox, so it names none. A domain here would be a claim the lead
 * cannot back — which is exactly how nomeriq.com, the import's own mailbox, came to be shown on leads the
 * import never pinned to it.
 */
export const NO_SENDER_LABEL = "No sender yet";

/**
 * The label for a lead that is not pinned yet: it has no sender of its own, so name the profile that
 * would send — its domain — and say that it is the default. Never the bare word "default": the founder
 * should be able to read which mailbox a press of Send would use.
 *
 * A profile that may never be the default (the import's own mailbox) is not one that would send, so it is
 * never named — the lead has no sender yet, and saying otherwise would name a mailbox it was never
 * assigned.
 */
export function defaultSenderLabel(
  defaultProfile: { emailAddress?: string | null; neverDefault?: boolean } | null,
): string {
  if (defaultProfile?.neverDefault) return NO_SENDER_LABEL;
  const domain = defaultProfile ? domainOf(defaultProfile.emailAddress) : "";
  return domain && domain !== "unknown" ? `${domain} · default` : "default";
}

/** The profile's short name: its domain (what a prospect sees), or its name when it has no address. */
export function senderShortName(input: { name?: string | null; emailAddress?: string | null }): string {
  const address = (input.emailAddress ?? "").trim();
  if (address) return domainOf(address);
  const name = (input.name ?? "").trim();
  return name || "unknown";
}

/**
 * The label under the dot. A lead that is not pinned to anything yet has no sender of its own — it will
 * go out from the default profile — so it says so rather than naming a mailbox it has not used.
 */
export function senderPillLabel(profile: SenderPillInput | null): string {
  // The caller composes the label (a domain, "local@domain" when two profiles share one, or
  // "domain · default" for a lead with no profile yet), so take it as given.
  const label = (profile?.label ?? "").trim();
  if (label) return label;
  return profile?.id ? "unknown" : "default";
}

/** Deterministic, so a profile keeps its colour across pages, sessions and restarts. */
export function senderDotColour(id: string | null): string {
  if (!id) return SENDER_DEFAULT_DOT;
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 1_000_003;
  }
  return SENDER_DOT_COLOURS[hash % SENDER_DOT_COLOURS.length];
}

/**
 * The dot's class, per colour.
 *
 * BAKED as literal strings rather than assembled from a variable: Tailwind scans source text for class
 * names, so a class built at runtime is never emitted into the stylesheet and the dot would render with
 * no colour at all. The same reason the agent palette writes its fills out in full.
 */
export const SENDER_DOT_CLASS: Record<string, string> = {
  "#0f6f73": "bg-[#0f6f73]",
  "#5d6a1f": "bg-[#5d6a1f]",
  "#7a3550": "bg-[#7a3550]",
  "#8a5a1f": "bg-[#8a5a1f]",
  "#4a5568": "bg-[#4a5568]",
  "#146b8c": "bg-[#146b8c]",
  [SENDER_DEFAULT_DOT]: "bg-[#7a7a71]",
};

/** The dot itself. */
export function senderDotClass(id: string | null): string {
  return SENDER_DOT_CLASS[senderDotColour(id)] ?? "bg-[#7a7a71]";
}

/**
 * Shared shape: sans, normal tracking, never a serif — chrome, not a title — and capped to its container
 * so a long mailbox name cannot widen a row.
 */
export const SENDER_PILL_BASE =
  "inline-flex max-w-full shrink-0 items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap rounded-full font-sans font-bold tracking-normal leading-[1.35] border";

// Written out in full, for the same reason as the dots: Tailwind only sees literal class names.
export const SENDER_PILL_LOOK = "border-[#cfcfc6] bg-[#f2f2ee] text-[#26261f]";

export const SENDER_PILL_SIZE = {
  md: "py-1 pl-1.5 pr-2.5 text-13",
  lg: "py-1 pl-2 pr-3 text-14",
} as const;

export const SENDER_PILL_CLASS = `${SENDER_PILL_BASE} ${SENDER_PILL_LOOK}`;

/**
 * The colours the test must keep apart: the sender dots, versus every accent, fill and mark the agent
 * pills can paint. Exported so the rule lives beside the palette it protects.
 */
export function allSenderColours(): string[] {
  return [...SENDER_DOT_COLOURS, SENDER_DEFAULT_DOT, SENDER_PILL_FILL, SENDER_PILL_BORDER, SENDER_PILL_INK, PANEL];
}

export function allAgentColours(): string[] {
  return Object.values(AGENT_COLOURS).flatMap((colour) => [
    colour.accent,
    colour.tint,
    colour.onFill,
    colour.ink,
    colour.fill,
    colour.mark,
  ]);
}
