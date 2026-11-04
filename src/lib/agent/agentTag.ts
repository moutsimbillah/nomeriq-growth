import type { AgentTag, ChannelTag } from "@/lib/types";

/**
 * Where a lead or draft came from, as a normalised pair.
 *
 * The agent is who produced it; the channel is how it arrived. They are reporting only: nothing in
 * the codebase may read either one for permissions, scopes or trust. The client name behind an OAuth
 * connector is self-declared, so it is mapped by exact match and anything unrecognised becomes
 * `other` — with the sanitised name kept separately in `source_client` for a human to read.
 */

export const AGENT_TAGS: AgentTag[] = [
  "claude",
  "chatgpt",
  "gemini",
  "hermes",
  "deepseek",
  "founder",
  "other",
  "unknown",
];

export const CHANNEL_TAGS: ChannelTag[] = ["mcp_oauth", "api_key", "engine", "founder", "legacy_import"];

export const AGENT_LABELS: Record<AgentTag, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  hermes: "Hermes",
  deepseek: "DeepSeek engine",
  founder: "Founder",
  other: "Other",
  unknown: "Unknown",
};

export const CHANNEL_LABELS: Record<ChannelTag, string> = {
  mcp_oauth: "MCP OAuth connector",
  api_key: "API key",
  engine: "Research engine",
  founder: "Portal",
  legacy_import: "Old portal import",
};

/** Exact, case-insensitive match on a connector's self-declared name. Anything else is `other`. */
export function agentFromClientName(name: string | null | undefined): AgentTag {
  const key = (name ?? "").trim().toLowerCase();
  if (key === "claude" || key === "claude.ai") return "claude";
  if (key === "chatgpt" || key === "openai") return "chatgpt";
  if (key === "gemini" || key === "google gemini") return "gemini";
  return "other";
}

/** An API key's assistant label is chosen by the founder, so it can be trusted as a label. */
export function agentFromAssistantLabel(assistant: string | null | undefined): AgentTag {
  switch ((assistant ?? "").trim().toLowerCase()) {
    case "claude":
      return "claude";
    case "chatgpt":
      return "chatgpt";
    case "hermes":
      return "hermes";
    case "deepseek":
      return "deepseek";
    default:
      return "other";
  }
}

/** Falls back to the actor recorded on the row when no explicit tags are supplied. */
export function tagsFromActorType(actorType: string | null | undefined): {
  agent: AgentTag;
  channel: ChannelTag;
} {
  switch ((actorType ?? "").trim().toLowerCase()) {
    case "founder":
    case "seed":
      return { agent: "founder", channel: "founder" };
    case "deepseek":
      return { agent: "deepseek", channel: "engine" };
    case "claude":
      return { agent: "claude", channel: "api_key" };
    case "chatgpt":
      return { agent: "chatgpt", channel: "api_key" };
    case "legacy":
      // An imported row: the channel says where it came from, and the agent says nothing, because the
      // import sets it from the old portal's research client rather than from this fallback.
      return { agent: "unknown", channel: "legacy_import" };
    default:
      return { agent: "unknown", channel: "founder" };
  }
}

/**
 * The tags for an agent call. The channel comes from how the identity was minted — an OAuth access
 * token or an API key — and the agent from the trustworthy label on a key, or from an exact-name
 * match on a connector.
 */
export function tagsForAgentCall(key: {
  id: string;
  name: string;
  assistant: string;
}): { agent: AgentTag; channel: ChannelTag } {
  if (key.id.startsWith("oauth:")) {
    return { agent: agentFromClientName(key.name), channel: "mcp_oauth" };
  }
  return { agent: agentFromAssistantLabel(key.assistant), channel: "api_key" };
}

/** The tooltip that explains where a pill's value came from. */
export function agentProvenance(tag: AgentTag | null, channel: ChannelTag | null): string {
  if (channel === "mcp_oauth") return "Reported by the connector, not verified";
  if (channel === "api_key") return "Set by the API key you created";
  if (channel === "engine") return "Recorded by the research engine";
  if (channel === "founder") return "Added in the portal";
  if (channel === "legacy_import") return "Imported from the old portal — not researched here";
  return tag ? "Origin not recorded" : "Origin unknown";
}