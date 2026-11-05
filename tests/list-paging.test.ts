import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import {
  countProspects,
  getProspectOriginFacets,
  listProspectsPage,
  PROSPECT_PAGE_SIZE,
} from "@/lib/services/prospects";
import {
  countDrafts,
  DRAFT_PAGE_SIZE,
  getDraftOriginFacets,
  listDraftsPage,
} from "@/lib/services/drafts";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * The lists used to hand back one capped window and print its length as the total, so a busy database
 * read "150 businesses" when the truth was 578, and there was no way to reach the rest. The page-size
 * cap and the true filtered total are now separate, "Load more" grows the window, and a facet count is
 * taken over the whole filtered set — loading more rows never moves it.
 *
 * Two fixtures, each longer than one page: 160 leads (page size 150) and 130 drafts (page size 120).
 * In both, the rows that sort past the first page carry a distinct agent, channel and sender, so a
 * per-page facet implementation would read zero where this one must read ten.
 */

const LEAD_MARKER = "PagingFixtureLead";
const LEAD_COUNT = PROSPECT_PAGE_SIZE + 10; // 160
const BEYOND = 10; // the leads sorted past the first page

const DRAFT_AGENT = "deepseek";
const DRAFT_COUNT = DRAFT_PAGE_SIZE + 10; // 130
const DRAFT_BEYOND = 10;

/** A fixed instant the fixture sorts from; newest is one second older than the next. */
const BASE = "2026-11-04T10:00:00Z";
/** 2026-11-05 00:30 in Karachi, so the fixture's 2026-11-04 rows are "yesterday" deterministically. */
const NOW = new Date("2026-11-05T00:30:00Z");

const createdAccounts: string[] = [];
let leadProfile = "";
let draftProfile = "";

async function newAccount(name: string, seq: number): Promise<string> {
  const db = await getDb();
  const row = await db.query<{ id: string }>(
    `INSERT INTO email_accounts (id, name, provider, email_address, normalized_email, from_name, status)
     VALUES (gen_random_uuid(), $1, 'sandbox', $2, $2, $1, 'connected')
     RETURNING id`,
    [name, `paging-fixture-${seq}-${Date.now()}@example.test`],
  );
  createdAccounts.push(row.rows[0].id);
  return row.rows[0].id;
}

async function seed() {
  const db = await getDb();
  leadProfile = await newAccount("Paging fixture leads", 1);
  draftProfile = await newAccount("Paging fixture drafts", 2);

  // Leads: the newest PROSPECT_PAGE_SIZE rows are claude over mcp_oauth with no sender; the rest carry
  // hermes over api_key pinned to a profile, so they are reachable only past the first page.
  await db.query(`INSERT INTO prospects (id, business_name, name_key, website_url, domain_key, country, categories,
                            qualification_status, status, created_by_type, source_agent, source_channel,
                            sending_profile_id, created_at, updated_at)
     SELECT gen_random_uuid(),
            '${LEAD_MARKER} ' || lpad(i::text, 3, '0'),
            'paging-fixture-lead-' || i,
            'https://pagingfixturelead' || i || '.example',
            'pagingfixturelead' || i || '.example',
            'Pagingland',
            '["forex"]'::jsonb,
            'verified', 'verified', 'api',
            CASE WHEN i <= $1 THEN 'claude' ELSE 'hermes' END,
            CASE WHEN i <= $1 THEN 'mcp_oauth' ELSE 'api_key' END,
            CASE WHEN i <= $1 THEN NULL ELSE $2::uuid END,
            $3::timestamptz - make_interval(secs => i::int),
            $3::timestamptz - make_interval(secs => i::int)
     FROM generate_series(1, $4) AS i`,
    [PROSPECT_PAGE_SIZE, leadProfile, BASE, LEAD_COUNT],
  );

  // Drafts: one first-contact draft per draft lead, newest first; the oldest have the pinned sender.
  await db.query(`INSERT INTO prospects (id, business_name, name_key, domain_key, created_by_type, source_agent,
                            source_channel, sending_profile_id)
     SELECT gen_random_uuid(),
            'PagingFixtureDraft ' || lpad(i::text, 3, '0'),
            'paging-fixture-draft-' || i,
            'pagingfixturedraft' || i || '.example',
            'api', $1, 'api_key',
            CASE WHEN i <= $2 THEN NULL ELSE $3::uuid END
     FROM generate_series(1, $4) AS i`,
    [DRAFT_AGENT, DRAFT_PAGE_SIZE, draftProfile, DRAFT_COUNT],
  );

  await db.query(`INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
                         ai_generated, warnings, created_by_type, source_agent, created_at, updated_at)
     SELECT gen_random_uuid(), p.id, 'first_contact', 0, 'draft',
            'Fixture subject ' || p.business_name,
            'Fixture body for the drafts paging test, long enough to look like a real draft.',
            'fixture@example.test',
            false, '[]'::jsonb, 'api', $1,
            $2::timestamptz - make_interval(secs => (substring(p.business_name from '[0-9]+$'))::int),
            $2::timestamptz - make_interval(secs => (substring(p.business_name from '[0-9]+$'))::int)
     FROM prospects p
     WHERE p.business_name LIKE 'PagingFixtureDraft %'`,
    [DRAFT_AGENT, BASE],
  );
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  // A prior run of this file that was interrupted can leave rows behind in the shared test database,
  // and the unique domain index would then refuse the fixture. Clear the markers first.
  const db = await getDb();
  await db.query(`DELETE FROM prospects WHERE business_name LIKE 'PagingFixtureLead %'`);
  await db.query(`DELETE FROM prospects WHERE business_name LIKE 'PagingFixtureDraft %'`);
  await seed();
});

