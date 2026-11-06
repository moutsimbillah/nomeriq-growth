import { encryptSecret } from "@/lib/auth/crypto";
import { cleanBaseUrl, testDeepSeekConnection, type DeepSeekConfig } from "@/lib/deepseek/provider";
import { decryptSecret } from "@/lib/auth/crypto";
import { PROVIDER_DEFAULTS, PROVIDER_KINDS } from "@/lib/ai/registry";
import { testProviderChat } from "@/lib/ai/provider-test";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/utils";

/**
 * Founder-facing administration of the ordered provider list.
 *
 * Creation and updates take a key in the clear, encrypt it the same way the single
 * provider_credentials row is encrypted, and never return it. Testing a provider records
 * the outcome on its own row, so the Settings screen shows the last real result rather
 * than a guess.
 */

export interface ProviderInput {
  name?: string;
  provider?: string;
  kinds?: string;
  apiKey?: string | null;
  baseUrl?: string;
  model?: string;
  searchPath?: string | null;
  fetchPath?: string | null;
  priority?: number;
  isEnabled?: boolean;
}

interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  model: string;
  provider: string;
  kinds: string;
  encrypted_api_key: string;
  search_path: string | null;
  fetch_path: string | null;
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

export async function createResearchProvider(
  input: ProviderInput & { createdBy?: string | null },
): Promise<string> {
  const name = (input.name ?? "").trim();
  const apiKey = (input.apiKey ?? "").trim();
  const provider = (input.provider ?? "deepseek").trim().toLowerCase();

  if (!name) throw new AppError("A provider needs a name.", 400, "invalid_provider");
  if (!apiKey) throw new AppError("A provider needs an API key.", 400, "invalid_provider");

  // An unrecognised provider is refused by name rather than stored and discovered later.
  const defaults = PROVIDER_DEFAULTS[provider];
  if (!defaults) {
    throw new AppError(
      `Unknown provider "${provider}". Choose one of: ${Object.keys(PROVIDER_DEFAULTS).join(", ")}.`,
      400,
      "unknown_provider",
    );
  }

  const kinds = (input.kinds ?? defaults.kinds).trim().toLowerCase();
  if (!(PROVIDER_KINDS as readonly string[]).includes(kinds)) {
    throw new AppError(
      `Unknown provider kind "${kinds}". Choose one of: ${PROVIDER_KINDS.join(", ")}.`,
      400,
      "invalid_provider_kind",
    );
  }

  // A search-only row has no model by design (Brave is the case); a chat-capable row must name one.
  const model = kinds === "search" ? "" : (input.model ?? "").trim() || defaults.model;
  if (kinds !== "search" && !model) {
    throw new AppError(
      `"${name}" is a chat provider, so it needs a model. Set one, or record it as search-only.`,
      400,
      "invalid_provider",
    );
  }
  const baseUrl =
    (input.baseUrl ?? "").trim() || defaults.baseUrl;
  if (!baseUrl) {
    throw new AppError(
      `A custom provider needs a base URL. Set one for "${name}".`,
      400,
      "invalid_provider",
    );
  }

  const db = await getDb();
  const existing = await db.query(`SELECT 1 FROM research_providers WHERE lower(name) = lower($1)`, [name]);
  if (existing.rows.length) {
    throw new AppError("A provider with that name already exists.", 409, "provider_exists");
  }

  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO research_providers
       (id, name, provider, kinds, base_url, model, encrypted_api_key, search_path, fetch_path,
        priority, is_enabled, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      name,
      provider,
      kinds,
      cleanBaseUrl(baseUrl),
      model,
      encryptSecret(apiKey),
      input.searchPath ?? null,
      input.fetchPath ?? null,
      Number.isFinite(input.priority) ? Number(input.priority) : 100,
      input.isEnabled ?? true,
      input.createdBy ?? null,
    ],
  );

  return id;
}

