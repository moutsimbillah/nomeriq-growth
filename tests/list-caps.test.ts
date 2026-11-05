import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb, type DbClient } from "@/lib/db/client";
import {
  listSentMessagesPage,
  SENT_PAGE_SIZE,
} from "@/lib/services/conversations";
import {
  FOLLOW_UP_DRAFT_PAGE_SIZE,
  getFollowUpOverview,
  listFollowUpDraftsPage,
} from "@/lib/services/followups";

/**
 * The display caps item 0 removes.
 *
 * The fault being pinned is specific and was visible on live: the Sent tab loaded 100 rows and
 * printed that length as its count, so a mailbox with 454 sent messages read "100". Every list here
 * must therefore report a total counted over the whole set, and the window must be a *step* toward
 * that total — raising `limit` must always reach the last row, never stall one short of it.
 *
 * Each test makes its own rows and scopes its assertions to them, because the suite shares one PGlite
 * directory across files.
 */

let db: DbClient;
const RUN = `cape-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const prospectIds: string[] = [];
const messageIds: string[] = [];
const draftIds: string[] = [];

/** More than one page, so "the first page is 100" and "loading more reaches the end" both bite. */
const SENT_ROWS = SENT_PAGE_SIZE + 37; // 137
const FOLLOW_UP_ROWS = FOLLOW_UP_DRAFT_PAGE_SIZE + 12; // 112

async function seedProspect(index: number): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO prospects (id, business_name, name_key, domain_key, status, qualification_status, country, categories, created_by_type, source_agent, source_channel)
     VALUES ($1, $2, $3, $4, 'contacted', 'verified', 'PK', '{}', 'api', 'claude', 'mcp_oauth')`,
    [id, `${RUN} prospect ${index}`, `${RUN}-name-${index}`, `${RUN}-${index}.example.test`],
  );
  prospectIds.push(id);
  return id;
}

beforeAll(async () => {
  db = await getDb();

  // Sent messages: plain outbound rows, each with a distinct, increasing sent_at.
  const prospectId = await seedProspect(0);
  for (let i = 0; i < SENT_ROWS; i += 1) {
    const id = crypto.randomUUID();
    messageIds.push(id);
    await db.query(
      `INSERT INTO messages (id, prospect_id, direction, source, from_email, to_emails, subject, body_text, sent_at)
       VALUES ($1, $2, 'outbound', 'seed', 'fixture@example.test', $3::jsonb, $4, 'body', now() - ($5 || ' minutes')::interval)`,
      [id, prospectId, JSON.stringify([`to-${i}@example.test`]), `${RUN} sent ${i}`, String(i)],
    );
  }

  // Follow-up drafts on their own prospects, so the candidate query is not what is being measured.
  for (let i = 0; i < FOLLOW_UP_ROWS; i += 1) {
    const owner = await seedProspect(i + 1);
    const id = crypto.randomUUID();
    draftIds.push(id);
    await db.query(
      `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
        ai_generated, product_truth_version, warnings, created_by_type, created_at, updated_at)
       VALUES ($1, $2, 'follow_up', 1, 'draft', $3, 'body', 'to@example.test', false, 1, '[]'::jsonb,
        'founder', now() - ($4 || ' minutes')::interval, now() - ($4 || ' minutes')::interval)`,
      [id, owner, `${RUN} follow-up ${i}`, String(i)],
    );
  }
});

afterAll(async () => {
  for (const id of draftIds) await db.query(`DELETE FROM drafts WHERE id = $1`, [id]);
  for (const id of messageIds) await db.query(`DELETE FROM messages WHERE id = $1`, [id]);
  for (const id of prospectIds) await db.query(`DELETE FROM prospects WHERE id = $1`, [id]);
  await closeDb();
});

describe("the Sent tab counts the whole mailbox", () => {
  it("reports the full outbound total, not the size of its own page", async () => {
    const first = await listSentMessagesPage();
    expect(first.total).toBeGreaterThanOrEqual(SENT_ROWS);
    expect(first.limit).toBe(SENT_PAGE_SIZE);
    expect(first.rows).toHaveLength(SENT_PAGE_SIZE);
    expect(first.hasMore).toBe(true);
    // The total is a count of the whole set, so it is larger than the page — the exact bug.
    expect(first.total).toBeGreaterThan(first.rows.length);
  });

  it("reaches the last row when the window is raised step by step", async () => {
    const full = await listSentMessagesPage(SENT_PAGE_SIZE * 100);
    expect(full.rows).toHaveLength(full.total);
    expect(full.hasMore).toBe(false);

    const ids = new Set(full.rows.map((row) => row.id));
    // Every row seeded for this run is reachable, and none appears twice.
    for (const id of messageIds) expect(ids.has(id)).toBe(true);
    expect(ids.size).toBe(full.rows.length);
  });

  it("clamps a window larger than the total instead of asking the database for it", async () => {
    const page = await listSentMessagesPage(1_000_000);
    expect(page.limit).toBe(page.total);
    expect(page.hasMore).toBe(false);
  });
});

describe("the Follow-ups lists count the whole set", () => {
  it("reports the true draft total beside a capped window", async () => {
    const first = await listFollowUpDraftsPage();
    expect(first.total).toBeGreaterThanOrEqual(FOLLOW_UP_ROWS);
    expect(first.limit).toBe(FOLLOW_UP_DRAFT_PAGE_SIZE);
    expect(first.rows).toHaveLength(FOLLOW_UP_DRAFT_PAGE_SIZE);
    expect(first.hasMore).toBe(true);
  });

  it("reaches the last draft when the window is raised", async () => {
    const full = await listFollowUpDraftsPage(FOLLOW_UP_DRAFT_PAGE_SIZE * 100);
    expect(full.hasMore).toBe(false);
    const ids = new Set(full.rows.map((row) => row.id));
    for (const id of draftIds) expect(ids.has(id)).toBe(true);
  });

  it("counts the overview in SQL, so a capped list cannot shrink the figure", async () => {
    const overview = await getFollowUpOverview();
    // 112 of the drafts seeded here alone are ready; a count over the loaded 100-row window would
    // come back short, which is exactly what this asserts against.
    expect(overview.readyDrafts).toBeGreaterThanOrEqual(FOLLOW_UP_ROWS);
    expect(overview.readyDrafts).toBeGreaterThan(FOLLOW_UP_DRAFT_PAGE_SIZE);
  });
});