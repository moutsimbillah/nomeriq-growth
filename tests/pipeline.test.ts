import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { closeDb, getDb } from "@/lib/db/client";
import { createEmailAccount } from "@/lib/email/accounts";
import { hashPassword } from "@/lib/auth/password";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { audienceLabel, audienceValue, columnFor, getPipelineBoard, PIPELINE_COLUMNS } from "@/lib/services/pipeline";
import { getPipelineAnalytics, weekStart } from "@/lib/services/pipeline-analytics";
import { setLeadStage } from "@/lib/services/stage";

/**
 * Email item 5 — the pipeline board and analytics over real rows. Every verified lead is in exactly
 * one of eight columns, worked out from recorded facts; cards say why; analytics count only recorded
 * events (which email a reply followed, bounces per mailbox, stale leads).
 */

const COUNTRY = "Testland-pipeline";
const ids: string[] = [];
const byKey: Record<string, string> = {};
let userId = "";
let accountId = "";
const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

type Msg = { dir: "out" | "in"; days: number; kind?: "first_contact" | "follow_up"; seq?: number };

async function lead(key: string, status: string, msgs: Msg[] = [], extra: { suppression?: string; nextAction?: string } = {}) {
  const db = await getDb();
  const id = crypto.randomUUID();
  ids.push(id);
  byKey[key] = id;
  const email = `${key}@pipeline.example.test`;
  await db.query(
    `INSERT INTO prospects (id, business_name, name_key, domain_key, status, qualification_status, created_by_type,
       country, follower_count, sending_profile_id, next_action)
     VALUES ($1, $2, $3, $4, $5, 'verified', 'founder', $6, $7, $8, $9)`,
    [id, `Pipe ${key}`, `pipe-test-${key}`, `${key}.pipeline.example.test`, status, COUNTRY, "12.5K", accountId, extra.nextAction ?? null],
  );
  await db.query(
    `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type, is_primary)
     VALUES (gen_random_uuid(), $1, $2, $2, 'https://pipeline.example.test', 'official_website', true)`,
    [id, email],
  );
  if (extra.suppression) {
    await db.query(`INSERT INTO suppressions (id, normalized_email, email, reason, prospect_id) VALUES (gen_random_uuid(), $1, $1, $2, $3)`, [email, extra.suppression, id]);
  }
  if (!msgs.length) return id;
  const conversation = crypto.randomUUID();
  const outs = msgs.filter((m) => m.dir === "out").map((m) => m.days);
  const ins = msgs.filter((m) => m.dir === "in").map((m) => m.days);
  await db.query(
    `INSERT INTO conversations (id, prospect_id, subject, last_message_at, last_inbound_at, last_outbound_at, unread_count)
     VALUES ($1, $2, 'S', $3, $4, $5, 0)`,
    [conversation, id, days(Math.min(...msgs.map((m) => m.days))), ins.length ? days(Math.min(...ins)) : null, outs.length ? days(Math.min(...outs)) : null],
  );
  for (const msg of msgs) {
    let draftId: string | null = null;
    if (msg.dir === "out" && msg.kind) {
      draftId = crypto.randomUUID();
      await db.query(
        `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email, ai_generated, created_by_type, sent_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'sent', 'S', 'B', $5, false, 'founder', $6, $6, $6)`,
        [draftId, id, msg.kind, msg.seq ?? 0, email, days(msg.days)],
      );
      await db.query(
        `INSERT INTO outbound_sends (id, draft_id, kind, recipient_email, subject, account_id, prospect_id, idempotency_key, status, started_at, completed_at)
         VALUES (gen_random_uuid(), $1, 'draft', $2, 'S', $3, $4, $5, 'accepted', $6, $6)`,
        [draftId, email, accountId, id, `pipe-test-${draftId}`, days(msg.days)],
      );
    }
    if (msg.dir === "out") {
      await db.query(
        `INSERT INTO messages (id, conversation_id, prospect_id, direction, source, from_email, subject, body_text, snippet, sent_at, draft_id, delivery_status)
         VALUES (gen_random_uuid(), $1, $2, 'outbound', 'system', 'me@example.test', 'S', 'B', 'B', $3, $4, 'accepted')`,
        [conversation, id, days(msg.days), draftId],
      );
    } else {
      await db.query(
        `INSERT INTO messages (id, conversation_id, prospect_id, direction, source, from_email, subject, body_text, snippet, received_at)
         VALUES (gen_random_uuid(), $1, $2, 'inbound', 'seed', $3, 'Re: S', 'Hi', 'Hi', $4)`,
        [conversation, id, email, days(msg.days)],
      );
    }
  }
  return id;
}

