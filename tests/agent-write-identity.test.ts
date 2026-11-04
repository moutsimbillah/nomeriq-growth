import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { runAgentAction } from "@/lib/agent/service";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * Real database, no mocks: both identities the MCP server hands to runAgentAction, saving through
 * the tools that write. An OAuth caller has no API key, so it must still save, and must never be
 * written into a uuid key-id column; an API-key caller must keep recording its key id.
 */

const SCOPES = [
  "research:read",
  "research:write",
  "drafts:write",
  "progress:read",
  "product_truth:read",
  "conversations:read",
];

// Exactly what authenticateApiKey builds for an OAuth access token.
const OAUTH_KEY = { id: "oauth:nq_BF9cLcgxJGW_TVB9l_am3w", name: "Claude", assistant: "custom" as const, scopes: SCOPES };
// And for a real API key, whose id is the api_keys row id.
const KEY_ID = "8f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
const API_KEY = { id: KEY_ID, name: "Hermes laptop", assistant: "hermes" as const, scopes: SCOPES };

function prospectPayload(businessName: string, domain: string) {
  return {
    businessName,
    websiteUrl: `https://${domain}`,
    categories: ["forex"],
    signalDescription: `${businessName} sells paid trading signal subscriptions to retail traders.`,
    email: `contact@${domain}`,
    emailSourceType: "official_website",
    emailSourceUrl: `https://${domain}/contact`,
    qualificationStatus: "verified",
    sources: [{ url: `https://${domain}/pricing`, label: "Official pricing page" }],
  };
}

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

describe("what a write records about its caller", () => {
  it("lets an OAuth caller save a prospect and a draft, with no key id", async () => {
    const saved = await runAgentAction(OAUTH_KEY as never, "save_prospect", prospectPayload("OAuth Saved Co", "oauth-saved.example"));
    const savedData = saved.data as { created: boolean; prospect: { id: string } };
    expect(savedData.created).toBe(true);

    const draft = await runAgentAction(OAUTH_KEY as never, "save_draft", {
      prospectId: savedData.prospect.id,
      subject: "Independent signals for your desk",
      body: "We build white-label trading-signal platforms. One question: who runs your alerts today?",
    });
    expect((draft.data as { saved: boolean }).saved).toBe(true);

    const db = await getDb();
    const prospect = await db.query<{ created_by_type: string; created_by_key_id: string | null }>(
      `SELECT created_by_type, created_by_key_id FROM prospects WHERE id = $1`,
      [savedData.prospect.id],
    );
    expect(prospect.rows[0].created_by_type).toBe("api");
    // An OAuth client has no api_keys row, so there is no uuid to record and the insert must pass.
    expect(prospect.rows[0].created_by_key_id).toBeNull();

    const rows = await db.query<{ created_by_type: string; created_by_user_id: string | null }>(
      `SELECT created_by_type, created_by_user_id FROM drafts WHERE prospect_id = $1`,
      [savedData.prospect.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].created_by_type).toBe("api");
    expect(rows.rows[0].created_by_user_id).toBeNull();
  });

  it("still records the key id for an API-key caller", async () => {
    const saved = await runAgentAction(API_KEY as never, "save_prospect", prospectPayload("Key Saved Co", "key-saved.example"));
    const savedData = saved.data as { created: boolean; prospect: { id: string } };
    expect(savedData.created).toBe(true);

    const db = await getDb();
    const row = await db.query<{ created_by_type: string; created_by_key_id: string | null }>(
      `SELECT created_by_type, created_by_key_id FROM prospects WHERE id = $1`,
      [savedData.prospect.id],
    );
    expect(row.rows[0].created_by_type).toBe("api");
    expect(row.rows[0].created_by_key_id).toBe(KEY_ID);
  });

  it("records the OAuth client's name on the audit entry for each write", async () => {
    const db = await getDb();
    const rows = await db.query<{ action: string; actor_id: string; metadata: { client?: string } }>(
      `SELECT action, actor_id, metadata FROM audit_log
       WHERE actor_id = 'oauth:nq_BF9cLcgxJGW_TVB9l_am3w'
       ORDER BY created_at`,
    );
    const actions = rows.rows.map((row) => row.action);
    expect(actions).toContain("save_prospect");
    expect(actions).toContain("save_draft");
    for (const row of rows.rows) {
      expect(row.metadata.client).toBe("Claude");
    }
  });
});