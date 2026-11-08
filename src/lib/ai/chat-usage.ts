/** Reported counters only. Missing/malformed usage is unknown, never an invented zero. */
export interface ChatTokenUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
}

function counter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function extractChatUsage(provider: string, raw: string): ChatTokenUsage | null {
  let inputTokens: number | null = null;
  let cachedInputTokens: number | null = null;
  let outputTokens: number | null = null;
  const accept = (value: unknown) => {
    const payload = value as {
      usage?: Record<string, unknown>;
      message?: { usage?: Record<string, unknown> };
      usageMetadata?: Record<string, unknown>;
    } | null;
    const usage = payload?.usage ?? payload?.message?.usage;
    if (provider === "gemini") {
      inputTokens = counter(payload?.usageMetadata?.promptTokenCount) ?? inputTokens;
      cachedInputTokens = counter(payload?.usageMetadata?.cachedContentTokenCount) ?? cachedInputTokens;
      const candidates = counter(payload?.usageMetadata?.candidatesTokenCount);
      const thoughts = counter(payload?.usageMetadata?.thoughtsTokenCount);
      if (candidates !== null) outputTokens = candidates + (thoughts ?? 0);
    } else if (provider === "anthropic") {
      const uncached = counter(usage?.input_tokens);
      const read = counter(usage?.cache_read_input_tokens);
      const written = counter(usage?.cache_creation_input_tokens);
      if (uncached !== null) inputTokens = uncached + (read ?? 0) + (written ?? 0);
      cachedInputTokens = read ?? cachedInputTokens;
      outputTokens = counter(usage?.output_tokens) ?? outputTokens;
    } else {
      inputTokens = counter(usage?.prompt_tokens) ?? inputTokens;
      const details = usage?.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
      cachedInputTokens = counter(usage?.prompt_cache_hit_tokens) ?? counter(details?.cached_tokens) ?? cachedInputTokens;
      outputTokens = counter(usage?.completion_tokens) ?? outputTokens;
    }
  };
  if (raw.trimStart().startsWith("data:") || raw.includes("\ndata:")) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data && data !== "[DONE]") accept(JSON.parse(data));
    }
  } else accept(JSON.parse(raw));
  return inputTokens === null && cachedInputTokens === null && outputTokens === null
    ? null : { inputTokens, cachedInputTokens, outputTokens };
}
