/**
 * Who wrote a draft, in one sentence, the same everywhere a draft is listed (browser-safe).
 *
 * An assistant connected through MCP is named as the drafter; an AI action names the provider by
 * its Settings name and the model; anything else came from the standard template and says so, so a
 * template is never mistaken for AI writing.
 */
export function draftProvenance<A extends string>(draft: {
  aiGenerated: boolean;
  aiModel: string | null;
  aiProvider?: string | null;
  sourceAgent?: A | null;
  sourceClient?: string | null;
}, agentLabel?: (agent: A, client: string | null) => string): string {
  if (draft.sourceAgent) {
    return `Drafted by ${agentLabel ? agentLabel(draft.sourceAgent, draft.sourceClient ?? null) : draft.sourceAgent}`;
  }
  if (draft.aiGenerated) {
    const who = [draft.aiProvider, draft.aiModel].filter(Boolean).join(" · ") || draft.sourceClient || "AI";
    return `Written by ${who}`;
  }
  return "No-AI fallback — standard template";
}
