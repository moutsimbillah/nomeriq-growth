import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { runAgentAction } from "@/lib/agent/service";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * OAuth-connected clients present no API key, so without an explicit client name in the audit
 * entry claude.ai, ChatGPT and Gemini are indistinguishable from each other in audit_log.
 */

afterAll(async () => {
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

beforeAll(async () => {
  await ensureWorkspaceDefaults();
});

async function rowsFor(actorId: string, action: string) {
  const db = await getDb();
  const result = await db.query<{ actor_type: string; metadata: Record<string, unknown> }>(
    `SELECT actor_type, metadata FROM audit_log WHERE actor_id = $1 AND action = $2`,
    [actorId, action],
  );
  return result.rows;
}

describe("agent audit entries name their client", () => {
  it("records the OAuth client name so claude.ai, ChatGPT and Gemini can be told apart", async () => {
    // Exactly the identity authenticateApiKey builds for an OAuth access token.
    const claude = { id: "oauth:nq_claudeclient", name: "Claude", assistant: "custom" as const, scopes: ["research:read"] };
    const chatgpt = { id: "oauth:nq_chatgptclient", name: "ChatGPT", assistant: "custom" as const, scopes: ["research:read"] };

    await runAgentAction(claude, "get_instructions");
    await runAgentAction(chatgpt, "get_instructions");

    const claudeRows = await rowsFor("oauth:nq_claudeclient", "get_instructions");
    const chatgptRows = await rowsFor("oauth:nq_chatgptclient", "get_instructions");

    // One entry per call — the name is added to the existing entry, not a second row.
    expect(claudeRows).toHaveLength(1);
    expect(chatgptRows).toHaveLength(1);

    expect(claudeRows[0].metadata.client).toBe("Claude");
    expect(chatgptRows[0].metadata.client).toBe("ChatGPT");

    // Both still share the identical actor_type — which is exactly why the name is needed.
    expect(claudeRows[0].actor_type).toBe("api_key:custom");
    expect(chatgptRows[0].actor_type).toBe("api_key:custom");
  });

  it("keeps the existing args metadata and adds the key label for an API key", async () => {
    const key = { id: "11111111-2222-3333-4444-555555555555", name: "Hermes laptop", assistant: "hermes" as const, scopes: ["research:read"] };

    await runAgentAction(key, "get_instructions");

    const rows = await rowsFor("11111111-2222-3333-4444-555555555555", "get_instructions");
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.client).toBe("Hermes laptop");
    expect(rows[0].actor_type).toBe("api_key:hermes");
    // Detail the entry already carried must not be lost.
    expect(rows[0].metadata.args).toEqual([]);
  });
});