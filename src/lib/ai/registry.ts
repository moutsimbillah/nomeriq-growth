import { decryptSecret } from "@/lib/auth/crypto";
import { getDb, type DbClient } from "@/lib/db/client";
import { AppError } from "@/lib/utils";
import { requestProviderChat, type ChatInput, type ChatAttemptFailure, type TransportResult } from "@/lib/ai/chat-transport";
import { PROVIDER_CATALOG, PROVIDER_KINDS, type ProviderKind } from "@/lib/ai/provider-catalog";
import { AI_TASKS, AI_TASK_LABELS, chatCapability, searchCapability, chatFallbacks, workingChatProvider, type AiTask } from "@/lib/ai/routing";
export { AI_TASKS, AI_TASK_LABELS, chatCapability, searchCapability } from "@/lib/ai/routing";
export type { AiTask } from "@/lib/ai/routing";

export { PROVIDER_KINDS } from "@/lib/ai/provider-catalog";
export type { ProviderKind } from "@/lib/ai/provider-catalog";

/**
 * The provider registry the AI actions read.
 *
 * `research_providers` (widened in migration 025) is the one place a provider is configured: base
 * URL, model, encrypted key, search and fetch paths, and `kinds` — what the row can actually do.
 * This module turns a row into a call, for every provider the docs support, and refuses the
 * combinations that cannot work.
 *
 * The refusal matters as much as the call. A search-only provider (Brave: a key and a search path,
 * no model) can never serve a chat task, and an unknown task or provider is an error rather than a
 * silent fallback — a misconfiguration has to be visible, not mysterious.
 */


/** Documentation-backed defaults per provider, used when a row leaves a field empty. */
export const PROVIDER_DEFAULTS: Record<
  string,
  { label: string; baseUrl: string; model: string; kinds: ProviderKind }
> = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    kinds: "both",
  },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com", model: "gpt-5.4", kinds: "chat" },
  anthropic: {
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    kinds: "chat",
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-3.8-flash",
    kinds: "chat",
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    model: "openai/gpt-5",
    kinds: "both",
  },
  brave: {
    label: "Brave Search",
    baseUrl: "https://api.search.brave.com",
    // Brave has no model at all: it is a search API usable with any model.
    model: "",
    kinds: "search",
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    baseUrl: "",
    model: "",
    kinds: "chat",
  },
};

/** Everything the registry knows about a provider row. */
export interface AiProviderRow {
  id: string;
  name: string;
  provider: string;
  kinds: ProviderKind;
  baseUrl: string;
  model: string;
  searchPath: string | null;
  fetchPath: string | null;
  priority: number;
  isEnabled: boolean;
  lastTestOk: boolean | null;
  encryptedApiKey: string;
}

export function isAiTask(value: string): value is AiTask {
  return (AI_TASKS as readonly string[]).includes(value);
}


interface ProviderRecord {
  id: string;
  name: string;
  provider: string;
  kinds: string;
  base_url: string;
  model: string;
  search_path: string | null;
  fetch_path: string | null;
  priority: number | string;
  is_enabled: boolean;
  last_test_ok: boolean | null;
  encrypted_api_key: string;
}

function toRow(record: ProviderRecord): AiProviderRow {
  const kinds = (PROVIDER_KINDS as readonly string[]).includes(record.kinds)
    ? (record.kinds as ProviderKind)
    : "both";
  return {
    id: record.id,
    name: record.name,
    provider: record.provider,
    kinds,
    baseUrl: record.base_url,
    model: record.model,
    searchPath: record.search_path,
    fetchPath: record.fetch_path,
    priority: Number(record.priority),
    isEnabled: Boolean(record.is_enabled),
    lastTestOk: record.last_test_ok ?? null,
    encryptedApiKey: record.encrypted_api_key,
  };
}

export async function listAiProviders(runner?: DbClient): Promise<AiProviderRow[]> {
  const db = runner ?? await getDb();
  const result = await db.query<ProviderRecord>(
    `SELECT id, name, provider, kinds, base_url, model, search_path, fetch_path,
            priority, is_enabled, last_test_ok, encrypted_api_key
       FROM research_providers
      WHERE deleted_at IS NULL
      ORDER BY is_enabled DESC, priority ASC, created_at ASC`,
  );
  return result.rows.map(toRow);
}

