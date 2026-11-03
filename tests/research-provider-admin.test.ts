import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";

import { decryptSecret } from "@/lib/auth/crypto";
import { closeDb, getDb } from "@/lib/db/client";
import {
  createResearchProvider,
  updateResearchProvider,
} from "@/lib/services/research-provider-admin";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

const state = { firstId: "" };

async function storedKey(id: string): Promise<{ cipher: string; baseUrl: string; model: string }> {
  const db = await getDb();
  const result = await db.query<{ encrypted_api_key: string; base_url: string; model: string }>(
    `SELECT encrypted_api_key, base_url, model FROM research_providers WHERE id = $1`,
    [id],
  );
  const row = result.rows[0]!;
  return { cipher: row.encrypted_api_key, baseUrl: row.base_url, model: row.model };
}

beforeAll(async () => {
  const db = await getDb();
  await ensureWorkspaceDefaults();
  await db.query(`DELETE FROM research_providers`);
});

afterAll(async () => {
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("research provider administration", () => {
  it("stores the key encrypted and never in the clear", async () => {
    state.firstId = await createResearchProvider({
      name: "Primary gateway",
      apiKey: "sk-first-provider-secret",
      baseUrl: "https://gateway.example.com/",
      model: "deepseek-v4.1",
    });

    const stored = await storedKey(state.firstId);

    expect(stored.cipher).not.toContain("sk-first-provider-secret");
    expect(decryptSecret(stored.cipher)).toBe("sk-first-provider-secret");
    // cleanBaseUrl trims the trailing slash.
    expect(stored.baseUrl).toBe("https://gateway.example.com");
    expect(stored.model).toBe("deepseek-v4.1");
  });

  it("refuses a duplicate provider name", async () => {
    await expect(
      createResearchProvider({ name: "primary gateway", apiKey: "sk-another" }),
    ).rejects.toMatchObject({ code: "provider_exists", status: 409 });
  });

  it("refuses a provider without a name or a key", async () => {
    await expect(createResearchProvider({ name: "", apiKey: "sk-x" })).rejects.toMatchObject({
      code: "invalid_provider",
    });
    await expect(createResearchProvider({ name: "No key", apiKey: "" })).rejects.toMatchObject({
      code: "invalid_provider",
    });
  });

  it("keeps the stored key when an update omits it", async () => {
    const before = await storedKey(state.firstId);

    await updateResearchProvider(state.firstId, {
      name: "Primary gateway",
      model: "deepseek-flash",
      priority: 5,
      isEnabled: true,
    });

    const after = await storedKey(state.firstId);
    expect(after.cipher).toBe(before.cipher);
    expect(after.model).toBe("deepseek-flash");

    const db = await getDb();
    const row = await db.query<{ priority: number; is_enabled: boolean }>(
      `SELECT priority, is_enabled FROM research_providers WHERE id = $1`,
      [state.firstId],
    );
    expect(Number(row.rows[0]!.priority)).toBe(5);
    expect(row.rows[0]!.is_enabled).toBe(true);
  });

  it("replaces the key when a new one is supplied", async () => {
    await updateResearchProvider(state.firstId, { apiKey: "sk-rotated-secret" });

    const after = await storedKey(state.firstId);
    expect(decryptSecret(after.cipher)).toBe("sk-rotated-secret");
  });

  it("disables a provider and reports a missing one", async () => {
    await updateResearchProvider(state.firstId, { isEnabled: false });

    const db = await getDb();
    const row = await db.query<{ is_enabled: boolean }>(
      `SELECT is_enabled FROM research_providers WHERE id = $1`,
      [state.firstId],
    );
    expect(row.rows[0]!.is_enabled).toBe(false);

    await expect(
      updateResearchProvider(crypto.randomUUID(), { isEnabled: true }),
    ).rejects.toMatchObject({ code: "provider_not_found", status: 404 });
  });
});