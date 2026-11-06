import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { createApiKey, authenticateApiKey } from "@/lib/agent/apiKeys";
import { agentFromAssistantLabel } from "@/lib/agent/agentTag";
import { encryptSecret } from "@/lib/auth/crypto";
import { ensureBootstrapUser } from "@/lib/auth/session";

/**
 * The Settings rework, parts 1, 4, 5 and 6: one provider list (with the old form's settings carried
 * over), the No-AI fallback beside the AI actions, the research engine's own section, and Gemini as
 * an assistant connection with replacement keys.
 */

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const page = read("src/app/(app)/settings/page.tsx");
let userId = "";
/** The key as an assistant sends it: a bearer header on a request. */
const bearer = (key: string) =>
  new Request("http://localhost:3100/api/mcp", { headers: { authorization: `Bearer ${key}` } });

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  userId = (await ensureBootstrapUser({ email: "rework@example.test", password: crypto.randomUUID(), name: "Rework" })).id;
});
afterAll(async () => { await closeDb(); });

describe("part 1 — one provider list", () => {
  it("no longer renders the old DeepSeek form, and names the section 'AI providers' with the founder's line", () => {
    expect(page).not.toContain("<DeepSeekSettings");
    expect(page).not.toContain("DeepSeek research provider");
    expect(page).toContain('title="AI providers"');
    expect(page).toContain(
      "Used by the portal's own AI actions and its built-in research engine. Agents connected through MCP (Claude, ChatGPT, Gemini, Hermes) use their own models and don't use this list.",
    );
  });

  it("offers search and fetch paths as optional fields in the one add form", () => {
    const providers = read("src/components/settings/providers.tsx");
    expect(providers).toContain("Search path (optional)");
    expect(providers).toContain("Fetch path (optional)");
  });

  it("migration 028 carries a saved old-form key into the list once, and re-running it adds nothing", async () => {
    const db = await getDb();
    await db.query(`DELETE FROM provider_credentials`);
    await db.query(`DELETE FROM research_providers WHERE name = 'DeepSeek (from the old form)'`);
    const cipher = encryptSecret("sk-legacy-fixture");
    await db.query(
      `INSERT INTO provider_credentials (provider, encrypted_api_key, base_url, model)
       VALUES ('deepseek', $1, 'https://legacy.example.test', 'deepseek-legacy')`,
      [cipher],
    );
    const sql = read("src/db/migrations/028_legacy_deepseek_into_provider_list.sql");
    await db.exec(sql);
    await db.exec(sql);
    const copied = await db.query<{ encrypted_api_key: string; base_url: string; model: string; last_test_ok: boolean | null }>(
      `SELECT encrypted_api_key, base_url, model, last_test_ok FROM research_providers WHERE name = 'DeepSeek (from the old form)'`,
    );
    expect(copied.rows).toHaveLength(1);
    // The key is copied as stored, never decrypted or re-encrypted; it starts untested.
    expect(copied.rows[0]!.encrypted_api_key).toBe(cipher);
    expect(copied.rows[0]!.base_url).toBe("https://legacy.example.test");
    expect(copied.rows[0]!.model).toBe("deepseek-legacy");
    expect(copied.rows[0]!.last_test_ok).toBeNull();
    // Nothing was assigned to an action by the copy.
    const assigned = await db.query(`SELECT 1 FROM ai_task_settings s JOIN research_providers p ON p.id = s.provider_id WHERE p.name = 'DeepSeek (from the old form)'`);
    expect(assigned.rows).toHaveLength(0);
    await db.query(`DELETE FROM provider_credentials`);
  });

  it("migration 028 does nothing when the old form was never used", async () => {
    const db = await getDb();
    await db.query(`DELETE FROM provider_credentials`);
    await db.query(`DELETE FROM research_providers WHERE name = 'DeepSeek (from the old form)'`);
    await db.exec(read("src/db/migrations/028_legacy_deepseek_into_provider_list.sql"));
    const copied = await db.query(`SELECT 1 FROM research_providers WHERE name = 'DeepSeek (from the old form)'`);
    expect(copied.rows).toHaveLength(0);
  });
});

