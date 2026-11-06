import { decryptSecret } from "@/lib/auth/crypto";
import { cleanBaseUrl, type DeepSeekConfig } from "@/lib/deepseek/provider";
import {
  DeepSeekResearchProvider,
  resolveResearchProvider,
  type ResearchProvider,
} from "@/lib/deepseek/research-provider";
import { getDb } from "@/lib/db/client";

/**
 * Several DeepSeek-compatible providers, tried in priority order.
 *
 * The single `provider_credentials` row is still the fallback: when the ordered table is
 * empty the engine behaves exactly as before, which is what keeps existing installs and the
 * test suite working without a migration step.
 */

export interface StoredResearchProvider {
  id: string;
  name: string;
  provider: string;
  /** What the row can do: `chat`, `search` (Brave) or `both`. Migration 025. */
  kinds: string;
  baseUrl: string;
  model: string;
  priority: number;
  isEnabled: boolean;
  hasKey: boolean;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  lastTestedAt: string | null;
}

interface ProviderRow {
  id: string;
  name: string;
  provider: string;
  kinds: string;
  base_url: string;
  model: string;
  encrypted_api_key: string;
  search_path: string | null;
  fetch_path: string | null;
  priority: number;
  is_enabled: boolean;
  has_key: boolean;
  last_test_ok: boolean | null;
  last_test_message: string | null;
  last_tested_at: string | null;
}

export async function listResearchProviders(): Promise<StoredResearchProvider[]> {
  const db = await getDb();
  const result = await db.query<ProviderRow>(
    `SELECT id, name, provider, kinds, base_url, model, priority, is_enabled,
            (encrypted_api_key IS NOT NULL AND encrypted_api_key <> '') AS has_key,
            last_test_ok, last_test_message, last_tested_at
       FROM research_providers
      ORDER BY is_enabled DESC, priority ASC, created_at ASC`,
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    provider: row.provider,
    kinds: row.kinds,
    baseUrl: row.base_url,
    model: row.model,
    priority: Number(row.priority),
    isEnabled: Boolean(row.is_enabled),
    hasKey: Boolean(row.has_key),
    lastTestOk: row.last_test_ok ?? null,
    lastTestMessage: row.last_test_message ?? null,
    lastTestedAt: row.last_tested_at
      ? new Date(row.last_tested_at).toISOString()
      : null,
  }));
}

interface PoolEntry {
  name: string;
  provider: ResearchProvider;
}

/**
 * Tries each configured provider in order and only fails when every one of them failed,
 * reporting the last error. `lastUsedProvider` records who actually served the call so
 * usage is attributed honestly rather than to whichever provider was first.
 */
export class FailoverResearchProvider implements ResearchProvider {
  lastUsedProvider: string | null = null;

  constructor(private readonly entries: PoolEntry[]) {}

  get model(): string {
    return this.entries[0]?.provider.model ?? "unconfigured";
  }

  /** Every provider in priority order, for reporting. */
  get names(): string[] {
    return this.entries.map((entry) => entry.name);
  }

  private async attempt<T>(run: (provider: ResearchProvider) => Promise<T>): Promise<T> {
    let lastError: unknown = null;

    for (const entry of this.entries) {
      try {
        const value = await run(entry.provider);
        this.lastUsedProvider = entry.name;
        return value;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("No research provider is configured.");
  }

  search(input: { query: string; count: number }) {
    return this.attempt((provider) => provider.search(input));
  }

  fetch(input: { url: string }) {
    return this.attempt((provider) => provider.fetch(input));
  }

  chatJson<T>(input: { system: string; user: string; maxTokens?: number }) {
    return this.attempt((provider) => provider.chatJson<T>(input));
  }
}

function configFor(row: ProviderRow): DeepSeekConfig {
  return {
    apiKey: decryptSecret(row.encrypted_api_key),
    baseUrl: cleanBaseUrl(row.base_url || "https://api.deepseek.com"),
    model: row.model || "deepseek-flash",
    source: "database",
    searchPath: row.search_path ?? null,
    fetchPath: row.fetch_path ?? null,
  };
}

export async function resolveResearchProviders(input: {
  searchQps: number;
  fetchQps: number;
}): Promise<{
  provider: ResearchProvider | null;
  error: string | null;
  names: string[];
}> {
  const db = await getDb();
  const result = await db.query<ProviderRow>(
    `SELECT * FROM research_providers
      WHERE is_enabled = true
      ORDER BY priority ASC, created_at ASC`,
  );

  if (!result.rows.length) {
    // Nothing ordered yet: behave exactly as the single-provider build did.
    const legacy = await resolveResearchProvider({
      searchQps: input.searchQps,
      fetchQps: input.fetchQps,
    });
    return {
      provider: legacy.provider,
      error: legacy.error,
      names: legacy.provider ? ["DeepSeek"] : [],
    };
  }

  const entries: PoolEntry[] = [];
  const failures: string[] = [];

  for (const row of result.rows) {
    try {
      const config = configFor(row);
      entries.push({
        name: row.name,
        provider: new DeepSeekResearchProvider(config, {
          search: input.searchQps,
          fetch: input.fetchQps,
        }),
      });
    } catch (error) {
      failures.push(
        `${row.name}: ${
          error instanceof Error ? error.message : "stored key could not be decrypted"
        }`,
      );
    }
  }

  if (!entries.length) {
    return {
      provider: null,
      error:
        failures.length > 0
          ? `No usable research provider: ${failures.join("; ")}`
          : "No usable research provider is configured.",
      names: [],
    };
  }

  const pool = new FailoverResearchProvider(entries);
  return {
    provider: pool,
    error: failures.length ? `Skipped ${failures.join("; ")}` : null,
    names: pool.names,
  };
}