import { decryptSecret } from "@/lib/auth/crypto";
import type { AiProviderRow } from "@/lib/ai/registry";
import { requestProviderChat } from "@/lib/ai/chat-transport";
import { cleanBaseUrl, DeepSeekError, deepseekFetchPage, deepseekSearch, parseJsonObject } from "@/lib/deepseek/provider";
import { officialDeepSeek, pricedResearchTool, researchModelUsage } from "./research-pricing";
import { ResearchAccountingError } from "./research-errors";
export { officialDeepSeek } from "./research-pricing";
import type { ResearchProvider, ResearchModelUsage } from "@/lib/deepseek/research-provider";
import { recordResearchUsage, type UsageInput } from "@/lib/services/research-usage";

class ResearchResponseError extends Error {
  constructor(message: string, readonly usage: ResearchModelUsage) { super(message); }
}

async function persistUsage(usage: UsageInput) {
  try { await recordResearchUsage(usage); }
  catch {
    throw new ResearchAccountingError();
  }
}

/** Capability checks, never price checks. A model-only API can use a separate Search/Fetch source. */
export function researchAdapterError(row: AiProviderRow, operation: "chat" | "search"): string | null {
  if (!row.isEnabled) return `${row.name} is disabled.`;
  try {
    const url = new URL(row.baseUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return `${row.name} has an invalid URL.`;
  } catch { return `${row.name} has an invalid URL.`; }
  if (operation === "search") {
    if (row.kinds === "chat") return `${row.name} is model-only. Choose a separate Search / Fetch source in Settings.`;
    if (!["deepseek", "custom"].includes(row.provider) && !(row.searchPath && row.fetchPath)) {
      return `${row.name} needs supported Search and Fetch endpoints. Choose a separate Search / Fetch source in Settings.`;
    }
  }
  try {
    if (!decryptSecret(row.encryptedApiKey).trim()) return `${row.name} has no stored API key.`;
  } catch { return `${row.name}: the stored key cannot be read. Enter it again in Settings.`; }
  return null;
}

/** One configured model + an independently configured, DeepSeek-compatible Search/Fetch source. */
export class ConfiguredResearchProvider implements ResearchProvider {
  lastUsedProvider: string | null = null;
  readonly lastUsedProviderFor: Partial<Record<"search" | "fetch" | "chat", string>> = {};
  private servedModel: string | null = null;
  private accountingError: Error | null = null;
  constructor(
    private readonly chat: AiProviderRow,
    private readonly source: AiProviderRow,
    private readonly qps: { search: number; fetch: number },
    private readonly jobId?: string,
  ) {}
  get model() { return this.servedModel ?? this.chat.model; }
  get recordsUsage() { return Boolean(this.jobId); }

  private async record(usage: UsageInput) {
    try { await persistUsage(usage); }
    catch (error) {
      this.accountingError = error as Error;
      throw error;
    }
  }

  private async call<T>(operation: "search" | "fetch" | "chat", row: AiProviderRow,
    run: () => Promise<{ value: T; usage: Omit<UsageInput, "jobId" | "provider" | "operation"> }>,
    metadata: Record<string, unknown> = {}): Promise<T> {
    if (this.accountingError) throw this.accountingError;
    this.lastUsedProvider = row.name;
    this.lastUsedProviderFor[operation] = row.name;
    let outcome;
    try { outcome = await run(); }
    catch (error) {
      const preflight = error instanceof DeepSeekError && ["invalid_query", "invalid_url"].includes(error.code);
      const unbilledTool = operation !== "chat" && pricedResearchTool(row, operation) &&
        error instanceof DeepSeekError && error.status >= 400;
      if (this.jobId) await this.record({ jobId: this.jobId, provider: row.name, operation,
        model: operation === "chat" ? row.model : null, costUsd: preflight || unbilledTool ? 0 : null,
        ...(error instanceof ResearchResponseError ? error.usage : {}), status: "error", requestCount: preflight || unbilledTool ? 0 : 1, metadata });
      if (operation !== "chat") throw new Error(`${operation === "search" ? "Search" : "Fetch"} request failed${error instanceof DeepSeekError && error.status ? ` (HTTP ${error.status})` : ""}.`);
      throw error;
    }
    if (this.jobId) await this.record({ ...outcome.usage, jobId: this.jobId, provider: row.name, operation });
    return outcome.value;
  }
  private sourceConfig() {
    return { apiKey: decryptSecret(this.source.encryptedApiKey), baseUrl: cleanBaseUrl(this.source.baseUrl),
      model: this.source.model, source: "database" as const, searchPath: this.source.searchPath, fetchPath: this.source.fetchPath };
  }
  async search(input: { query: string; count: number }) {
    return this.call("search", this.source, async () => {
      const result = await deepseekSearch(this.sourceConfig(), { ...input, qps: this.qps.search });
      const priced = pricedResearchTool(this.source, "search");
      const value = { results: result.results, costUsd: priced ? result.costUsd : null };
      return { value, usage: { costUsd: value.costUsd, requestCount: result.requestCount, metadata: { query: input.query, results: result.results.length } } };
    }, { query: input.query });
  }
  async fetch(input: { url: string }) {
    return this.call("fetch", this.source, async () => {
      const result = await deepseekFetchPage(this.sourceConfig(), { ...input, qps: this.qps.fetch });
      const priced = pricedResearchTool(this.source, "fetch");
      const value = { title: result.title, content: result.content, costUsd: priced ? result.costUsd : null };
      return { value, usage: { costUsd: value.costUsd, requestCount: result.requestCount, metadata: { pages: [input.url] } } };
    }, { pages: [input.url] });
  }
  async chatJson<T>(input: { system: string; user: string; maxTokens?: number }) {
    return this.call("chat", this.chat, async () => {
      const response = await requestProviderChat(this.chat, decryptSecret(this.chat.encryptedApiKey), {
        ...input, json: true, captureUsage: true, officialDeepSeekResearch: officialDeepSeek(this.chat),
        ...(officialDeepSeek(this.chat) ? { transientRetries: 2 } : {}),
      });
      if (!response.ok) throw new Error(response.reason);
      const usage = researchModelUsage(this.chat, response);
      let data: T;
      try { data = parseJsonObject(response.text) as T; }
      catch {
        // The call happened and may be billed even though its answer is unusable.
        throw new ResearchResponseError("Research model returned invalid JSON.", usage);
      }
      this.servedModel = response.model;
      return { value: { data, usage }, usage };
    });
  }
}
