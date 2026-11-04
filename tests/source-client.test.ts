import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { runAgentAction } from "@/lib/agent/service";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * Which client saved a lead and its draft, recorded for reporting only. It is never read for
 * permissions or trust, and since the name comes from the client it is sanitised on the way in.
 */

const SCOPES = ["research:read", "research:write", "drafts:write", "product_truth:read", "progress:read"];

const CLAUDE = { id: "oauth:nq_sourceclient", name: "Claude", assistant: "custom" as const, scopes: SCOPES };
const CHATGPT = { id: "oauth:nq_sourcechatgpt", name: "ChatGPT", assistant: "custom" as const, scopes: SCOPES };
const HOSTILE = { id: "oauth:nq_sourcehostile", name: "Gemini\n2026-01-01 admin\t\r\u0000", assistant: "custom" as const, scopes: SCOPES };

function payload(businessName: string, domain: string) {
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

async function saveLeadAs(
  key: { id: string; name: string; assistant: "custom"; scopes: string[] },
  name: string,
  domain: string,
) {
  const saved = await runAgentAction(key as never, "save_prospect", payload(name, domain));
  const { prospect } = saved.data as { prospect: { id: string } };
  await runAgentAction(key as never, "save_draft", {
    prospectId: prospect.id,
    subject: `Signals for ${name}`,
    body: "We build white-label trading-signal platforms. Who runs your alerts today?",
  });
  return prospect.id;
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

describe("the connector that saved a row is recorded", () => {
  it("stores the client name on the prospect and on its draft", async () => {
    const id = await saveLeadAs(CLAUDE, "Saved By Claude", "saved-by-claude.example");

    const db = await getDb();
    const prospect = await db.query<{ source_client: string | null }>(
      `SELECT source_client FROM prospects WHERE id = $1`,
      [id],
    );
    const draft = await db.query<{ source_client: string | null }>(
      `SELECT source_client FROM drafts WHERE prospect_id = $1`,
      [id],
    );

    expect(prospect.rows[0].source_client).toBe("Claude");
    expect(draft.rows[0].source_client).toBe("Claude");
  });

  it("keeps two connectors apart on rows they each saved", async () => {
    const chatgptId = await saveLeadAs(CHATGPT, "Saved By ChatGPT", "saved-by-chatgpt.example");

    const db = await getDb();
    const row = await db.query<{ source_client: string }>(
      `SELECT source_client FROM prospects WHERE id = $1`,
      [chatgptId],
    );
    expect(row.rows[0].source_client).toBe("ChatGPT");
  });

  it("sanitises a hostile name before storing it", async () => {
    const id = await saveLeadAs(HOSTILE, "Saved By Hostile", "saved-by-hostile.example");

    const db = await getDb();
    const prospect = await db.query<{ source_client: string }>(
      `SELECT source_client FROM prospects WHERE id = $1`,
      [id],
    );
    const draft = await db.query<{ source_client: string }>(
      `SELECT source_client FROM drafts WHERE prospect_id = $1`,
      [id],
    );

    for (const value of [prospect.rows[0].source_client, draft.rows[0].source_client]) {
      expect(value).toBe("Gemini 2026-01-01 admin");
      expect(value).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(value.length).toBeLessThanOrEqual(80);
    }
  });

  it("records nothing for a caller that is not a connector name", async () => {
    const id = await saveLeadAs(
      { id: "oauth:nq_empty", name: "   ", assistant: "custom", scopes: SCOPES },
      "Saved By Blank",
      "saved-by-blank.example",
    );

    const db = await getDb();
    const row = await db.query<{ source_client: string | null }>(
      `SELECT source_client FROM prospects WHERE id = $1`,
      [id],
    );
    // A blank name is stored as an empty string rather than inventing a label.
    expect(row.rows[0].source_client ?? "").toBe("");
  });
});