import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { runAgentAction } from "@/lib/agent/service";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * The exact payload claude.ai sent on 4 Nov 2026, which failed twice at 09:14-09:17 and produced no
 * audit entry. The cause was not the payload: save_prospect wrote the caller's identity into
 * prospects.created_by_key_id, a uuid column, and an OAuth client's identity is `oauth:<clientId>`.
 * Postgres rejected the insert, so the tool failed before the audit entry that would have recorded
 * it — every save from a connector died, while the portal and API-key callers were fine.
 */

const PAYLOAD = {
  businessName: "P4 Provider",
  websiteUrl: "https://p4provider.com",
  aliases: ["P4Provider"],
  categories: ["forex", "crypto"],
  country: "Pakistan",
  signalDescription:
    "Sells paid VIP Crypto Signals and VIP Forex Signals subscriptions, alongside a separate paid trading mentorship. Signals come with full reasoning and the team states it shares wins and losses publicly.",
  pricingDetails:
    "VIP Crypto Signals and VIP Forex Signals: $10/month (Rs. 3,000), $55/6 months, $110/year, $1,000 lifetime. Mentorship is separate: online $150 (Rs. 45,000), physical $200 (Rs. 60,000), lifetime access. 1-on-1 meeting $50. Observed on the official pricing page on 4 Nov 2026.",
  email: "contact@p4provider.com",
  emailSourceType: "official_website",
  emailSourceUrl: "https://p4provider.com/contact",
  instagramUrl: "https://www.instagram.com/instap4provider",
  youtubeUrl: "https://www.youtube.com/@p4provider",
  xUrl: "https://x.com/p4provider",
  qualificationStatus: "verified",
  evidenceSummary:
    "The official pricing page lists VIP Crypto Signals and VIP Forex Signals as separate paid subscriptions with prices from one month to lifetime, and its FAQ confirms the business provides trading signals. The mentorship is sold separately, so the paid signal service is verified independently of the education. The official contact page publishes contact@p4provider.com. Offices listed in Faisalabad and Lahore, Pakistan.",
  researchNotes:
    "Saved on 4 Nov 2026 as part of the MCP platform test (Claude connector), after re-checking the live pages. The pricing page's meta description says signals are \"from $30/month\" while the page body shows $10/month; the body prices were used. Follower and subscriber counts were not captured. contact@ is a generic inbox: valid as a contact address, not an identity key.",
  sources: [
    {
      url: "https://p4provider.com/pricing",
      label: "Official pricing page: VIP Crypto and VIP Forex signals plans",
      notes: "Separate paid subscriptions, monthly to lifetime, plus separate mentorship plans.",
      observedAt: "2026-11-04T09:15:00.000Z",
    },
    {
      url: "https://p4provider.com/contact",
      label: "Official contact page: published business email",
      notes: "Publishes contact@p4provider.com and campuses in Faisalabad and Lahore.",
      observedAt: "2026-11-04T09:15:00.000Z",
    },
  ],
};

const OAUTH_KEY = {
  // Exactly the identity authenticateApiKey builds for an OAuth access token.
  id: "oauth:nq_BF9cLcgxJGW_TVB9l_am3w",
  name: "Claude",
  assistant: "custom" as const,
  scopes: ["research:read", "research:write", "drafts:write", "progress:read", "product_truth:read"],
};

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

describe("save_prospect from an OAuth-connected client", () => {
  it("saves the prospect the connector sent", async () => {
    const result = await runAgentAction(OAUTH_KEY as never, "save_prospect", PAYLOAD);

    const data = result.data as {
      created: boolean;
      duplicate: boolean;
      prospect: { id: string; businessName: string };
    };
    expect(data.created).toBe(true);
    expect(data.duplicate).toBe(false);
    expect(data.prospect.businessName).toBe("P4 Provider");
    expect(data.prospect.id).toBeTruthy();
  });

  it("records the row without a key id, since an OAuth client has none", async () => {
    const db = await getDb();
    const row = await db.query<{ created_by_type: string; created_by_key_id: string | null }>(
      `SELECT created_by_type, created_by_key_id FROM prospects WHERE website_url LIKE '%p4provider.com%'`,
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].created_by_type).toBe("api");
    expect(row.rows[0].created_by_key_id).toBeNull();
  });

  it("still deduplicates a second identical save", async () => {
    const again = await runAgentAction(OAUTH_KEY as never, "save_prospect", PAYLOAD);
    const data = again.data as { created: boolean; duplicate: boolean };

    expect(data.created).toBe(false);
    expect(data.duplicate).toBe(true);

    const db = await getDb();
    const count = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM prospects WHERE website_url LIKE '%p4provider.com%'`,
    );
    expect(count.rows[0].n).toBe(1);
  });
});