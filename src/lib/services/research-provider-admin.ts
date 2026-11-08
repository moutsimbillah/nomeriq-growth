import { encryptSecret } from "@/lib/auth/crypto";
import { cleanBaseUrl, testDeepSeekConnection, type DeepSeekConfig } from "@/lib/deepseek/provider";
import { decryptSecret } from "@/lib/auth/crypto";
import { PROVIDER_DEFAULTS, PROVIDER_KINDS } from "@/lib/ai/registry";
import { testProviderChat } from "@/lib/ai/provider-test";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/utils";
import { AI_TASK_LABELS, isAiTask, type AiTask } from "@/lib/ai/registry";
import { chatCapability, workingChatProvider } from "@/lib/ai/routing";

/**
 * Founder-facing administration of the ordered provider list.
 *
 * Creation and updates take a key in the clear, encrypt it the same way the single
 * provider_credentials row is encrypted, and never return it. Testing a provider records
 * the outcome on its own row, so the Settings screen shows the last real result rather
 * than a guess.
 */

/** Which AI actions point at a provider, as sentences Settings can show in a delete dialog. */
export interface ProviderUsage {
  providerId: string;
  /** One entry per action that would break. Empty means the provider is unused. */
  uses: string[];
}

function taskLabel(task: string): string {
  return isAiTask(task) ? AI_TASK_LABELS[task as AiTask] : task;
}

/**
 * Every place a provider is referenced: the action it serves, the search source it fills, and the
 * fallback lists it sits in. Used both by the delete dialog and by the delete itself, so the list a
 * founder is shown is the same list the deletion acts on.
 */
export async function providerUsage(providerId?: string): Promise<ProviderUsage[]> {
  const db = await getDb();
  const filter = providerId ? `WHERE provider_id = $1 OR search_provider_id = $1` : "";
  const params = providerId ? [providerId] : [];
  const assigned = await db.query<{ provider_id: string | null; search_provider_id: string | null; task: string }>(
    `SELECT provider_id, search_provider_id, task FROM ai_task_settings ${filter}`,
    params,
  );
  const fallbackFilter = providerId ? `WHERE provider_id = $1` : "";
  const fallbacks = await db.query<{ provider_id: string; task: string }>(
    `SELECT provider_id, task FROM ai_task_fallbacks ${fallbackFilter}`,
    params,
  );

  const byProvider = new Map<string, string[]>();
  const add = (id: string | null, use: string) => {
    if (!id) return;
    const list = byProvider.get(id) ?? [];
    if (!list.includes(use)) list.push(use);
    byProvider.set(id, list);
  };

  for (const row of assigned.rows) {
    add(row.provider_id, `${taskLabel(row.task)} (assigned)`);
    add(row.search_provider_id, `${taskLabel(row.task)} (search source)`);
  }
  for (const row of fallbacks.rows) add(row.provider_id, `${taskLabel(row.task)} (fallback)`);

  return [...byProvider.entries()]
    .map(([id, uses]) => ({ providerId: id, uses: uses.sort() }))
    .filter(entry => !providerId || entry.providerId === providerId);
}

/**
 * Retire a provider.
 *
 * A founder-only act, and deliberately not a hard delete: the stored key is destroyed and the row
 * leaves every list, but its name, type and deleter stay behind so older "produced by" labels still
 * resolve. If any action still points at it, the deletion is refused unless a working replacement is
 * named — an action is never left pointing at nothing.
 */