beforeAll(async () => {
  const db = await getDb();
  await ensureWorkspaceDefaults();
  userId = crypto.randomUUID();
  await db.query(
    `INSERT INTO users (id, email, normalized_email, name, password_hash, role) VALUES ($1, $2, $2, 'Pipeline', $3, 'founder')`,
    [userId, "pipeline-test@test.nomeriq.com", hashPassword(crypto.randomUUID())],
  );
  accountId = (await createEmailAccount(
    { provider: "sandbox", emailAddress: "pipeline-test@nomeriq-mail.example.test", fromName: "Pipe", name: "Pipeline test", dailySendLimit: 20, minIntervalSeconds: 60 },
    userId,
  )).id;

  await lead("research", "verified");
  await lead("outreach", "contacted", [{ dir: "out", days: 1, kind: "first_contact" }]);
  await lead("followup", "contacted", [{ dir: "out", days: 9, kind: "first_contact" }, { dir: "out", days: 2, kind: "follow_up", seq: 1 }]);
  await lead("engaged", "replied", [
    { dir: "out", days: 12, kind: "first_contact" },
    { dir: "out", days: 6, kind: "follow_up", seq: 1 },
    { dir: "in", days: 3 },
  ]);
  await lead("demo", "demo", [{ dir: "out", days: 8, kind: "first_contact" }, { dir: "in", days: 7 }]);
  await lead("commercial", "proposal", [{ dir: "out", days: 8, kind: "first_contact" }, { dir: "in", days: 7 }], { nextAction: "Send proposal" });
  await lead("won", "won");
  await lead("lost", "lost");
  await lead("optout", "contacted", [{ dir: "out", days: 5, kind: "first_contact" }, { dir: "in", days: 4 }], { suppression: "unsubscribe" });
  await lead("bounce", "contacted", [{ dir: "out", days: 5, kind: "first_contact" }], { suppression: "bounce" });
  await lead("stale", "replied", [{ dir: "out", days: 30, kind: "first_contact" }, { dir: "in", days: 25 }, { dir: "out", days: 20 }]);
  await db.query(
    `INSERT INTO email_bounces (account_id, normalized_email, kind, diagnostic, action) VALUES ($1, 'bounce@pipeline.example.test', 'permanent', 'pipeline-test', 'suppressed')`,
    [accountId],
  );
});

