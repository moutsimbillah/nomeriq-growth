import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { runAgentAction } from "@/lib/agent/service";
import { getProspectOriginFacets, listProspects, saveProspect } from "@/lib/services/prospects";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import type { Category } from "@/lib/types";
import { countActiveFilters, leadFilterQuery, readLeadFilters } from "@/lib/leads/leadFilters";

/**
 * Agent and channel filters: they must narrow in SQL, combine with the existing filters, count what
 * each option would return, and survive a round trip through the URL.
 */

const OAUTH_CLAUDE = {
  id: "oauth:nq_filter_claude",
  name: "Claude",
  assistant: "custom" as const,
  scopes: ["research:read", "research:write", "drafts:write", "product_truth:read", "progress:read"],
};
const OAUTH_FORGED = { ...OAUTH_CLAUDE, id: "oauth:nq_filter_forged", name: "Some Crawler" };

function payload(name: string, domain: string) {
  return {
    businessName: name,
    websiteUrl: `https://${domain}`,
    categories: ["forex"] as Category[],
    signalDescription: `${name} sells paid trading signal subscriptions to retail traders.`,
    email: `contact@${domain}`,
    emailSourceType: "official_website" as const,
    emailSourceUrl: `https://${domain}/contact`,
    qualificationStatus: "verified" as const,
    sources: [{ url: `https://${domain}/pricing`, label: "Official pricing page" }],
  };
}

afterAll(async () => {
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  // No assessment: each of these saves is a candidate, which is all this file needs to filter on.
  await runAgentAction(OAUTH_CLAUDE as never, "save_prospect", payload("Claude Found Co", "claude-found.example"));
  await runAgentAction(OAUTH_FORGED as never, "save_prospect", payload("Other Found Co", "other-found.example"));
  await saveProspect({
    ...payload("Founder Added Co", "founder-added.example"),
    actorType: "founder" as const,
    qualificationStatus: "candidate" as const,
  });
  await saveProspect({ ...payload("Engine Found Co", "engine-found.example"), actorType: "deepseek" });
});

describe("filtering by agent and channel", () => {
  it("narrows to one agent", async () => {
    const claude = await listProspects({ agent: "claude" });
    expect(claude.map((p) => p.businessName)).toEqual(["Claude Found Co"]);
    expect(claude[0].sourceAgent).toBe("claude");
    expect(claude[0].sourceChannel).toBe("mcp_oauth");
  });

  it("labels an unrecognised connector as other, keeping its name", async () => {
    const other = await listProspects({ agent: "other" });
    expect(other.map((p) => p.businessName)).toEqual(["Other Found Co"]);
    expect(other[0].sourceClient).toBe("Some Crawler");
  });

  it("narrows to one channel", async () => {
    const byEngine = await listProspects({ channel: "engine" });
    expect(byEngine.map((p) => p.businessName)).toEqual(["Engine Found Co"]);
    const byPortal = await listProspects({ channel: "founder" });
    expect(byPortal.map((p) => p.businessName)).toEqual(["Founder Added Co"]);
  });

  it("combines with the existing filters", async () => {
    expect((await listProspects({ channel: "mcp_oauth" })).length).toBe(2);
    // No assessment was supplied for any of these saves, so every one is a candidate.
    expect((await listProspects({ channel: "mcp_oauth", qualification: "candidate" })).length).toBe(2);
    expect((await listProspects({ channel: "founder", qualification: "candidate" })).length).toBe(1);
    expect((await listProspects({ channel: "mcp_oauth", qualification: "verified" })).length).toBe(0);
    expect((await listProspects({ agent: "claude", channel: "api_key" })).length).toBe(0);
    expect((await listProspects({ agent: "claude", query: "claude found" })).length).toBe(1);
  });
});

describe("counts per option", () => {
  it("counts each agent and channel", async () => {
    const facets = await getProspectOriginFacets({});
    expect(facets.agents).toEqual({ claude: 1, other: 1, founder: 1, deepseek: 1 });
    expect(facets.channels).toEqual({ mcp_oauth: 2, founder: 1, engine: 1 });
  });

  it("counts what choosing the option would return, so its own narrowing is excluded", async () => {
    const facets = await getProspectOriginFacets({ agent: "claude" });
    // Narrowed to claude, the agent counts still describe every agent, so the dropdown can be changed.
    expect(facets.agents).toEqual({ claude: 1, other: 1, founder: 1, deepseek: 1 });
    // The channel counts follow the agent filter, because a channel choice has to fit it.
    expect(facets.channels).toEqual({ mcp_oauth: 1 });
  });

  it("moves the counts when the other axis is filtered, and when any other filter is", async () => {
    const byEngine = await getProspectOriginFacets({ channel: "engine" });
    expect(byEngine.agents).toEqual({ deepseek: 1 });
    expect(byEngine.channels).toEqual({ mcp_oauth: 2, founder: 1, engine: 1 });

    const candidates = await getProspectOriginFacets({ qualification: "candidate" });
    expect(candidates.agents).toEqual({ claude: 1, other: 1, founder: 1, deepseek: 1 });
    expect(candidates.channels).toEqual({ mcp_oauth: 2, founder: 1, engine: 1 });
  });

  it("treats a lead with no recorded origin as unknown, in the count and in the filter", async () => {
    const db = await getDb();
    await db.query(
      `INSERT INTO prospects (id, business_name, name_key, website_url, domain_key, categories,
                              qualification_status, status, created_by_type)
       VALUES ('cccccccc-0000-4000-8000-000000000005', 'Untagged Co', 'untagged co',
               'https://untagged.example', 'untagged.example', '["forex"]'::jsonb, 'verified', 'verified', 'founder')`,
    );

    const facets = await getProspectOriginFacets({});
    expect(facets.agents.unknown).toBe(1);

    const unknown = await listProspects({ agent: "unknown" });
    expect(unknown.map((p) => p.businessName)).toEqual(["Untagged Co"]);
    expect(unknown[0].sourceAgent).toBeNull();

    // That lead records no channel either, so it is the one unknown channel under this filter.
    const byUnknown = await getProspectOriginFacets({ agent: "unknown" });
    expect(byUnknown.channels).toEqual({ unknown: 1 });
    await db.query(`DELETE FROM prospects WHERE id = 'cccccccc-0000-4000-8000-000000000005'`);
  });
});

