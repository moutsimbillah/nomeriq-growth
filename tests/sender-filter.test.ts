import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { countActiveFilters, leadFilterQuery, readLeadFilters } from "@/lib/leads/leadFilters";
import { getDraftOriginFacets, listDrafts } from "@/lib/services/drafts";
import { getProspectOriginFacets, listProspects } from "@/lib/services/prospects";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * The "All senders" filter, from the URL to the SQL.
 *
 * A lead that has not been emailed yet has no profile of its own, and counts under "default" — so the
 * option counts always add up to the rows the filter returns.
 */

const created = { accounts: [] as string[], prospects: [] as string[] };
let seq = 0;

async function newAccount(name: string): Promise<string> {
  const db = await getDb();
  seq += 1;
  const email = `sender-filter-${seq}-${Date.now()}@example.test`;
  const row = await db.query<{ id: string }>(
    `INSERT INTO email_accounts (id, name, provider, email_address, normalized_email, from_name, status)
     VALUES (gen_random_uuid(), $1, 'sandbox', $2, $2, $1, 'connected')
     RETURNING id`,
    [name, email],
  );
  created.accounts.push(row.rows[0].id);
  return row.rows[0].id;
}

async function newProspect(profileId: string | null, agent: string | null): Promise<string> {
  const db = await getDb();
  seq += 1;
  const row = await db.query<{ id: string }>(
    `INSERT INTO prospects (id, business_name, name_key, created_by_type, sending_profile_id, source_agent)
     VALUES (gen_random_uuid(), $1, $2, 'founder', $3, $4)
     RETURNING id`,
    [`Sender Filter Co ${seq}`, `sender-filter-${seq}-${Date.now()}`, profileId, agent],
  );
  created.prospects.push(row.rows[0].id);
  return row.rows[0].id;
}

const UUID = "f8602ca5-bf39-402b-84cd-21212da236fd";

beforeAll(async () => {
  await ensureWorkspaceDefaults();
});
afterAll(async () => {
  const db = await getDb();
  for (const id of created.prospects) await db.query(`DELETE FROM prospects WHERE id = $1`, [id]);
  for (const id of created.accounts) await db.query(`DELETE FROM email_accounts WHERE id = $1`, [id]);
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

describe("the All senders filter", () => {
  it("keeps a real profile id or the word default, and drops anything else", () => {
    expect(readLeadFilters({ sender: UUID }).sender).toBe(UUID);
    expect(readLeadFilters({ sender: "default" }).sender).toBe("default");
    // a hand-edited address bar cannot ask for something that does not exist
    expect(readLeadFilters({ sender: "not-a-uuid" }).sender).toBeUndefined();
    expect(readLeadFilters({ sender: "1; DROP TABLE prospects" }).sender).toBeUndefined();
    expect(readLeadFilters({ sender: "" }).sender).toBeUndefined();
  });

  it("travels in the URL and counts as an active filter", () => {
    const query = leadFilterQuery({ sender: UUID, agent: "claude" });
    expect(query).toContain(`sender=${UUID}`);
    expect(query).toContain("agent=claude");
    expect(countActiveFilters({ sender: UUID })).toBe(1);
    expect(countActiveFilters({ sender: UUID, agent: "claude" })).toBe(2);
  });

  it("returns only the leads tied to that profile, and default for the rest", async () => {
    const first = await newAccount("First profile");
    const second = await newAccount("Second profile");
    await newProspect(first, "claude");
    await newProspect(first, "chatgpt");
    await newProspect(second, "claude");
    await newProspect(null, "claude");

    const forFirst = await listProspects({ sender: first, limit: 500 });
    expect(forFirst.length).toBeGreaterThanOrEqual(2);
    expect(forFirst.every((row) => row.sendingProfileId === first)).toBe(true);

    const forSecond = await listProspects({ sender: second, limit: 500 });
    expect(forSecond.every((row) => row.sendingProfileId === second)).toBe(true);

    const forDefault = await listProspects({ sender: "default", limit: 500 });
    expect(forDefault.every((row) => !row.sendingProfileId)).toBe(true);
    expect(forDefault.length).toBeGreaterThanOrEqual(1);
  });

  it("counts each profile, and the counts add up to the rows returned", async () => {
    const first = await newAccount("Counts profile");
    await newProspect(first, "claude");
    await newProspect(first, null);

    const facets = await getProspectOriginFacets({});
    const total = (await listProspects({ limit: 500 })).length;
    const sum = Object.values(facets.senders).reduce((a, b) => a + b, 0);
    expect(sum).toBe(total);
    expect(facets.senders[first]).toBeGreaterThanOrEqual(2);
    expect(facets.senders.default).toBeGreaterThanOrEqual(1);
  });

  it("narrows the other axes when a sender is chosen, and vice versa", async () => {
    const only = await newAccount("Narrowing profile");
    await newProspect(only, "gemini");
    await newProspect(only, "gemini");

    // the agent counts carry the sender filter
    const narrowed = await getProspectOriginFacets({ sender: only });
    expect(narrowed.agents.gemini).toBeGreaterThanOrEqual(2);

    // and the sender counts carry the agent filter: only one sender has a gemini lead at all
    const byAgent = await getProspectOriginFacets({ agent: "gemini" });
    const geminiTotal = (await listProspects({ agent: "gemini", limit: 500 })).length;
    const geminiSum = Object.values(byAgent.senders).reduce((a, b) => a + b, 0);
    expect(geminiSum).toBe(geminiTotal);
  });

  it("applies to drafts as well, through the lead's profile", async () => {
    const profile = await newAccount("Drafts profile");
    const pinned = await newProspect(profile, "claude");
    const loose = await newProspect(null, "claude");
    const db = await getDb();
    for (const prospectId of [pinned, loose]) {
      await db.query(
        `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
                             ai_generated, warnings, created_by_type)
         VALUES (gen_random_uuid(), $1, 'first_contact', 0, 'draft', 'Subject', 'Body', 'a@b.test',
                 false, '[]'::jsonb, 'founder')`,
        [prospectId],
      );
    }

    const pinnedDrafts = await listDrafts(undefined, 500, undefined, { sender: profile });
    expect(pinnedDrafts.every((draft) => draft.sendingProfileId === profile)).toBe(true);
    expect(pinnedDrafts.length).toBeGreaterThanOrEqual(1);

    const defaultDrafts = await listDrafts(undefined, 500, undefined, { sender: "default" });
    expect(defaultDrafts.some((draft) => draft.prospectId === loose)).toBe(true);
    expect(defaultDrafts.every((draft) => !draft.sendingProfileId)).toBe(true);

    const facets = await getDraftOriginFacets(undefined, { sender: profile });
    expect(facets.senders[profile]).toBeGreaterThanOrEqual(1);
  });
});