export async function getAiProvider(id: string, runner?: DbClient): Promise<AiProviderRow | null> {
  const db = runner ?? await getDb();
  const result = await db.query<ProviderRecord>(
    `SELECT id, name, provider, kinds, base_url, model, search_path, fetch_path,
            priority, is_enabled, last_test_ok, encrypted_api_key
       FROM research_providers WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return result.rows[0] ? toRow(result.rows[0]) : null;
}

const UNKNOWN_PROVIDER = "That provider no longer exists. Choose another one in Settings.";

export interface AiTaskSelection {
  task: AiTask;
  /** The chat provider that will serve this task. */
  chat: AiProviderRow | null;
  /** Where research should search, or null for "the chosen model's own search". */
  search: AiProviderRow | null;
  /** The chat providers to try, in order: the chosen one first, then the fallback list. */
  fallbackChain: AiProviderRow[];
}

/**
 * Resolve a task to the providers it should use.
 *
 * Refuses an unknown task, a provider id that does not exist, and a provider that cannot do the
 * job it was chosen for — each with a message naming the problem. A task with nothing configured
 * resolves to `chat: null`, which the callers report as "not configured" rather than failing.
 */
export async function resolveAiTask(task: string, runner?: DbClient): Promise<AiTaskSelection> {
  if (!isAiTask(task)) {
    throw new AppError(
      `Unknown AI task "${task}". Valid tasks are: ${AI_TASKS.join(", ")}.`,
      400,
      "unknown_task",
    );
  }

  const db = runner ?? await getDb();
  const settings = await db.query<{
    provider_id: string | null;
    model: string | null;
    search_provider_id: string | null;
  }>(
    `SELECT provider_id, model, search_provider_id FROM ai_task_settings WHERE task = $1`,
    [task],
  );
  const row = settings.rows[0];

  const fallbacks = await db.query<{ provider_id: string }>(
    `SELECT provider_id FROM ai_task_fallbacks WHERE task = $1 ORDER BY priority ASC, provider_id`,
    [task],
  );

  let chat: AiProviderRow | null = null;
  if (row?.provider_id) {
    const provider = await getAiProvider(row.provider_id, db);
    if (!provider) throw new AppError(UNKNOWN_PROVIDER, 400, "unknown_provider");
    const capable = chatCapability(provider);
    if (!capable.ok) throw new AppError(capable.message, 400, "provider_not_chat_capable");

    chat = { ...provider, model: row.model?.trim() || provider.model };
  }

  let search: AiProviderRow | null = null;
  if (row?.search_provider_id) {
    const provider = await getAiProvider(row.search_provider_id, db);
    if (!provider) throw new AppError(UNKNOWN_PROVIDER, 400, "unknown_provider");
    const capable = searchCapability(provider);
    if (!capable.ok) throw new AppError(capable.message, 400, "provider_not_search_capable");
    search = provider;
  }

  // The assigned provider is tried first when it is enabled and can chat — including when its last
  // Test failed, because a Test is a snapshot and the provider may well answer now. Everything after
  // it comes from the shared order, where a test-passed provider always precedes a failing one that
  // shares its number. A disabled provider is never tried at all.
  const chain: AiProviderRow[] = [];
  if (chat && chat.isEnabled && chatCapability(chat).ok) chain.push(chat);
  // No implicit global assignment for an unassigned action, especially Lead research.
  if (chat) chain.push(...chatFallbacks(await listAiProviders(db), chat.id, fallbacks.rows.map(f => f.provider_id)));

  return { task, chat, search, fallbackChain: chain };
}

export interface ChatMessage {
  system: string;
  user: string;
  maxTokens?: number;
  /** Ask for strict JSON where the provider supports it. */
  json?: boolean;
  timeoutMs?: ChatInput["timeoutMs"];
  transientRetries?: ChatInput["transientRetries"];
  diagnosticTask?: ChatInput["diagnosticTask"];
}

export interface ChatOutcome<T> {
  data: T;
  provider: string;
  model: string;
}

export type ChatResult =
  | { ok: true; text: string; provider: string; model: string; providerName?: string; providerId?: string }
  | Extract<TransportResult, { ok: false }>;

/**
 * Ask one provider for a completion. Credentials come from the row's encrypted key and are never
 * logged; a provider that fails is reported by name so the fallback chain can explain itself.
 */
export async function chatWithProvider(
  row: AiProviderRow,
  message: ChatMessage,
): Promise<ChatResult> {
  const capable = chatCapability(row);
  if (!capable.ok) return { ok: false, code: "provider_not_chat_capable", reason: capable.message };

  let apiKey: string;
  try {
    apiKey = decryptSecret(row.encryptedApiKey);
  } catch {
    return {
      ok: false,
      code: "key_unreadable",
      reason: `The stored key for "${row.name}" could not be read. Enter it again in Settings.`,
    };
  }
  if (!apiKey.trim()) {
    return { ok: false, code: "missing_api_key", reason: `"${row.name}" has no API key stored.` };
  }

  const outcome = await requestProviderChat(row, apiKey, message);
  return outcome.ok
    ? { ...outcome, provider: row.provider, providerName: row.name, providerId: row.id }
    : { ...outcome, reason: `${row.name}: ${outcome.reason}` };
}

/**
 * Run a task against its chosen provider, falling through the fallback chain. Returns the first
 * success, or a failure naming every provider that was tried.
 */
export async function runChatTask(
  task: string,
  message: ChatMessage,
  runner?: DbClient,
): Promise<ChatResult & { fallbackUsed?: string }> {
  const selection = await resolveAiTask(task, runner);
  if (!selection.fallbackChain.length) {
    if (selection.chat) return {
      ok: false, code: "all_providers_failed",
      reason: "The assigned provider is disabled or has no passing Test, and no enabled, test-passed chat fallback is available. Check Settings.",
      failures: [],
    };
    return {
      ok: false,
      code: "provider_unavailable",
      reason: `No provider is configured for ${AI_TASK_LABELS[selection.task]}. Choose one in Settings.`,
    };
  }

  const reasons: string[] = [];
  const failures: ChatAttemptFailure[] = [];
  for (const provider of selection.fallbackChain) {
    const started = Date.now();
    const outcome = await chatWithProvider(provider, message);
    if (outcome.ok) {
      return {
        ...outcome,
        ...(provider.id !== selection.chat?.id ? { fallbackUsed: provider.name } : {}),
      };
    }
    reasons.push(`${provider.name}: ${outcome.reason}`);
    failures.push(...(outcome.failures ?? [{ code: outcome.code, provider: provider.provider, attempt: 1,
      status: outcome.status ?? null, elapsedMs: outcome.elapsedMs ?? Date.now() - started,
      ...(outcome.providerCode ? { providerCode: outcome.providerCode } : {}) }]));
  }

  return {
    ok: false,
    code: "all_providers_failed",
    reason: `Every configured provider failed — ${reasons.join("; ")}`,
    failures,
  };
}