describe("the URL round trip", () => {
  it("reads what it writes", () => {
    const filters = {
      query: "signals",
      status: "draft_prepared",
      category: "forex",
      qualification: "verified",
      jobId: "8f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
      agent: "claude" as const,
      channel: "mcp_oauth" as const,
    };
    const query = leadFilterQuery(filters);
    expect(query).toContain("agent=claude");
    expect(query).toContain("channel=mcp_oauth");

    const params = Object.fromEntries(new URLSearchParams(query.slice(1)));
    expect(readLeadFilters(params)).toEqual(filters);
    expect(countActiveFilters(readLeadFilters(params))).toBe(7);
  });

  it("drops an unknown agent or channel instead of passing it to the query", () => {
    const filters = readLeadFilters({ agent: "not-an-agent", channel: "carrier-pigeon", q: "x" });
    expect(filters.agent).toBeUndefined();
    expect(filters.channel).toBeUndefined();
    expect(filters.query).toBe("x");
    expect(leadFilterQuery(filters)).toBe("?q=x");
  });

  it("omits empty values entirely", () => {
    expect(leadFilterQuery({})).toBe("");
    expect(leadFilterQuery({ agent: undefined, query: "" })).toBe("");
  });
});

describe("a lead with a missing prospect", () => {
  it("reports prospect_not_found, not a generic bad request", async () => {
    const failure = await runAgentAction(OAUTH_CLAUDE as never, "save_draft", {
      prospectId: "11111111-2222-4333-8444-555555555555",
      subject: "Hello",
      body: "A body long enough to pass the draft validation rules.",
    }).catch((error) => error);

    expect(failure.code).toBe("prospect_not_found");
    expect(failure.status).toBe(404);
  });

  it("records that code on the audit entry", async () => {
    const db = await getDb();
    const rows = await db.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE action = 'save_draft'
        AND actor_id = 'oauth:nq_filter_claude' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows.rows[0].metadata.outcome).toBe("invalid");
    expect(rows.rows[0].metadata.code).toBe("prospect_not_found");
  });
});

describe("what a saved row actually records", () => {
  const read = async (name: string) => {
    const db = await getDb();
    const rows = await db.query<{ source_agent: string; source_channel: string; created_by_type: string }>(
      `SELECT source_agent, source_channel, created_by_type FROM prospects WHERE business_name = $1`,
      [name],
    );
    return rows.rows[0];
  };

  it("an OAuth connector is tagged from its name, and its channel is the connector", async () => {
    const row = await read("Claude Found Co");
    expect(row).toMatchObject({ source_agent: "claude", source_channel: "mcp_oauth", created_by_type: "api" });
  });

  it("an unrecognised connector name is other, on the OAuth channel", async () => {
    const row = await read("Other Found Co");
    expect(row).toMatchObject({ source_agent: "other", source_channel: "mcp_oauth" });
  });

  it("a key whose label is hermes is Hermes over the API key channel", async () => {
    const hermesKey = {
      id: "0f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
      name: "Hermes laptop",
      assistant: "hermes" as const,
      scopes: ["research:write"],
    };
    await runAgentAction(hermesKey as never, "save_prospect", payload("Hermes Key Co", "hermes-key.example"));
    expect(await read("Hermes Key Co")).toMatchObject({ source_agent: "hermes", source_channel: "api_key" });
  });

  it("a key with a custom label is other, never a known agent", async () => {
    const customKey = {
      id: "1f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
      name: "Nightly script",
      assistant: "custom" as const,
      scopes: ["research:write"],
    };
    await runAgentAction(customKey as never, "save_prospect", payload("Custom Key Co", "custom-key.example"));
    expect(await read("Custom Key Co")).toMatchObject({ source_agent: "other", source_channel: "api_key" });
  });

  it("the founder's button is Founder on the portal channel", async () => {
    expect(await read("Founder Added Co")).toMatchObject({ source_agent: "founder", source_channel: "founder" });
  });

  it("the engine is DeepSeek on the engine channel", async () => {
    expect(await read("Engine Found Co")).toMatchObject({ source_agent: "deepseek", source_channel: "engine" });
  });

  it("cleans up after itself", async () => {
    const db = await getDb();
    await db.query(`DELETE FROM prospect_emails WHERE prospect_id IN (SELECT id FROM prospects WHERE business_name = ANY($1))`,
      [["Hermes Key Co", "Custom Key Co"]]);
    await db.query(`DELETE FROM prospect_sources WHERE prospect_id IN (SELECT id FROM prospects WHERE business_name = ANY($1))`,
      [["Hermes Key Co", "Custom Key Co"]]);
    await db.query(`DELETE FROM prospects WHERE business_name = ANY($1)`, [["Hermes Key Co", "Custom Key Co"]]);
  });
});