describe("part 4 — the No-AI fallback sits with the AI actions", () => {
  it("is gone from the assistants section and present, renamed, in the AI actions section", () => {
    const integrations = read("src/components/settings/integrations.tsx");
    expect(integrations).not.toContain("Deterministic writer");
    expect(integrations).not.toContain("AI drafting");
    const ai = page.slice(page.indexOf('id="ai"'), page.indexOf('id="integrations"'));
    expect(ai).toContain("<NoAiFallbackCard />");
    const card = read("src/components/settings/no-ai-fallback.tsx");
    expect(card).toContain("No-AI fallback");
    expect(card).toContain("used only when no AI provider answers");
  });

  it("labels a template draft as the No-AI fallback wherever drafts are listed", () => {
    expect(read("src/lib/ai/provenance.ts")).toContain("No-AI fallback — standard template");
    expect(read("src/components/lead-actions.tsx")).toContain("draftProvenance(");
  });
});

describe("part 5 — the research engine has its own section", () => {
  it("sits below the providers and saves only its own fields", () => {
    expect(page.indexOf('id="providers"')).toBeLessThan(page.indexOf('id="engine"'));
    expect(page.indexOf('id="engine"')).toBeLessThan(page.indexOf('id="ai"'));
    const engine = read("src/components/settings/research-engine.tsx");
    for (const field of ["researchDefaultBudgetUsd", "researchDefaultConcurrency", "deepseekSearchQps", "deepseekFetchQps"]) {
      expect(engine).toContain(field);
    }
    // The rate limits stay capped at 5 in the form (AGENTS.md rule 4).
    expect(engine.match(/max=\{5\}/g)).toHaveLength(2);
    // The search source points at a provider from the list, through the lead-research assignment.
    expect(engine).toContain('task: "lead_research"');
  });

  it("the workspace form no longer sends research fields, so the two forms cannot overwrite each other", () => {
    const form = read("src/components/settings/workspace-form.tsx");
    for (const field of ["researchDefaultBudgetUsd", "deepseekSearchQps", "deepseekFetchQps", "Autonomous research defaults"]) {
      expect(form).not.toContain(field);
    }
  });
});

describe("part 6 — Gemini as an assistant connection, with replacement keys", () => {
  it("creates and authenticates a Gemini key, attributed to Gemini", async () => {
    const created = await createApiKey({ name: "Gemini research", assistant: "gemini", userId });
    const identity = await authenticateApiKey(bearer(created.key));
    expect(identity?.assistant).toBe("gemini");
    expect(agentFromAssistantLabel("gemini")).toBe("gemini");
  });

  it("still refuses an unknown assistant label at the database", async () => {
    const db = await getDb();
    await expect(
      db.query(
        `INSERT INTO api_keys (id, name, assistant, key_prefix, key_hash, scopes, created_by, expires_at)
         VALUES ($1, 'x', 'made-up', 'p', 'h', '[]'::jsonb, $2, now() + interval '1 day')`,
        [crypto.randomUUID(), userId],
      ),
    ).rejects.toThrow(/api_keys_assistant_check/);
  });

  it("a replacement key is independent: the original keeps working until it expires or is revoked", async () => {
    const original = await createApiKey({ name: "Claude laptop", assistant: "claude", userId, scopes: ["research:read", "drafts:write"], expiresInDays: 5 });
    const replacement = await createApiKey({ name: "Claude laptop (replacement)", assistant: "claude", userId, scopes: ["research:read", "drafts:write"], expiresInDays: 90 });
    expect((await authenticateApiKey(bearer(original.key)))?.id).toBeDefined();
    const fresh = await authenticateApiKey(bearer(replacement.key));
    expect(fresh?.assistant).toBe("claude");
    expect(fresh?.scopes.sort()).toEqual(["drafts:write", "research:read"]);
  });

  it("offers Create replacement key on soon-expiring or expired keys, keeping the 14-day warning", () => {
    const integrations = read("src/components/settings/integrations.tsx");
    expect(integrations).toContain("days <= 14");
    expect(integrations).toContain("Create replacement key");
    expect(integrations).toContain("(expiringSoon || expired)");
    // The replacement copies the old key's assistant and permissions and never revokes the old one.
    const replace = integrations.slice(integrations.indexOf("async function replace"), integrations.indexOf("return (", integrations.indexOf("async function replace")));
    expect(replace).toContain("assistant: key.assistant");
    expect(replace).toContain("scopes: [...key.scopes]");
    expect(replace).not.toContain("DELETE");
    expect(page).toContain('title="ChatGPT, Claude, Gemini and Hermes"');
  });
});
