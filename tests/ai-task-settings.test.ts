import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/lib/db/client";
import {
  AI_TASKS,
  chatCapability,
  resolveAiTask,
  runChatTask,
  searchCapability,
  type AiProviderRow,
} from "@/lib/ai/registry";
import { createResearchProvider } from "@/lib/services/research-provider-admin";
import { listTaskSettings, saveTaskSetting } from "@/lib/services/ai-task-settings";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * The two rules the founder asked to be pinned down in code:
 *
 * 1. A search-only provider (kinds = 'search', or a row with no model) can never be chosen for a
 *    chat task — not through the API, and not through Settings.
 * 2. An unknown task or an unknown provider is refused with a message that names it.
 *
 * These are asserted through the real functions the API and the Settings screen call, so the guard
 * cannot be bypassed by a caller that skips the HTTP layer.
 */

let searchProviderId: string;
let chatProviderId: string;

beforeAll(async () => {
  await ensureWorkspaceDefaults();
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM ai_task_fallbacks`);
  await db.query(`DELETE FROM ai_task_settings`);
  await db.query(`DELETE FROM research_providers`);

  // Brave: a key and a search path, no model — the search-only case.
  searchProviderId = await createResearchProvider({
    name: "Brave Search",
    provider: "brave",
    kinds: "search",
    apiKey: "brave-test-key",
  });

  chatProviderId = await createResearchProvider({
    name: "Primary chat",
    provider: "openai",
    apiKey: "chat-test-key",
  });
});

describe("search-only providers can never serve a chat task", () => {
  it("refuses a search-only provider in Settings, naming the problem", async () => {
    await expect(
      saveTaskSetting("translation", { providerId: searchProviderId, model: null }),
    ).rejects.toMatchObject({ code: "provider_not_chat_capable" });
  });

  it("refuses a row that has no model even when its kind says chat", async () => {
    const db = await getDb();
    const id = crypto.randomUUID();
    // A row that claims to chat but names no model: the API must not trust `kinds` alone.
    await db.query(
      `INSERT INTO research_providers
         (id, name, provider, kinds, base_url, model, encrypted_api_key, priority, is_enabled)
       VALUES ($1, 'No model', 'custom', 'chat', 'https://example.com', '', 'x', 100, true)`,
      [id],
    );
    const row = {
      id,
      name: "No model",
      kinds: "chat",
      model: "",
    } as unknown as AiProviderRow;
    expect(chatCapability(row).ok).toBe(false);
    await expect(
      saveTaskSetting("first_email", { providerId: id, model: null }),
    ).rejects.toMatchObject({ code: "provider_not_chat_capable" });
  });

  it("refuses it as a fallback too, not just as the first choice", async () => {
    await expect(
      saveTaskSetting("suggest_reply", {
        providerId: chatProviderId,
        fallbackProviderIds: [searchProviderId],
      }),
    ).rejects.toMatchObject({ code: "provider_not_chat_capable" });
  });

  it("still refuses at call time, so a row edited afterwards cannot slip through", async () => {
    // Configured while it was a chat provider...
    await saveTaskSetting("translation", { providerId: chatProviderId, model: null });
    // ...then flipped to search-only behind the settings screen's back.
    const db = await getDb();
    await db.query(`UPDATE research_providers SET kinds = 'search', model = '' WHERE id = $1`, [
      chatProviderId,
    ]);

    await expect(resolveAiTask("translation")).rejects.toMatchObject({
      code: "provider_not_chat_capable",
    });
  });

  it("accepts the same search-only provider as the search source", async () => {
    const tasks = await saveTaskSetting("lead_research", {
      providerId: chatProviderId,
      searchProviderId: searchProviderId,
    });
    const leadResearch = tasks.find((task) => task.task === "lead_research");
    expect(leadResearch?.searchProviderId).toBe(searchProviderId);
    expect(leadResearch?.providerId).toBe(chatProviderId);
  });

  it("refuses a model-only provider as the search source", async () => {
    await expect(
      saveTaskSetting("lead_research", {
        providerId: chatProviderId,
        searchProviderId: chatProviderId,
      }),
    ).rejects.toMatchObject({ code: "provider_not_search_capable" });
  });

  it("reports the mirror rule through the same helper the UI reads", () => {
    expect(searchCapability({ kinds: "chat", name: "Primary chat" }).ok).toBe(false);
    expect(searchCapability({ kinds: "both", name: "DeepSeek" }).ok).toBe(true);
    expect(searchCapability({ kinds: "search", name: "Brave Search" }).ok).toBe(true);
  });
});

describe("an unknown task or provider is refused with a clear message", () => {
  it("names the unknown task and lists the valid ones", async () => {
    await expect(saveTaskSetting("write_poetry", { providerId: chatProviderId })).rejects.toThrow(
      /Unknown AI task "write_poetry"/,
    );
    await expect(resolveAiTask("write_poetry")).rejects.toMatchObject({ code: "unknown_task" });

    // The message is a real list, not a placeholder — it carries every valid task.
    await expect(resolveAiTask("write_poetry")).rejects.toThrow(
      new RegExp(AI_TASKS.join(", ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });

  it("refuses a provider id that does not exist", async () => {
    const missing = crypto.randomUUID();
    await expect(
      saveTaskSetting("translation", { providerId: missing, model: null }),
    ).rejects.toMatchObject({ code: "unknown_provider" });
  });

  it("survives a provider being deleted: the task falls back to unconfigured, not broken", async () => {
    // The foreign key is ON DELETE SET NULL, so a task can never point at a row that is gone.
    await saveTaskSetting("translation", { providerId: chatProviderId, model: null });
    const db = await getDb();
    await db.query(`DELETE FROM research_providers WHERE id = $1`, [chatProviderId]);

    const selection = await resolveAiTask("translation");
    expect(selection.chat).toBeNull();

    const outcome = await runChatTask("translation", { system: "s", user: "u" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("provider_unavailable");
  });

  it("reports 'not configured' rather than failing when a valid task has nothing set", async () => {
    const outcome = await runChatTask("translation", { system: "s", user: "u" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("provider_unavailable");
      expect(outcome.reason).toMatch(/No provider is configured for Translation/);
    }
  });

  it("lists every task with its label, so Settings can render an unconfigured install", async () => {
    const tasks = await listTaskSettings();
    expect(tasks.map((task) => task.task)).toEqual([...AI_TASKS]);
    for (const task of tasks) {
      expect(task.providerId).toBeNull();
      expect(task.label.length).toBeGreaterThan(0);
    }
  });
});
