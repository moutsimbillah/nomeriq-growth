import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";

import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { createResearchProvider, deleteResearchProvider, providerUsage } from "@/lib/services/research-provider-admin";
import { listAiProviders, resolveAiTask, runChatTask } from "@/lib/ai/registry";

/** Leave no AI assignment behind: later test files expect an unconfigured registry. */
async function clearAiSettings() {
  const db = await getDb();
  await db.query(`DELETE FROM ai_task_fallbacks`);
  await db.query(`DELETE FROM ai_task_settings`);
  await db.query(`DELETE FROM research_providers`);
}
import { listTaskSettings, saveTaskSetting, useProviderForAllActions } from "@/lib/services/ai-task-settings";

/**
 * Deleting a provider is a tombstone, not an erasure, and it may never leave an action pointing at
 * nothing. These assertions run through the same service the DELETE route calls.
 */

let liveId = "";
let doomedId = "";
let searchId = "";

async function markWorking(id: string) {
  const db = await getDb();
  await db.query(`UPDATE research_providers SET is_enabled = true, last_test_ok = true WHERE id = $1`, [id]);
}

/** What Settings would list in the delete dialog for this provider. */
async function usesOf(id: string): Promise<string[]> {
  return (await providerUsage(id))[0]?.uses ?? [];
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  const db = await getDb();
  await db.query(`DELETE FROM ai_task_fallbacks`);
  await db.query(`DELETE FROM ai_task_settings`);
  await db.query(`DELETE FROM research_providers`);

  liveId = await createResearchProvider({ name: "Working chat", provider: "openai", apiKey: "sk-live-fixture" });
  doomedId = await createResearchProvider({ name: "Doomed gateway", provider: "custom", model: "fixture-model", apiKey: "sk-doomed-fixture", baseUrl: "https://doomed.example.test" });
  searchId = await createResearchProvider({ name: "Brave", provider: "brave", kinds: "search", apiKey: "brave-fixture" });
  await markWorking(liveId);
  await markWorking(doomedId);
});

afterAll(async () => {
  await clearAiSettings();
  await closeDb();
});

describe("the delete dialog and the delete itself agree", () => {
  it("reports every action, search source and fallback list that points at a provider", async () => {
    await saveTaskSetting("translation", { providerId: doomedId, model: "fixture-model" });
    await saveTaskSetting("lead_research", {
      providerId: doomedId,
      model: "fixture-model",
      searchProviderId: searchId,
      fallbackProviderIds: [liveId],
    });

    expect(await usesOf(doomedId)).toEqual([
      "Lead research (assigned)",
      "Translation (assigned)",
    ]);

    // The fallback list is a reference too, and it is reported against the fallback provider.
    expect(await usesOf(liveId)).toEqual(["Lead research (fallback)"]);
  });
});

