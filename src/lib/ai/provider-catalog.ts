/**
 * The provider catalog: which providers exist, what each one defaults to, and what it can do.
 *
 * Deliberately a plain data module with no imports at all, so both the server (`@/lib/ai/registry`)
 * and the Settings screen can read the same list. The registry needs the server-only pieces — the
 * database client and the key encryption — which cannot be pulled into a client bundle, and a
 * second copy on the client is exactly how the two drift apart. One list, imported by both.
 *
 * `kinds` is what a row can actually do: `chat` (writes text and must name a model), `search` (a
 * search API usable with any model, so it has no model of its own) or `both`. Brave is `search` —
 * that is the whole point of separating the model from the search source.
 */

export const PROVIDER_KINDS = ["chat", "search", "both"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ProviderDefault {
  /** Shown in Settings. */
  label: string;
  /** Used when the founder leaves the base URL empty. */
  baseUrl: string;
  /** Used when the founder leaves the model empty. Empty means the provider has no model. */
  model: string;
  kinds: ProviderKind;
  /** A short line for the Settings form, explaining what this provider is for. */
  hint: string;
}

export const PROVIDER_CATALOG: Record<string, ProviderDefault> = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    kinds: "both",
    hint: "Chat plus its own web search and fetch endpoints.",
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com",
    model: "gpt-5.4",
    kinds: "chat",
    hint: "A model to write with. Searches through the search source you choose.",
  },
  anthropic: {
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    kinds: "chat",
    hint: "A model to write with. Searches through the search source you choose.",
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-3.8-flash",
    kinds: "chat",
    hint: "A model to write with. Searches through the search source you choose.",
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    model: "openai/gpt-5",
    kinds: "both",
    hint: "Many models behind one key, with its own web search.",
  },
  brave: {
    label: "Brave Search (search only, no model)",
    baseUrl: "https://api.search.brave.com",
    // Brave has no model at all: it is a search API usable with any model.
    model: "",
    kinds: "search",
    hint: "Finds pages for any model. It can never be chosen to write text.",
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    baseUrl: "",
    model: "",
    kinds: "chat",
    hint: "Any gateway that speaks the OpenAI chat-completions shape.",
  },
};

/** The provider slugs migration 025's CHECK constraint allows. */
export const PROVIDER_SLUGS = Object.keys(PROVIDER_CATALOG);
