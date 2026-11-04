import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { runAgentAction } from "@/lib/agent/service";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * Replacing a draft must never destroy text. The version history is draft_revisions: the version
 * created with the draft, and every version written over it, with the current row holding the
 * newest. Before this, the created version was missing from that history, so a second save by an
 * assistant left the original text nowhere at all.
 */

const KEY = {
  id: "oauth:nq_drafthistory",
  name: "Claude",
  assistant: "custom" as const,
  scopes: ["research:read", "research:write", "drafts:write", "product_truth:read", "progress:read"],
};

const FIRST = "Hi team, the first version of this draft, written before anyone replaced it.";
const SECOND = "Hi team, the second version, which replaces the first one entirely.";
const CONCURRENT_A = "Concurrent writer A: the text this call tried to save for the prospect.";
const CONCURRENT_B = "Concurrent writer B: a different text, from a call racing the first one.";

async function leadWithProspect(name: string, domain: string) {
  const saved = await runAgentAction(KEY as never, "save_prospect", {
    businessName: name,
    websiteUrl: `https://${domain}`,
    categories: ["forex"],
    signalDescription: `${name} sells paid trading signal subscriptions to retail traders.`,
    email: `contact@${domain}`,
    emailSourceType: "official_website",
    emailSourceUrl: `https://${domain}/contact`,
    qualificationStatus: "verified",
    sources: [{ url: `https://${domain}/pricing`, label: "Official pricing page" }],
  });
  return (saved.data as { prospect: { id: string } }).prospect.id;
}

async function draftsFor(prospectId: string) {
  const db = await getDb();
  const rows = await db.query<{ id: string; body: string }>(
    `SELECT id, body FROM drafts WHERE prospect_id = $1 AND kind = 'first_contact'`,
    [prospectId],
  );
  const revisions = await db.query<{ body: string }>(
    `SELECT r.body FROM draft_revisions r
      JOIN drafts d ON d.id = r.draft_id
     WHERE d.prospect_id = $1 ORDER BY r.created_at`,
    [prospectId],
  );
  return { rows: rows.rows, history: revisions.rows.map((row) => row.body) };
}

afterAll(async () => {
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

beforeAll(async () => {
  await ensureWorkspaceDefaults();
});

describe("a later save replaces an unedited draft, and nothing is lost", () => {
  it("keeps both texts across two sequential saves, with one row", async () => {
    const prospectId = await leadWithProspect("Draft History Co", "draft-history.example");

    const first = await runAgentAction(KEY as never, "save_draft", {
      prospectId,
      subject: "First contact",
      body: FIRST,
    });
    expect((first.data as { preservedExisting: boolean }).preservedExisting).toBe(false);

    const second = await runAgentAction(KEY as never, "save_draft", {
      prospectId,
      subject: "First contact, revised",
      body: SECOND,
    });
    expect((second.data as { preservedExisting: boolean }).preservedExisting).toBe(false);

    const { rows, history } = await draftsFor(prospectId);

    // One draft, holding the newest text...
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe(SECOND);
    // ...and the text it replaced still retrievable.
    expect(history).toContain(FIRST);
    expect(history).toContain(SECOND);
    expect(history).toHaveLength(2);
  });

  it("keeps one row and loses no written text when two saves race", async () => {
    const prospectId = await leadWithProspect("Concurrent Draft Co", "concurrent-draft.example");

    const [a, b] = await Promise.all([
      runAgentAction(KEY as never, "save_draft", { prospectId, subject: "Race A", body: CONCURRENT_A }),
      runAgentAction(KEY as never, "save_draft", { prospectId, subject: "Race B", body: CONCURRENT_B }),
    ]);

    const results = [a, b].map((r) => r.data as { saved: boolean; preservedExisting: boolean; draft: { id: string } });
    const { rows, history } = await draftsFor(prospectId);

    // Exactly one row, and both callers were told what happened to theirs.
    expect(rows).toHaveLength(1);
    expect(results.filter((r) => r.preservedExisting === false)).toHaveLength(1);
    expect(results.filter((r) => r.preservedExisting === true)).toHaveLength(1);
    expect(new Set(results.map((r) => r.draft.id)).size).toBe(1);

    // The winner's text is the row, and is in the history; the loser was told it was preserved
    // rather than having its text silently dropped.
    const winner = results.find((r) => r.preservedExisting === false)!;
    expect(history).toContain(rows[0].body);
    expect(rows[0].body).toBe(winner === results[0] ? CONCURRENT_A : CONCURRENT_B);
    expect(history.some((text) => text === rows[0].body)).toBe(true);
  });

  it("still refuses to touch a founder-edited draft", async () => {
    const prospectId = await leadWithProspect("Edited Draft Co", "edited-draft.example");
    await runAgentAction(KEY as never, "save_draft", { prospectId, subject: "Original", body: FIRST });

    const db = await getDb();
    await db.query(
      `UPDATE drafts SET founder_edited = true, body = 'Founder rewrote this one.'
        WHERE prospect_id = $1`,
      [prospectId],
    );

    const second = await runAgentAction(KEY as never, "save_draft", {
      prospectId,
      subject: "Trying to replace",
      body: SECOND,
    });

    expect((second.data as { preservedExisting: boolean }).preservedExisting).toBe(true);
    const { rows } = await draftsFor(prospectId);
    expect(rows[0].body).toBe("Founder rewrote this one.");
  });
});