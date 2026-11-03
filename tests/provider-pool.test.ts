import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";

import { encryptSecret } from "@/lib/auth/crypto";
import { closeDb, getDb } from "@/lib/db/client";
import {
  FailoverResearchProvider,
  listResearchProviders,
  resolveResearchProviders,
} from "@/lib/deepseek/provider-pool";
import type { ResearchProvider } from "@/lib/deepseek/research-provider";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

function fakeProvider(
  model: string,
  behaviour: "ok" | "fail",
  label = model,
): ResearchProvider {
  const ok = behaviour === "ok";
  const explode = () => Promise.reject(new Error(`${label} is down`));
  const chatJson: ResearchProvider["chatJson"] = <T,>() =>
    ok
      ? Promise.resolve({
          data: {} as T,
          usage: { model, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 },
        })
      : explode();

  return {
    model,
    search: () => (ok ? Promise.resolve({ results: [], costUsd: 0 }) : explode()),
    fetch: () =>
      ok ? Promise.resolve({ title: "", content: "", costUsd: 0 }) : explode(),
    chatJson,
  };
}

beforeAll(async () => {
  const db = await getDb();
  await ensureWorkspaceDefaults();
  await db.query(`DELETE FROM research_providers`).catch(() => undefined);
});

afterAll(async () => {
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("FailoverResearchProvider", () => {
  it("uses the second provider when the first fails and records who served", async () => {
    const pool = new FailoverResearchProvider([
      { name: "primary", provider: fakeProvider("primary-model", "fail") },
      { name: "backup", provider: fakeProvider("backup-model", "ok") },
    ]);

    const result = await pool.search({ query: "anything", count: 3 });

    expect(result.results).toEqual([]);
    expect(pool.lastUsedProvider).toBe("backup");
    expect(pool.model).toBe("primary-model");
  });

  it("keeps trying past several failures", async () => {
    const pool = new FailoverResearchProvider([
      { name: "one", provider: fakeProvider("m1", "fail") },
      { name: "two", provider: fakeProvider("m2", "fail") },
      { name: "three", provider: fakeProvider("m3", "ok") },
    ]);

    await pool.fetch({ url: "https://example.com" });

    expect(pool.lastUsedProvider).toBe("three");
  });

  it("throws the last error only when every provider failed", async () => {
    const pool = new FailoverResearchProvider([
      { name: "one", provider: fakeProvider("m1", "fail", "first") },
      { name: "two", provider: fakeProvider("m2", "fail", "second") },
    ]);

    await expect(pool.search({ query: "q", count: 1 })).rejects.toThrow("second is down");
    expect(pool.lastUsedProvider).toBeNull();
  });

  it("throws a clear error when the pool is empty", async () => {
    const pool = new FailoverResearchProvider([]);
    await expect(pool.chatJson({ system: "s", user: "u" })).rejects.toThrow(
      /No research provider is configured/,
    );
  });
});

describe("resolveResearchProviders", () => {
  it("falls back to the single stored credential when no ordered providers exist", async () => {
    const resolved = await resolveResearchProviders({ searchQps: 2, fetchQps: 1 });

    expect(resolved.provider).toBeNull();
    expect(resolved.error).toBeTruthy();
    expect(resolved.names).toEqual([]);
  });

  it("orders enabled providers by priority and leaves disabled ones out", async () => {
    const db = await getDb();
    const rows = [
      { name: "second", priority: 20, enabled: true },
      { name: "disabled", priority: 5, enabled: false },
      { name: "first", priority: 10, enabled: true },
    ];

    for (const row of rows) {
      await db.query(
        `INSERT INTO research_providers
           (id, name, provider, base_url, model, encrypted_api_key, priority, is_enabled)
         VALUES ($1, $2, 'deepseek', 'https://api.deepseek.com', 'deepseek-flash', $3, $4, $5)`,
        [crypto.randomUUID(), row.name, encryptSecret("sk-test-key-for-pool"), row.priority, row.enabled],
      );
    }

    const listed = await listResearchProviders();
    expect(listed.filter((entry) => entry.isEnabled).map((entry) => entry.name)).toEqual([
      "first",
      "second",
    ]);
    expect(listed.every((entry) => entry.hasKey)).toBe(true);

    const resolved = await resolveResearchProviders({ searchQps: 2, fetchQps: 1 });
    expect(resolved.names).toEqual(["first", "second"]);
    expect(resolved.provider).toBeTruthy();
    expect(resolved.error).toBeNull();
  });
});