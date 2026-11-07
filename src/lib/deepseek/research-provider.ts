import {
  DEEPSEEK_FETCH_COST_USD,
  DEEPSEEK_SEARCH_COST_USD,
  deepseekChatJson,
  deepseekFetchPage,
  deepseekSearch,
  resolveDeepSeekConfig,
  type DeepSeekConfig,
  type DeepSeekSearchResult,
  type DeepSeekUsage,
} from "@/lib/deepseek/provider";

/**
 * The engine talks to the outside world only through this interface. Production
 * uses the real DeepSeek Search/Fetch/model adapters; tests inject a deterministic
 * fake so the whole engine can be exercised without a live API key or network.
 */
export interface ResearchProvider {
  readonly model: string;
  /** Set by a failover pool after a call, so usage is attributed to whoever served it. */
  readonly lastUsedProvider?: string | null;
  /** Separate sources keep operation attribution after a later chat call changes lastUsedProvider. */
  readonly lastUsedProviderFor?: Partial<Record<"search" | "fetch" | "chat", string>>;
  search(input: {
    query: string;
    count: number;
  }): Promise<{ results: DeepSeekSearchResult[]; costUsd: number }>;
  fetch(input: {
    url: string;
  }): Promise<{ title: string; content: string; costUsd: number }>;
  chatJson<T>(input: {
    system: string;
    user: string;
    maxTokens?: number;
  }): Promise<{ data: T; usage: DeepSeekUsage }>;
}

export class DeepSeekResearchProvider implements ResearchProvider {
  constructor(
    private readonly config: DeepSeekConfig,
    private readonly qps: { search: number; fetch: number } = {
      search: 2,
      fetch: 1,
    },
  ) {}

  get model(): string {
    return this.config.model;
  }

  async search(input: { query: string; count: number }) {
    const result = await deepseekSearch(this.config, {
      query: input.query,
      count: input.count,
      qps: this.qps.search,
    });
    return { results: result.results, costUsd: result.costUsd };
  }

  async fetch(input: { url: string }) {
    const page = await deepseekFetchPage(this.config, {
      url: input.url,
      qps: this.qps.fetch,
    });
    return { title: page.title, content: page.content, costUsd: page.costUsd };
  }

  async chatJson<T>(input: {
    system: string;
    user: string;
    maxTokens?: number;
  }) {
    const result = await deepseekChatJson<T>(this.config, {
      system: input.system,
      user: input.user,
      maxTokens: input.maxTokens,
      temperature: 0.2,
    });
    return { data: result.data, usage: result.usage };
  }
}

export interface ProviderResolution {
  provider: ResearchProvider | null;
  error: string | null;
  model: string | null;
}

/**
 * Resolves a live provider from stored or environment credentials. Returns a
 * descriptive error instead of throwing so a caller can pause the job honestly
 * rather than reporting fabricated progress.
 */
export async function resolveResearchProvider(input: {
  searchQps: number;
  fetchQps: number;
}): Promise<ProviderResolution> {
  const resolved = await resolveDeepSeekConfig();
  if (!resolved.config) {
    return { provider: null, error: resolved.error, model: null };
  }
  return {
    provider: new DeepSeekResearchProvider(resolved.config, {
      search: input.searchQps,
      fetch: input.fetchQps,
    }),
    error: null,
    model: resolved.config.model,
  };
}

export const SEARCH_RESULT_COST_USD = DEEPSEEK_SEARCH_COST_USD;
export const FETCH_RESULT_COST_USD = DEEPSEEK_FETCH_COST_USD;