afterAll(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM prospects WHERE business_name LIKE 'PagingFixtureLead %'`);
  await db.query(`DELETE FROM prospects WHERE business_name LIKE 'PagingFixtureDraft %'`);
  for (const id of createdAccounts) {
    await db.query(`DELETE FROM email_accounts WHERE id = $1`, [id]);
  }
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

describe("the leads list: total, load more, and whole-set facets", () => {
  it("reports the whole filtered set as the total, never the loaded page", async () => {
    const page = await listProspectsPage({ query: LEAD_MARKER });
    expect(page.total).toBe(LEAD_COUNT);
    expect(page.rows.length).toBe(PROSPECT_PAGE_SIZE);
    expect(page.rows.length).toBeLessThan(page.total);
    expect(page.hasMore).toBe(true);

    // The count is independent of the window: a one-row page does not change it.
    expect(await countProspects({ query: LEAD_MARKER })).toBe(LEAD_COUNT);
    expect(await countProspects({ query: LEAD_MARKER, limit: 1 })).toBe(LEAD_COUNT);
  });

  it("keeps the first page at the page size", async () => {
    const page = await listProspectsPage({ query: LEAD_MARKER, limit: PROSPECT_PAGE_SIZE });
    expect(page.rows.length).toBe(PROSPECT_PAGE_SIZE);
    // Exactly the newest page: nothing that only sorts past it has leaked in.
    expect(page.rows.some((row) => row.sourceAgent === "hermes")).toBe(false);
  });

  it("loads more by appending, and repeated steps reach every match", async () => {
    const first = await listProspectsPage({ query: LEAD_MARKER });
    const second = await listProspectsPage({
      query: LEAD_MARKER,
      limit: first.limit + PROSPECT_PAGE_SIZE,
    });
    expect(second.rows.length).toBeGreaterThan(first.rows.length);
    // The window grew; it did not replace, so everything on the first page is still present.
    for (const row of first.rows) {
      expect(second.rows.some((candidate) => candidate.id === row.id)).toBe(true);
    }

    let page = second;
    let guard = 0;
    while (page.hasMore && guard < 10) {
      page = await listProspectsPage({
        query: LEAD_MARKER,
        limit: Math.min(page.limit + PROSPECT_PAGE_SIZE, page.total),
      });
      guard += 1;
    }
    expect(page.hasMore).toBe(false);
    expect(page.rows.length).toBe(LEAD_COUNT);
    expect(new Set(page.rows.map((row) => row.id)).size).toBe(LEAD_COUNT);
  });

  it("counts a facet value that only exists beyond the first page", async () => {
    const firstPage = await listProspectsPage({ query: LEAD_MARKER });
    expect(firstPage.rows.some((row) => row.sourceAgent === "hermes")).toBe(false);
    expect(firstPage.rows.some((row) => row.sourceChannel === "api_key")).toBe(false);
    expect(firstPage.rows.some((row) => row.sendingProfileId === leadProfile)).toBe(false);

    // The counts are over the whole filtered set, so those values are not zero.
    const facets = await getProspectOriginFacets({ query: LEAD_MARKER });
    expect(facets.agents.hermes).toBe(BEYOND);
    expect(facets.channels.api_key).toBe(BEYOND);
    expect(facets.senders[leadProfile]).toBe(BEYOND);
    expect(facets.senders.default).toBe(PROSPECT_PAGE_SIZE);
  });

  it("does not move a facet count when more rows are loaded", async () => {
    const before = await getProspectOriginFacets({ query: LEAD_MARKER });
    const loaded = await listProspectsPage({ query: LEAD_MARKER, limit: LEAD_COUNT });
    expect(loaded.rows.length).toBe(LEAD_COUNT);
    const after = await getProspectOriginFacets({ query: LEAD_MARKER });
    expect(after).toEqual(before);
  });

  it("applies the sender filter to every other facet, over the whole filtered set", async () => {
    // Only the ten leads pinned to that profile match the filter, so every axis counts those ten —
    // the 150 unpinned leads are not in the counts, because a facet describes the filtered set.
    const pinned = await getProspectOriginFacets({ sender: leadProfile, now: NOW });
    expect(pinned.agents).toEqual({ hermes: BEYOND });
    expect(pinned.channels).toEqual({ api_key: BEYOND });
    expect(pinned.added.yesterday).toBe(BEYOND);
    expect(pinned.added.today).toBe(0);

    const loose = await getProspectOriginFacets({ sender: "default" });
    expect(loose.agents.claude).toBe(PROSPECT_PAGE_SIZE);
    expect(loose.agents.hermes ?? 0).toBe(0);
  });
});

describe("the Drafts list: total, load more, and whole-set facets", () => {
  it("reports the whole filtered set as the total, never the loaded page", async () => {
    const page = await listDraftsPage(undefined, DRAFT_PAGE_SIZE, DRAFT_AGENT);
    expect(page.total).toBe(DRAFT_COUNT);
    expect(page.rows.length).toBe(DRAFT_PAGE_SIZE);
    expect(page.rows.length).toBeLessThan(page.total);
    expect(page.hasMore).toBe(true);
    expect(await countDrafts(undefined, DRAFT_AGENT)).toBe(DRAFT_COUNT);
  });

  it("keeps the first page at the page size", async () => {
    const page = await listDraftsPage(undefined, DRAFT_PAGE_SIZE, DRAFT_AGENT);
    expect(page.rows.length).toBe(DRAFT_PAGE_SIZE);
    expect(page.rows.some((draft) => draft.sendingProfileId === draftProfile)).toBe(false);
  });

  it("loads more by appending and returns every match", async () => {
    const first = await listDraftsPage(undefined, DRAFT_PAGE_SIZE, DRAFT_AGENT);
    const second = await listDraftsPage(undefined, DRAFT_PAGE_SIZE * 2, DRAFT_AGENT);
    expect(second.rows.length).toBe(DRAFT_COUNT);
    expect(second.hasMore).toBe(false);
    for (const draft of first.rows) {
      expect(second.rows.some((candidate) => candidate.id === draft.id)).toBe(true);
    }
  });

  it("counts a facet value that only exists beyond the first page", async () => {
    const first = await listDraftsPage(undefined, DRAFT_PAGE_SIZE, DRAFT_AGENT);
    expect(first.rows.some((draft) => draft.sendingProfileId === draftProfile)).toBe(false);

    const facets = await getDraftOriginFacets(undefined, { agent: DRAFT_AGENT });
    expect(facets.senders[draftProfile]).toBe(DRAFT_BEYOND);
    expect(facets.senders.default).toBe(DRAFT_PAGE_SIZE);

    const loaded = await listDraftsPage(undefined, DRAFT_COUNT, DRAFT_AGENT);
    expect(loaded.rows.length).toBe(DRAFT_COUNT);
    const after = await getDraftOriginFacets(undefined, { agent: DRAFT_AGENT });
    expect(after).toEqual(facets);
  });

  it("applies the sender filter to the agent counts, over the whole filtered set", async () => {
    const pinned = await getDraftOriginFacets(undefined, { sender: draftProfile });
    // Only the ten drafts whose lead is pinned to that profile match, so only their agent is counted.
    expect(pinned.agents).toEqual({ [DRAFT_AGENT]: DRAFT_BEYOND });
  });
});
