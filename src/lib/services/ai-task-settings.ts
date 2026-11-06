import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/utils";
import { workingChatProvider } from "@/lib/ai/routing";
import {
  AI_TASKS,
  AI_TASK_LABELS,
  chatCapability,
  getAiProvider,
  isAiTask,
  searchCapability,
  type AiTask,
} from "@/lib/ai/registry";

/**
 * Per-task provider choices: which provider and model serve a task, where research searches, and
 * the fallback order.
 *
 * The rules live in `@/lib/ai/registry` and are called here rather than restated, so the API and
 * the Settings screen cannot drift apart: a search-only provider can never be saved for a chat
 * task, a model-only provider can never be saved as the search source, and an unknown task or
 * provider is refused by name.
 */

export interface TaskSetting {
  task: AiTask;
  label: string;
  providerId: string | null;
  providerName: string | null;
  model: string | null;
  searchProviderId: string | null;
  searchProviderName: string | null;
  fallbacks: { providerId: string; providerName: string; priority: number }[];
  updatedAt: string | null;
}

async function taskRows(): Promise<
  Map<
    string,
    {
      provider_id: string | null;
      model: string | null;
      search_provider_id: string | null;
      updated_at: string | null;
    }
  >
> {
  const db = await getDb();
  const result = await db.query<{
    task: string;
    provider_id: string | null;
    model: string | null;
    search_provider_id: string | null;
    updated_at: string | null;
  }>(
    `SELECT task, provider_id, model, search_provider_id, updated_at
       FROM ai_task_settings`,
  );
  return new Map(result.rows.map((row) => [row.task, row]));
}

export async function listTaskSettings(): Promise<TaskSetting[]> {
  const db = await getDb();
  const settings = await taskRows();
  const fallbacks = await db.query<{ task: string; provider_id: string; name: string; priority: number }>(
    `SELECT f.task, f.provider_id, p.name, f.priority
       FROM ai_task_fallbacks f
       JOIN research_providers p ON p.id = f.provider_id
      ORDER BY f.priority ASC, p.name`,
  );

  const named = new Map(
    (
      await db.query<{ id: string; name: string }>(`SELECT id, name FROM research_providers`)
    ).rows.map((row) => [row.id, row.name]),
  );

  return AI_TASKS.map((task) => {
    const row = settings.get(task);
    return {
      task,
      label: AI_TASK_LABELS[task],
      providerId: row?.provider_id ?? null,
      providerName: row?.provider_id ? named.get(row.provider_id) ?? "(deleted)" : null,
      model: row?.model ?? null,
      searchProviderId: row?.search_provider_id ?? null,
      searchProviderName: row?.search_provider_id
        ? named.get(row.search_provider_id) ?? "(deleted)"
        : null,
      fallbacks: fallbacks.rows
        .filter((entry) => entry.task === task)
        .map((entry) => ({
          providerId: entry.provider_id,
          providerName: entry.name,
          priority: Number(entry.priority),
        })),
      updatedAt: row?.updated_at ?? null,
    };
  });
}

export interface TaskUpdate {
  providerId?: string | null;
  model?: string | null;
  searchProviderId?: string | null;
  /** The full ordered fallback list, replacing whatever was stored for this task. */
  fallbackProviderIds?: string[];
}

export async function saveTaskSetting(
  task: string,
  patch: TaskUpdate,
  updatedBy?: string | null,
): Promise<TaskSetting[]> {
  if (!isAiTask(task)) {
    throw new AppError(
      `Unknown AI task "${task}". Valid tasks are: ${AI_TASKS.join(", ")}.`,
      400,
      "unknown_task",
    );
  }

  // Resolve and check the chat provider before writing anything.
  if (patch.providerId) {
    const provider = await getAiProvider(patch.providerId);
    if (!provider) {
      throw new AppError(
        "That provider no longer exists. Choose another one in Settings.",
        400,
        "unknown_provider",
      );
    }
    const capable = chatCapability(provider);
    if (!capable.ok) {
      throw new AppError(capable.message, 400, "provider_not_chat_capable");
    }
    if (!provider.isEnabled) {
      throw new AppError(
        `"${provider.name}" is disabled. Enable it before choosing it for a task.`,
        400,
        "provider_disabled",
      );
    }
  }

  if (patch.searchProviderId) {
    const provider = await getAiProvider(patch.searchProviderId);
    if (!provider) {
      throw new AppError(
        "That search provider no longer exists. Choose another one in Settings.",
        400,
        "unknown_provider",
      );
    }
    const capable = searchCapability(provider);
    if (!capable.ok) {
      throw new AppError(capable.message, 400, "provider_not_search_capable");
    }
  }

  const fallbackIds = patch.fallbackProviderIds ?? [];
  for (const id of fallbackIds) {
    const provider = await getAiProvider(id);
    if (!provider) {
      throw new AppError(
        "One of the fallback providers no longer exists. Choose them again.",
        400,
        "unknown_provider",
      );
    }
    const capable = chatCapability(provider);
    if (!capable.ok) {
      // A search-only provider in a fallback list is a real configuration mistake.
      throw new AppError(capable.message, 400, "provider_not_chat_capable");
    }
  }

  const db = await getDb();
  await db.query(
    `INSERT INTO ai_task_settings (task, provider_id, model, search_provider_id, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (task) DO UPDATE
       SET provider_id = EXCLUDED.provider_id,
           model = EXCLUDED.model,
           search_provider_id = EXCLUDED.search_provider_id,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
    [
      task,
      patch.providerId ?? null,
      patch.model ?? null,
      patch.searchProviderId ?? null,
      updatedBy ?? null,
    ],
  );

  if (patch.fallbackProviderIds) {
    await db.query(`DELETE FROM ai_task_fallbacks WHERE task = $1`, [task]);
    let priority = 100;
    for (const id of patch.fallbackProviderIds) {
      await db.query(
        `INSERT INTO ai_task_fallbacks (task, provider_id, priority) VALUES ($1, $2, $3)
         ON CONFLICT (task, provider_id) DO UPDATE SET priority = EXCLUDED.priority`,
        [task, id, priority],
      );
      priority += 10;
    }
  }

  return listTaskSettings();
}

/** Deliberate founder click, atomic across six actions. Lead research is not activated here. */
export async function useProviderForAllActions(providerId: string, updatedBy?: string | null): Promise<TaskSetting[]> {
  const db = await getDb();
  await db.transaction(async tx => {
    await tx.query("SELECT id FROM research_providers WHERE id = $1 FOR SHARE", [providerId]);
    const provider = await getAiProvider(providerId, tx);
    if (!provider) throw new AppError("That provider no longer exists.", 400, "unknown_provider");
    const capable = chatCapability(provider);
    if (!capable.ok) throw new AppError(capable.message, 400, "provider_not_chat_capable");
    if (!workingChatProvider(provider)) {
      throw new AppError("Choose an enabled chat provider with a passing full Test first.", 400, "provider_not_working");
    }
    for (const task of AI_TASKS.filter(task => task !== "lead_research")) {
      await tx.query(
        `INSERT INTO ai_task_settings (task, provider_id, model, search_provider_id, updated_by, updated_at)
         VALUES ($1, $2, $3, NULL, $4, now())
         ON CONFLICT (task) DO UPDATE SET provider_id = EXCLUDED.provider_id,
           model = EXCLUDED.model, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [task, provider.id, provider.model, updatedBy ?? null],
      );
    }
  });
  return listTaskSettings();
}