export async function deleteResearchProvider(
  id: string,
  input: { actorUserId?: string | null; switchToProviderId?: string | null } = {},
): Promise<{ name: string; reassignedTo: string | null; uses: string[] }> {
  const db = await getDb();

  return db.transaction(async (tx) => {
    const result = await tx.query<{ id: string; name: string; provider: string; kinds: string; model: string; deleted_at: string | null }>(
      `SELECT id, name, provider, kinds, model, deleted_at FROM research_providers WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new AppError("Provider not found.", 404, "provider_not_found");
    if (row.deleted_at) {
      throw new AppError(`"${row.name}" is already deleted.`, 409, "provider_already_deleted");
    }

    const uses = (await providerUsageIn(tx, id)).uses;
    let replacement: { id: string; name: string; model: string } | null = null;

    if (uses.length) {
      const switchTo = (input.switchToProviderId ?? "").trim();
      if (!switchTo) {
        throw new AppError(
          `"${row.name}" is still used by: ${uses.join(", ")}. Switch those actions to a working provider first, then delete it.`,
          409,
          "provider_in_use",
        );
      }
      const target = await tx.query<{
        id: string; name: string; provider: string; kinds: string; model: string; is_enabled: boolean; last_test_ok: boolean | null; deleted_at: string | null;
      }>(
        `SELECT id, name, provider, kinds, model, is_enabled, last_test_ok, deleted_at
           FROM research_providers WHERE id = $1`,
        [switchTo],
      );
      const candidate = target.rows[0];
      if (!candidate || candidate.deleted_at) {
        throw new AppError("The replacement provider no longer exists. Choose another one.", 400, "unknown_provider");
      }
      const capable = chatCapability(candidate);
      if (!capable.ok) throw new AppError(capable.message, 400, "provider_not_chat_capable");
      if (!workingChatProvider({
        id: candidate.id,
        name: candidate.name,
        provider: candidate.provider,
        kinds: candidate.kinds,
        model: candidate.model,
        priority: 0,
        isEnabled: candidate.is_enabled,
        lastTestOk: candidate.last_test_ok ?? null,
      })) {
        throw new AppError(
          "Choose an enabled provider with a passing full Test as the replacement.",
          400,
          "provider_not_working",
        );
      }
      replacement = { id: candidate.id, name: candidate.name, model: candidate.model };

      // The assignment keeps working, with the replacement's own model — never the deleted one's.
      await tx.query(
        `UPDATE ai_task_settings SET provider_id = $1, model = $2, updated_at = now() WHERE provider_id = $3`,
        [replacement.id, replacement.model, id],
      );
      await tx.query(
        `UPDATE ai_task_settings SET search_provider_id = $1, updated_at = now() WHERE search_provider_id = $2`,
        [replacement.id, id],
      );
      // A task that already lists the replacement would collide on the (task, provider_id) key.
      await tx.query(
        `DELETE FROM ai_task_fallbacks f USING ai_task_fallbacks g
          WHERE f.task = g.task AND f.provider_id = $1 AND g.provider_id = $2`,
        [replacement.id, id],
      );
      await tx.query(`UPDATE ai_task_fallbacks SET provider_id = $1 WHERE provider_id = $2`, [
        replacement.id,
        id,
      ]);
    }

    await tx.query(
      `UPDATE research_providers
          SET encrypted_api_key = '', is_enabled = false, deleted_at = now(), deleted_by = $2,
              search_path = NULL, fetch_path = NULL,
              last_test_ok = NULL, last_test_message = NULL, last_tested_at = NULL,
              updated_at = now()
        WHERE id = $1`,
      [id, input.actorUserId ?? null],
    );

    await tx.query(
      `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'founder', $2, 'ai_provider.deleted', 'research_provider', $3, $4::jsonb)`,
      [
        crypto.randomUUID(),
        input.actorUserId ?? null,
        id,
        JSON.stringify({
          name: row.name,
          provider: row.provider,
          kinds: row.kinds,
          reassignedTo: replacement?.name ?? null,
          aiActions: uses,
        }),
      ],
    );

    return { name: row.name, reassignedTo: replacement?.name ?? null, uses };
  });
}

/** `providerUsage` against a caller's transaction, so a delete reads and writes one view. */
async function providerUsageIn(tx: { query: <T>(text: string, params?: unknown[]) => Promise<{ rows: T[] }> }, providerId: string): Promise<ProviderUsage> {
  const assigned = await tx.query<{ provider_id: string | null; search_provider_id: string | null; task: string }>(
    `SELECT provider_id, search_provider_id, task FROM ai_task_settings
      WHERE provider_id = $1 OR search_provider_id = $1`,
    [providerId],
  );
  const fallbacks = await tx.query<{ task: string }>(
    `SELECT task FROM ai_task_fallbacks WHERE provider_id = $1`,
    [providerId],
  );
  const uses: string[] = [];
  const add = (use: string) => { if (!uses.includes(use)) uses.push(use); };
  for (const row of assigned.rows) {
    if (row.provider_id === providerId) add(`${taskLabel(row.task)} (assigned)`);
    if (row.search_provider_id === providerId) add(`${taskLabel(row.task)} (search source)`);
  }
  for (const row of fallbacks.rows) add(`${taskLabel(row.task)} (fallback)`);
  return { providerId, uses: uses.sort() };
}

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

  if (provider === "zai" && kinds !== "chat") {
    throw new AppError("Z.ai GLM supports chat only here. Research remains on the official DeepSeek adapter.", 400, "invalid_provider_kind");
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
  // A deleted provider keeps its name, so older "produced by" labels still resolve to it.
  const existing = await db.query<{ deleted_at: string | null }>(
    `SELECT deleted_at FROM research_providers WHERE lower(name) = lower($1)`,
    [name],
  );
  if (existing.rows.length) {
    throw new AppError(
      existing.rows[0]!.deleted_at
        ? "A deleted provider used that name, and older results still refer to it. Choose another name."
        : "A provider with that name already exists.",
      409,
      "provider_exists",
    );
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
      input.isEnabled ?? provider !== "zai",
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
    if (patch.kinds !== "chat") {
      const current = await db.query<{ provider: string }>("SELECT provider FROM research_providers WHERE id=$1", [id]);
      if (current.rows[0]?.provider === "zai") throw new AppError("Z.ai GLM supports chat only here.", 400, "invalid_provider_kind");
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

export async function testResearchProvider(id: string, options: { model?: string; researchTools?: boolean; searchOnly?: boolean } = {}): Promise<{
  ok: boolean;
  message: string;
  models: string[];
}> {
  const db = await getDb();
  const result = await db.query<ProviderRow>(`SELECT * FROM research_providers WHERE id = $1 AND deleted_at IS NULL`, [id]);
  const row = result.rows[0];
  if (!row) throw new AppError("Provider not found.", 404, "provider_not_found");

  let outcome: { ok: boolean; message: string; models: string[] };
  let discovered: { searchPath: string | null; fetchPath: string | null } = {
    searchPath: null,
    fetchPath: null,
  };

  try {
    const config = configFor({ ...row, model: options.model ?? row.model });
    if (row.kinds !== "search" && !options.searchOnly) {
      const chat = await testProviderChat({ provider: row.provider, baseUrl: config.baseUrl, model: config.model }, config.apiKey);
      outcome = chat;
      // Native search adapters for other vendors are part of the research-engine phase.
      // A model-only row is tested for chat, not rejected for lacking proprietary DeepSeek tools.
      if (chat.ok && options.researchTools !== false && row.kinds === "both" &&
        (row.provider === "deepseek" || row.provider === "custom")) {
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

  // A task override/partial-role test cannot certify the row's default/full Test.
  if ((!options.model || options.model === row.model) && options.researchTools !== false && !options.searchOnly) await db.query(
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