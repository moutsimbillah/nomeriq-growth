import type { AiProviderRow } from "@/lib/ai/registry";
import type { ChatTokenUsage } from "@/lib/ai/chat-usage";
import type { ResearchModelUsage } from "./research-provider";
import { estimateDeepSeekModelCost } from "./provider";

export function officialDeepSeek(row: Pick<AiProviderRow, "provider" | "baseUrl">): boolean {
  try {
    const url = new URL(row.baseUrl);
    return row.provider === "deepseek" && url.origin === "https://api.deepseek.com" &&
      ["", "/", "/v1", "/v1/"].includes(url.pathname);
  } catch { return false; }
}
export function pricedResearchTool(row: AiProviderRow, operation: "search" | "fetch") {
  const path = operation === "search" ? row.searchPath : row.fetchPath;
  return officialDeepSeek(row) && (!path || path === `/v1/tools/${operation}`);
}
export function researchModelUsage(row: Pick<AiProviderRow, "provider" | "baseUrl" | "model">, result: { model: string; usage?: ChatTokenUsage | null }): ResearchModelUsage {
  const usage: ResearchModelUsage = { model: result.model,
    inputTokens: result.usage?.inputTokens ?? null, cachedInputTokens: result.usage?.cachedInputTokens ?? null,
    outputTokens: result.usage?.outputTokens ?? null, costUsd: null };
  // Price the explicitly configured official model, retaining the reported model for provenance.
  if (officialDeepSeek(row) && ["deepseek-flash", "deepseek-v4-pro"].includes(row.model) &&
    usage.inputTokens !== null && usage.outputTokens !== null) {
    usage.costUsd = estimateDeepSeekModelCost({ model: row.model, inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens ?? 0, outputTokens: usage.outputTokens });
  }
  return usage;
}