describe("a delete refuses to leave an action pointing at nothing", () => {
  it("is refused, naming the actions, when something still points at it", async () => {
    await expect(deleteResearchProvider(doomedId, {})).rejects.toMatchObject({
      code: "provider_in_use",
      status: 409,
    });
    await expect(deleteResearchProvider(doomedId, {})).rejects.toThrow(/Lead research \(assigned\)/);

    // Nothing was changed by the refusal.
    const db = await getDb();
    const row = await db.query<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM research_providers WHERE id = $1`,
      [doomedId],
    );
    expect(row.rows[0]!.deleted_at).toBeNull();
  });

  it("refuses a replacement that cannot answer the action", async () => {
    // Switching to a search-only provider would leave Translation broken in a new way.
    await expect(
      deleteResearchProvider(doomedId, { switchToProviderId: searchId }),
    ).rejects.toMatchObject({ code: "provider_not_chat_capable" });

    // A chat provider that has never passed a Test is not a safe landing place either.
    const untestedId = await createResearchProvider({ name: "Untested", provider: "custom", model: "fixture-model", apiKey: "sk-untested", baseUrl: "https://untested.example.test" });
    await expect(
      deleteResearchProvider(doomedId, { switchToProviderId: untestedId }),
    ).rejects.toMatchObject({ code: "provider_not_working" });
  });

  it("reads a provider with no references as safe to delete", async () => {
    const unusedId = await createResearchProvider({ name: "Never used", provider: "custom", model: "fixture-model", apiKey: "sk-unused", baseUrl: "https://unused.example.test" });
    expect(await usesOf(unusedId)).toEqual([]);
  });
});

describe("deleting with a replacement keeps every action working", () => {
  it("moves assignments, search source and fallbacks, wipes the key and keeps a tombstone", async () => {
    expect((await usesOf(doomedId)).length).toBeGreaterThan(0);

    const outcome = await deleteResearchProvider(doomedId, { switchToProviderId: liveId, actorUserId: null });
    expect(outcome.name).toBe("Doomed gateway");
    expect(outcome.reassignedTo).toBe("Working chat");

    const db = await getDb();
    const row = await db.query<{ encrypted_api_key: string; is_enabled: boolean; deleted_at: string | null; name: string; provider: string; model: string }>(
      `SELECT encrypted_api_key, is_enabled, deleted_at, name, provider, model FROM research_providers WHERE id = $1`,
      [doomedId],
    );
    const tombstone = row.rows[0]!;
    // The key is destroyed, and the row is retired...
    expect(tombstone.encrypted_api_key).toBe("");
    expect(tombstone.is_enabled).toBe(false);
    expect(tombstone.deleted_at).not.toBeNull();
    // ...but its identity stays readable, so older "produced by" labels still resolve.
    expect(tombstone.name).toBe("Doomed gateway");
    expect(tombstone.provider).toBe("custom");

    // No action points at the deleted row any more, and none points at nothing.
    expect(await usesOf(doomedId)).toEqual([]);
    expect(await usesOf(liveId)).toEqual([
      "Lead research (assigned)",
      "Lead research (fallback)",
      "Translation (assigned)",
    ]);

    const tasks = await listTaskSettings();
    for (const task of tasks) {
      expect(task.providerId).not.toBe(doomedId);
    }
    expect(tasks.find(task => task.task === "translation")?.providerId).toBe(liveId);
    // The replacement's own model is used, never the deleted provider's.
    expect(tasks.find(task => task.task === "translation")?.model).toBe("gpt-5.4");

    // The references were cleared before the row was retired, so a fallback row never outlives it.
    const fallbacks = await db.query<{ provider_id: string }>(`SELECT provider_id FROM ai_task_fallbacks`);
    expect(fallbacks.rows.every(entry => entry.provider_id !== doomedId)).toBe(true);

    const audit = await db.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_log WHERE action = 'ai_provider.deleted' AND entity_id = $1`,
      [doomedId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata.name).toBe("Doomed gateway");
    expect(audit.rows[0]!.metadata.reassignedTo).toBe("Working chat");
  });

  it("drops a deleted provider out of every list, so it cannot be chosen again", async () => {
    const listed = await listAiProviders();
    expect(listed.some(provider => provider.id === doomedId)).toBe(false);
    expect(listed.some(provider => provider.id === liveId)).toBe(true);

    const pool = await resolveAiTask("translation");
    expect(pool.chat?.id).toBe(liveId);

    // A second delete of the same row is refused rather than silently repeating.
    await expect(deleteResearchProvider(doomedId, {})).rejects.toMatchObject({
      code: "provider_already_deleted",
    });

    // The tombstone keeps its name, so a new provider cannot take it and blur older labels.
    await expect(
      createResearchProvider({ name: "doomed gateway", provider: "custom", model: "fixture-model", apiKey: "sk-new", baseUrl: "https://reused.example.test" }),
    ).rejects.toMatchObject({ code: "provider_exists", message: expect.stringMatching(/deleted provider used that name/) });
  });
});

describe("one click assigns a provider to every email AI action", () => {
  it("writes the six actions and leaves Lead research alone", async () => {
    const tasks = await useProviderForAllActions(liveId, null);
    const leadResearch = tasks.find(task => task.task === "lead_research");
    // Lead research is deliberately absent from the bulk write, so it keeps what it had.
    expect(leadResearch?.providerId).toBe(liveId);

    const db = await getDb();
    await db.query(`UPDATE ai_task_settings SET provider_id = NULL WHERE task = 'lead_research'`);
    const after = await useProviderForAllActions(liveId, null);
    const six = after.filter(task => task.task !== "lead_research");
    expect(six).toHaveLength(6);
    for (const task of six) expect(task.providerId).toBe(liveId);
    expect(after.find(task => task.task === "lead_research")?.providerId).toBeNull();
  });

  it("refuses a provider that is not working, and refuses an unknown one", async () => {
    await expect(useProviderForAllActions(crypto.randomUUID(), null)).rejects.toMatchObject({
      code: "unknown_provider",
    });
    const untested = await createResearchProvider({ name: "Untested bulk", provider: "custom", model: "fixture-model", apiKey: "sk-untested-bulk", baseUrl: "https://untested-bulk.example.test" });
    await expect(useProviderForAllActions(untested, null)).rejects.toMatchObject({
      code: "provider_not_working",
    });
  });

  it("keeps the deleted provider out of the fallback chain at call time", async () => {
    const outcome = await runChatTask("translation", { system: "s", user: "u" }, undefined);
    // No live call is made in this test: the point is that the chain cannot name the tombstone.
    const selection = await resolveAiTask("translation");
    expect(selection.fallbackChain.some(provider => provider.id === doomedId)).toBe(false);
    expect(outcome.ok).toBe(false);
  });
});