afterAll(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM audit_log WHERE entity_type = 'prospect' AND entity_id = ANY($1::text[])`, [ids]);
  await db.query(`DELETE FROM email_bounces WHERE diagnostic = 'pipeline-test'`);
  await db.query(`DELETE FROM outbound_sends WHERE prospect_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM messages WHERE prospect_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM conversations WHERE prospect_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM drafts WHERE prospect_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM suppressions WHERE prospect_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM prospect_emails WHERE prospect_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM prospects WHERE id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM email_accounts WHERE id = $1`, [accountId]);
  await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await closeDb();
});

describe("pipeline columns", () => {
  it("has the plan's eight columns, the last four set by the founder", () => {
    expect(PIPELINE_COLUMNS.map((c) => c.label)).toEqual(["Research", "Outreach", "Follow-up", "Engaged", "Demo", "Commercial", "Won", "Closed"]);
    expect(PIPELINE_COLUMNS.filter((c) => c.stage).map((c) => c.stage)).toEqual(["demo", "proposal", "won", "lost"]);
  });

  it("closes on opt-out or bounce before anything else, then honours the founder's stages", () => {
    expect(columnFor({ status: "won", suppressionReason: "unsubscribe" })).toBe("closed");
    expect(columnFor({ status: "contacted", suppressionReason: "bounce" })).toBe("closed");
    expect(columnFor({ status: "contacted", suppressionReason: "manual", hasOutbound: true })).toBe("outreach");
    expect(columnFor({ status: "proposal", hasReplied: true })).toBe("commercial");
    expect(columnFor({ status: "contacted", hasReplied: true, sentFollowUps: 1 })).toBe("engaged");
    expect(columnFor({ status: "contacted", hasOutbound: true, followUpDue: true })).toBe("follow_up");
    expect(columnFor({ status: "draft_prepared" })).toBe("research");
  });

  it("reads audience counts written by people", () => {
    expect(audienceValue("12.5K")).toBe(12_500);
    expect(audienceValue("1,200 members")).toBe(1_200);
    expect(audienceValue("3M+")).toBe(3_000_000);
    expect(audienceValue("45 000")).toBe(45_000);
    expect(audienceValue("1.2m subscribers")).toBe(1_200_000);
    expect(audienceValue("unknown")).toBeNull();
    expect(audienceLabel(12_500)).toBe("12.5K");
    expect(audienceLabel(64_000)).toBe("64K");
  });
});

describe("the board over real rows", () => {
  it("puts each lead in one column with counts over all of them", async () => {
    const board = await getPipelineBoard({ country: COUNTRY });
    const where = Object.fromEntries(board.columns.flatMap((c) => c.cards.map((card) => [card.businessName.replace("Pipe ", ""), c.key])));
    expect(where).toMatchObject({
      research: "research", outreach: "outreach", followup: "follow_up", engaged: "engaged", demo: "demo",
      commercial: "commercial", won: "won", lost: "closed", optout: "closed", bounce: "closed", stale: "engaged",
    });
    expect(board.total).toBe(11);
    expect(board.columns.reduce((n, c) => n + c.count, 0)).toBe(11);
  });

  it("says why on each card", async () => {
    const board = await getPipelineBoard({ country: COUNTRY });
    const card = (name: string) => board.columns.flatMap((c) => c.cards).find((c) => c.businessName === `Pipe ${name}`)!;
    expect(card("engaged").statusLine).toBe("They replied and are waiting for your answer");
    expect(card("engaged").followUpLine).toBe("Stopped: they replied after follow-up #1");
    expect(card("engaged").replyWaitingSince).not.toBeNull();
    expect(card("followup").followUpLine).toMatch(/^Follow-up #1 sent .+ · /);
    expect(card("optout").statusLine).toBe("Opted out — never contacted again");
    expect(card("optout").followUpLine).toBe("Stopped: opted out");
    expect(card("bounce").followUpLine).toBe("Stopped: bounced");
    expect(card("won").followUpLine).toBeNull();
    expect(card("research").audience).toBe("12.5K");
    expect(card("research").tier).toBeNull();
  });

  it("windows each column without changing its count", async () => {
    const board = await getPipelineBoard({ country: COUNTRY, limits: { closed: 1 } });
    const closed = board.columns.find((c) => c.key === "closed")!;
    expect(closed.count).toBe(3);
    expect(closed.cards).toHaveLength(1);
    expect(closed.hasMore).toBe(true);
  });
});

describe("analytics", () => {
  it("attributes a first reply to the email it followed", async () => {
    const data = await getPipelineAnalytics({ country: COUNTRY });
    const row = (label: string) => data.bySequence.find((r) => r.label === label)!;
    expect(row("Follow-up #1")).toMatchObject({ sent: 2, repliedAfter: 1 });
    expect(row("First email").sent).toBe(8);
    expect(row("First email").repliedAfter).toBe(4); // demo, commercial, optout, stale
  });

  it("counts the funnel, bounces per mailbox and stale leads from recorded facts", async () => {
    const data = await getPipelineAnalytics({ country: COUNTRY });
    expect(data.funnel.map((s) => [s.key, s.count])).toEqual([
      // Contacted = a recorded send; the won and lost leads here were never emailed.
      ["verified", 11], ["contacted", 8], ["replied", 5], ["demo", 3], ["commercial", 2], ["won", 1],
    ]);
    const mailbox = data.bounces.find((b) => b.accountId === accountId)!;
    expect(mailbox).toMatchObject({ sends: 10, permanentBounces: 1 });
    expect(data.stale.rows.map((c) => c.businessName)).toEqual(["Pipe stale"]);
    expect(data.replySpeed.waitingNow).toBe(3); // engaged, demo and commercial: their message is the latest
  });

  it("starts weeks on Monday", () => {
    expect(new Date(weekStart(Date.parse("2026-11-06T12:00:00Z"))).toISOString()).toBe("2026-11-02T00:00:00.000Z");
  });

  it("measures time in a stage only from audited moves, and records where a move came from", async () => {
    const demo = byKey.demo!;
    await setLeadStage(demo, "proposal", userId, "board_drag");
    const db = await getDb();
    const audit = await db.query<{ metadata: unknown }>(`SELECT metadata FROM audit_log WHERE entity_id = $1`, [demo]);
    const metadata = audit.rows.map((r) => (typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata));
    expect(metadata).toEqual([expect.objectContaining({ from: "demo", to: "proposal", via: "board_drag" })]);
    const data = await getPipelineAnalytics({ country: COUNTRY });
    expect(data.stageTime.recordedSince).not.toBeNull();
    expect(data.stageTime.rows.every((r) => r.samples === 0)).toBe(true); // one move is not yet a duration
  });
});

describe("the pages", () => {
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
  it("moves only through the audited stage endpoint and never sends", () => {
    const client = read("src/components/pipeline-client.tsx");
    expect(client).toContain("/stage`");
    expect(client).toContain('"board_drag"');
    expect(client).toContain('"board_click"');
    expect(client).not.toMatch(/sendDraft|approve-bulk|campaigns/);
    const board = read("src/app/(app)/pipeline/page.tsx");
    expect(board).toContain("<DropColumn stage={column.stage}>");
    expect(board).toContain("Load more");
  });
});