export async function updateResearchProvider(id: string, patch: ProviderInput): Promise<void> {
  const db = await getDb();
  const assignments: string[] = [];
  const params: unknown[] = [];

  const set = (column: string, value: unknown) => {
    params.push(value);
    assignments.push(`${column} = $${params.length}`);
  };

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new AppError("A provider needs a name.", 400, "invalid_provider");
    set("name", name);
  }
  if (patch.baseUrl !== undefined) set("base_url", cleanBaseUrl(patch.baseUrl));
  if (patch.kinds !== undefined) {
    if (!(PROVIDER_KINDS as readonly string[]).includes(patch.kinds)) {
      throw new AppError(
        `Unknown provider kind "${patch.kinds}". Choose one of: ${PROVIDER_KINDS.join(", ")}.`,
        400,
        "invalid_provider_kind",
      );
    }
    // Flipping a row to search-only clears the model, because a search-only row has none; flipping
    // it back to chat requires a model and is refused here rather than left half-configured.
    set("kinds", patch.kinds);
    if (patch.kinds === "search") set("model", "");
  }
  if (patch.model !== undefined) set("model", patch.model);
  if (patch.searchPath !== undefined) set("search_path", patch.searchPath);
  if (patch.fetchPath !== undefined) set("fetch_path", patch.fetchPath);
  if (patch.priority !== undefined) set("priority", Number(patch.priority));
  if (patch.isEnabled !== undefined) set("is_enabled", Boolean(patch.isEnabled));

  // An empty key means "keep the stored one" — the UI never round-trips the secret.
  const apiKey = (patch.apiKey ?? "").trim();
  if (apiKey) set("encrypted_api_key", encryptSecret(apiKey));
  if (apiKey || patch.model !== undefined || patch.baseUrl !== undefined || patch.kinds !== undefined) {
    set("last_test_ok", null);
    set("last_test_message", null);
    set("last_tested_at", null);
  }

  if (!assignments.length) return;

  params.push(id);
  const result = await db.query(
    `UPDATE research_providers
        SET ${assignments.join(", ")}, updated_at = now()
      WHERE id = $${params.length}`,
    params,
  );

  if (result.rowCount === 0) throw new AppError("Provider not found.", 404, "provider_not_found");
}

export async function testResearchProvider(id: string): Promise<{
  ok: boolean;
  message: string;
  models: string[];
}> {
  const db = await getDb();
  const result = await db.query<ProviderRow>(`SELECT * FROM research_providers WHERE id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw new AppError("Provider not found.", 404, "provider_not_found");

  let outcome: { ok: boolean; message: string; models: string[] };
  let discovered: { searchPath: string | null; fetchPath: string | null } = {
    searchPath: null,
    fetchPath: null,
  };

  try {
    const config = configFor(row);
    if (row.kinds !== "search") {
      const chat = await testProviderChat({ provider: row.provider, baseUrl: config.baseUrl, model: row.model }, config.apiKey);
      outcome = chat;
      // Native search adapters for other vendors are part of the research-engine phase.
      // A model-only row is tested for chat, not rejected for lacking proprietary DeepSeek tools.
      if (chat.ok && (row.provider === "deepseek" || (row.provider === "custom" && row.kinds === "both"))) {
        const research = await testDeepSeekConnection(config);
        outcome = { ok: research.ok && research.fetchOk, message: `${chat.message} ${research.message}`, models: chat.models };
        discovered = { searchPath: research.searchPath, fetchPath: research.fetchPath };
      }
    } else {
      const test = await testDeepSeekConnection(config);
      outcome = { ok: test.ok && test.fetchOk, message: test.message, models: test.models };
      discovered = { searchPath: test.searchPath, fetchPath: test.fetchPath };
    }
  } catch {
    outcome = {
      ok: false,
      message: "The provider test failed. Check the provider URL, selected model and credential.",
      models: [],
    };
  }

  await db.query(
    `UPDATE research_providers
        SET last_test_ok = $1, last_test_message = $2, last_tested_at = now(),
            search_path = COALESCE(search_path, $3),
            fetch_path = COALESCE(fetch_path, $4),
            updated_at = now()
      WHERE id = $5`,
    [outcome.ok, outcome.message.slice(0, 1000), discovered.searchPath, discovered.fetchPath, id],
  );

  return outcome;
}