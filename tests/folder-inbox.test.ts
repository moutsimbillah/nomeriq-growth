import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { defaultFolder, getFolderInbox, isInboxFolder } from "@/lib/services/inbox";
import { FOLDERS } from "@/lib/services/folders";

/**
 * Email item 2 — the folder inbox service over real rows: every verified lead lands in exactly one
 * folder, counts are over all matching leads (not the loaded window), unverified candidates never
 * appear, archived leads only in Archived, and the list is newest activity first.
 */

const ids: string[] = [];
const hours = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

async function lead(spec: {
  key: string; status: string; verified?: boolean; agent?: string | null; archived?: boolean;
  out?: number; inbound?: number; draft?: boolean; suppression?: string;
}) {
  const db = await getDb();
  const id = crypto.randomUUID();
  ids.push(id);
  const email = `${spec.key}@inbox.example.test`;
  await db.query(
    `INSERT INTO prospects (id, business_name, name_key, domain_key, status, qualification_status, created_by_type, source_agent, archived_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'founder', $7, $8)`,
    [id, `Inbox ${spec.key}`, `inbox-${spec.key}`, `${spec.key}.inbox.example.test`, spec.status,
      spec.verified === false ? "candidate" : "verified", spec.agent ?? null, spec.archived ? hours(1) : null],
  );
  await db.query(
    `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type, is_primary)
     VALUES (gen_random_uuid(), $1, $2, $2, 'https://inbox.example.test', 'official_website', true)`,
    [id, email],
  );
  if (spec.suppression) {
    await db.query(`INSERT INTO suppressions (id, normalized_email, email, reason, prospect_id) VALUES (gen_random_uuid(), $1, $1, $2, $3)`, [email, spec.suppression, id]);
  }
  if (spec.draft) {
    await db.query(
      `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email, ai_generated, created_by_type, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'first_contact', 0, 'draft', 'S', 'B', $2, false, 'founder', now(), now())`,
      [id, email],
    );
  }
  if (spec.out || spec.inbound) {
    const conversation = crypto.randomUUID();
    await db.query(
      `INSERT INTO conversations (id, prospect_id, subject, last_message_at, last_inbound_at, last_outbound_at, unread_count)
       VALUES ($1, $2, 'S', $3, $4, $5, 0)`,
      [conversation, id, hours(Math.min(spec.out ?? 1e6, spec.inbound ?? 1e6)), spec.inbound ? hours(spec.inbound) : null, spec.out ? hours(spec.out) : null],
    );
    if (spec.inbound) {
      await db.query(
        `INSERT INTO messages (id, conversation_id, prospect_id, direction, source, from_email, subject, body_text, snippet, received_at)
         VALUES (gen_random_uuid(), $1, $2, 'inbound', 'seed', $3, 'Re: S', 'Their words', 'Their words', $4)`,
        [conversation, id, email, hours(spec.inbound)],
      );
    }
  }
  return id;
}

let needsOld = "";
let needsNew = "";

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  needsOld = await lead({ key: "needs-old", status: "replied", out: 50, inbound: 30, agent: "claude" });
  needsNew = await lead({ key: "needs-new", status: "replied", out: 10, inbound: 2, agent: "chatgpt" });
  await lead({ key: "approve", status: "draft_prepared", draft: true });
  await lead({ key: "waiting", status: "contacted", out: 20 });
  await lead({ key: "meeting", status: "demo", out: 5, inbound: 8 });
  await lead({ key: "won", status: "won", out: 100, inbound: 90 });
  await lead({ key: "optout", status: "contacted", out: 40, inbound: 30, suppression: "unsubscribe" });
  await lead({ key: "bounce", status: "contacted", out: 40, suppression: "bounce" });
  await lead({ key: "new", status: "new" });
  await lead({ key: "archived", status: "contacted", out: 40, archived: true });
  await lead({ key: "candidate", status: "new", verified: false });
});

afterAll(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM messages WHERE prospect_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM conversations WHERE prospect_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM drafts WHERE prospect_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM suppressions WHERE prospect_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM prospect_emails WHERE prospect_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM prospects WHERE id = ANY($1::uuid[])`, [ids]);
  await closeDb();
});

describe("the folder inbox", () => {
  it("puts every verified lead in exactly one folder, archived apart, candidates nowhere", async () => {
    const inbox = await getFolderInbox({ query: "inbox.example.test", folder: "needs_reply" });
    expect(inbox.counts).toMatchObject({
      needs_reply: 2, to_approve: 1, waiting: 1, meeting: 1, won: 1, opted_out: 1, failed: 1, new_leads: 1, archived: 1,
    });
    const placed = Object.values(inbox.counts).reduce((n, v) => n + v, 0);
    expect(placed).toBe(10); // 11 seeded, the unverified candidate is not in the email folders
    expect(Object.keys(inbox.counts).sort()).toEqual([...FOLDERS.map((f) => f.key), "archived"].sort());
  });

  it("lists the selected folder newest activity first, with the latest message line", async () => {
    const inbox = await getFolderInbox({ query: "inbox.example.test", folder: "needs_reply" });
    expect(inbox.rows.map((row) => row.prospectId)).toEqual([needsNew, needsOld]);
    expect(inbox.rows[0]!.snippet).toBe("Their words");
    expect(inbox.rows[0]!.snippetDirection).toBe("inbound");
  });

  it("counts every match, not the loaded window", async () => {
    const inbox = await getFolderInbox({ query: "inbox.example.test", folder: "needs_reply", limit: 1 });
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.total).toBe(2);
    expect(inbox.hasMore).toBe(true);
    expect(inbox.counts.needs_reply).toBe(2);
  });

  it("filters by agent and keeps the counts consistent with the filter", async () => {
    const inbox = await getFolderInbox({ query: "inbox.example.test", folder: "needs_reply", agent: "claude" });
    expect(inbox.rows.map((row) => row.prospectId)).toEqual([needsOld]);
    expect(inbox.counts.needs_reply).toBe(1);
  });

  it("opens on the first active folder with work in it, and rejects unknown folder names", () => {
    const empty = Object.fromEntries([...FOLDERS.map((f) => f.key), "archived"].map((k) => [k, 0])) as never;
    expect(defaultFolder({ ...(empty as object), waiting: 3 } as never)).toBe("waiting");
    expect(defaultFolder(empty)).toBe("needs_reply");
    expect(isInboxFolder("needs_reply")).toBe(true);
    expect(isInboxFolder("drop table")).toBe(false);
  });
});
