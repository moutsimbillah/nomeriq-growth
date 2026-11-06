import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { createResearchProvider } from "@/lib/services/research-provider-admin";
import { saveTaskSetting } from "@/lib/services/ai-task-settings";

/** Leave no AI assignment behind: later test files expect an unconfigured registry. */
async function clearAiSettings() {
  const db = await getDb();
  await db.query(`DELETE FROM ai_task_fallbacks`);
  await db.query(`DELETE FROM ai_task_settings`);
  await db.query(`DELETE FROM research_providers`);
}
import { runChatTask } from "@/lib/ai/registry";

/**
 * Runtime failover across different provider types. Each provider is answered by a synthetic fetch
 * keyed on its own protocol, so the assertions prove which vendor actually produced the text — never
 * a real network call.
 */

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

async function add(name: string, provider: string, priority: number, baseUrl: string) {
  const id = await createResearchProvider({
    name,
    provider,
    kinds: provider === "brave" ? "search" : "chat",
    model: provider === "brave" ? undefined : `${provider}-model`,
    apiKey: `fixture-${provider}`,
    baseUrl,
    priority,
  });
  const db = await getDb();
  await db.query(`UPDATE research_providers SET last_test_ok = true WHERE id = $1`, [id]);
  return id;
}

/** Answers per vendor protocol; `failing` hosts return an error instead. */
function stubVendors(failing: string[] = []) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const host = new URL(url).host;
    calls.push(host);
    if (failing.includes(host)) return json({ error: { code: "server_error" } }, 500);
    if (url.includes("/messages")) return json({ content: [{ type: "text", text: `answer from ${host}` }] });
    if (url.includes(":generateContent")) return json({ candidates: [{ content: { parts: [{ text: `answer from ${host}` }] } }] });
    return json({ choices: [{ message: { content: `answer from ${host}` } }] });
  }));
  return calls;
}

beforeEach(async () => {
  await ensureWorkspaceDefaults();
  const db = await getDb();
  await db.query(`DELETE FROM ai_task_fallbacks`);
  await db.query(`DELETE FROM ai_task_settings`);
  await db.query(`DELETE FROM research_providers`);
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await clearAiSettings();
  await closeDb(); });

describe("an action whose provider is disabled or failing still answers, and says who answered", () => {
  it("skips a disabled OpenAI assignment and is answered by Anthropic", async () => {
    const openai = await add("OpenAI main", "openai", 10, "https://openai.example.test");
    await add("Claude backup", "anthropic", 20, "https://anthropic.example.test");
    await saveTaskSetting("translation", { providerId: openai });
    const db = await getDb();
    await db.query(`UPDATE research_providers SET is_enabled = false WHERE id = $1`, [openai]);

    const calls = stubVendors();
    const outcome = await runChatTask("translation", { system: "s", user: "u" });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toBe("answer from anthropic.example.test");
      expect(outcome.providerName).toBe("Claude backup");
      expect(outcome.provider).toBe("anthropic");
      expect(outcome.fallbackUsed).toBe("Claude backup");
    }
    // The disabled provider was never called at all.
    expect(calls).not.toContain("openai.example.test");
  });

  it("falls from a failing Custom gateway to Gemini, skipping a search-only Brave row", async () => {
    const custom = await add("Custom gateway", "custom", 10, "https://custom.example.test/v1");
    await add("Brave", "brave", 15, "https://brave.example.test");
    await add("Gemini backup", "gemini", 20, "https://gemini.example.test");
    await saveTaskSetting("suggest_reply", { providerId: custom });

    const calls = stubVendors(["custom.example.test"]);
    const outcome = await runChatTask("suggest_reply", { system: "s", user: "u" });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.providerName).toBe("Gemini backup");
      expect(outcome.provider).toBe("gemini");
      expect(outcome.fallbackUsed).toBe("Gemini backup");
    }
    // The assigned provider was tried first; Brave can never be a chat fallback.
    expect(calls[0]).toBe("custom.example.test");
    expect(calls).not.toContain("brave.example.test");
  });

  it("among providers sharing an order number, tries the test-passed one before the failing one", async () => {
    const assigned = await add("DeepSeek main", "deepseek", 5, "https://deepseek.example.test");
    const failing = await add("A failing OpenRouter", "openrouter", 50, "https://openrouter.example.test");
    await add("Z passing OpenAI", "openai", 50, "https://openai.example.test");
    const db = await getDb();
    await db.query(`UPDATE research_providers SET last_test_ok = false WHERE id = $1`, [failing]);
    await saveTaskSetting("first_email", { providerId: assigned });

    // The failing row sorts first by name, so only the Test-result tiebreak puts OpenAI ahead of it.
    const calls = stubVendors(["deepseek.example.test"]);
    const outcome = await runChatTask("first_email", { system: "s", user: "u" });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.providerName).toBe("Z passing OpenAI");
    expect(calls).toEqual(["deepseek.example.test", "openai.example.test"]);
  });

  it("reports the assigned provider by name when it answers itself, with no fallback flag", async () => {
    const openrouter = await add("OpenRouter main", "openrouter", 10, "https://openrouter.example.test/api");
    await add("Claude backup", "anthropic", 20, "https://anthropic.example.test");
    await saveTaskSetting("follow_up", { providerId: openrouter });

    stubVendors();
    const outcome = await runChatTask("follow_up", { system: "s", user: "u" });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.providerName).toBe("OpenRouter main");
      expect(outcome.fallbackUsed).toBeUndefined();
    }
  });

  it("fails clearly, naming no secret, when nothing usable remains", async () => {
    const custom = await add("Only gateway", "custom", 10, "https://custom.example.test");
    await saveTaskSetting("classification", { providerId: custom });
    const db = await getDb();
    await db.query(`UPDATE research_providers SET is_enabled = false WHERE id = $1`, [custom]);

    const calls = stubVendors();
    const outcome = await runChatTask("classification", { system: "s", user: "u" });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("all_providers_failed");
      expect(outcome.reason).toMatch(/disabled or has no passing Test/);
      expect(outcome.reason).not.toMatch(/fixture-/);
    }
    expect(calls).toEqual([]);
  });
});
