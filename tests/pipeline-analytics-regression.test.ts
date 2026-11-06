import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/db/client";
import { createEmailAccount } from "@/lib/email/accounts";
import { hashPassword } from "@/lib/auth/password";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { getPipelineBoard, getPipelineCards, listMarkets } from "@/lib/services/pipeline";
import { getPipelineAnalytics } from "@/lib/services/pipeline-analytics";
import type { Category } from "@/lib/types";

const PREFIX = "pipeline-regression";
const POP = `${PREFIX}-eligibility`;
const GROUP = `${PREFIX}-groups`;
const BOUNCE = `${PREFIX}-bounces`;
const LARGE = `${PREFIX}-large`;
const ids: string[] = [];
const messageIds: string[] = [];
const accountIds: string[] = [];
const leadIds: Record<string, string> = {};
let userId = "";
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

type Seed = {
  qualification?: "candidate" | "rejected" | "verified";
  country?: string;
  categories?: Category[];
  status?: string;
  account?: string | null;
  agent?: string;
  archived?: boolean;
};

async function lead(key: string, options: Seed = {}) {
  const db = await getDb();
  const id = crypto.randomUUID();
  ids.push(id);
  leadIds[key] = id;
  await db.query(
    `INSERT INTO prospects (id, business_name, name_key, qualification_status, status, created_by_type,
       country, categories, sending_profile_id, source_agent, archived_at)
     VALUES ($1, $2, $2, $3, $4, 'founder', $5, $6::jsonb, $7, $8, $9)`,
    [id, `${PREFIX}-${key}`, options.qualification ?? "verified", options.status ?? "new", options.country ?? POP,
      JSON.stringify(options.categories ?? ["forex"]), options.account === undefined ? accountIds[0] : options.account,
      options.agent ?? "claude", options.archived ? ago(1) : null],
  );
  return id;
}

async function conversation(id: string, lastMessageAt = ago(0)) {
  const db = await getDb();
  const result = await db.query<{ id: string }>(
    `INSERT INTO conversations (id, prospect_id, subject, last_message_at)
     VALUES (gen_random_uuid(), $1, 'Imported', $2) RETURNING id`, [id, lastMessageAt],
  );
  return result.rows[0]!.id;
}

async function message(id: string | null, conv: string | null, direction: "inbound" | "outbound", at: string) {
  const db = await getDb();
  const messageId = crypto.randomUUID();
  messageIds.push(messageId);
  await db.query(
    `INSERT INTO messages (id, prospect_id, conversation_id, direction, source, from_email, sent_at, received_at, created_at)
     VALUES ($1, $2, $3, $4, 'imap', 'import@example.test', $5, $6, $7)`,
    [messageId, id, conv, direction, direction === "outbound" ? at : null, direction === "inbound" ? at : null, at],
  );
  return messageId;
}

async function send(id: string, account: string, at: string, status = "accepted") {
  const db = await getDb();
  const email = `${id}@pipeline-regression.example.test`;
  await db.query(
    `INSERT INTO outbound_sends (id, kind, prospect_id, account_id, recipient_email, idempotency_key, status, started_at, completed_at)
     VALUES (gen_random_uuid(), 'reply', $1, $2, $3, $4, $5, $6, $6)`,
    [id, account, email, crypto.randomUUID(), status, at],
  );
}

async function bounce(id: string, account: string, at: string, reportId: string | null = null) {
  const db = await getDb();
  await db.query(
    `INSERT INTO email_bounces (account_id, normalized_email, kind, diagnostic, action, created_at, message_id)
     VALUES ($1, $2, 'permanent', $3, 'suppressed', $4, $5)`,
    [account, `${id}@pipeline-regression.example.test`, PREFIX, at, reportId],
  );
}

beforeAll(async () => {
  const db = await getDb();
  await ensureWorkspaceDefaults();
  userId = crypto.randomUUID();
  await db.query(
    `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
     VALUES ($1, $2, $2, 'Pipeline regression', $3, 'founder')`,
    [userId, `${PREFIX}@example.test`, hashPassword(crypto.randomUUID())],
  );
  for (const suffix of ["a", "b"]) {
    accountIds.push((await createEmailAccount({ provider: "sandbox", emailAddress: `${PREFIX}-${suffix}@example.test`,
      name: `${PREFIX}-${suffix}`, fromName: "Regression", dailySendLimit: 20, minIntervalSeconds: 60 }, userId)).id);
  }

  const imported = await lead("candidate-import", { qualification: "candidate", categories: ["forex", "metals"] });
  const old = await conversation(imported, ago(5));
  await message(imported, old, "outbound", ago(0.1));
  await message(null, old, "inbound", ago(0.05)); // owner only on the conversation; cached times are null
  // Conversation caches deliberately stay null: imported message history is authoritative.
  const rejected = await lead("rejected-inbound", { qualification: "rejected", categories: ["crypto"] });
  const rejectedConv = await conversation(rejected);
  await message(rejected, rejectedConv, "inbound", ago(0.03));
  const empty = await lead("candidate-empty-thread", { qualification: "candidate" });
  await conversation(empty);
  await lead("candidate-never", { qualification: "candidate" });
  await lead("rejected-never", { qualification: "rejected" });
  await lead("verified-never", { categories: ["metals"] });
  const archived = await lead("archived-thread", { qualification: "candidate", archived: true });
  const archivedConv = await conversation(archived);
  await message(archived, archivedConv, "outbound", ago(1));
  const messageOnly = await lead("candidate-message-only", { qualification: "candidate" });
  await message(messageOnly, null, "outbound", ago(0.01));
  const sentDraftOnly = await lead("rejected-sent-draft", { qualification: "rejected" });
  await db.query(
    `INSERT INTO drafts (id, prospect_id, kind, status, subject, body, recipient_email, created_by_type, sent_at)
     VALUES (gen_random_uuid(), $1, 'first_contact', 'sent', 'Imported', 'B', 'draft@example.test', 'founder', $2)`,
    [sentDraftOnly, ago(2)],
  );

  const multi = await lead("multi-market", { country: GROUP, categories: ["forex", "metals"] });
  const multiConv = await conversation(multi);
  await message(multi, multiConv, "outbound", ago(0.02));
  await message(multi, multiConv, "inbound", ago(0.01));
  const cryptoLead = await lead("crypto", { country: GROUP, categories: ["crypto"] });
  await message(cryptoLead, null, "outbound", ago(0.01));
  const unsolicited = await lead("unsolicited", { country: GROUP, categories: ["forex"] });
  await message(unsolicited, null, "inbound", ago(0.01));

  const unknown = await lead("no-draft", { country: `${PREFIX}-no-draft`, categories: ["indices"] });
  const unknownConv = await conversation(unknown);
  await message(unknown, unknownConv, "outbound", ago(100));
  await message(unknown, unknownConv, "outbound", ago(99));
  await message(unknown, unknownConv, "inbound", ago(98));
  await message(unknown, unknownConv, "outbound", ago(97));

  for (const [key, opts] of Object.entries({
    "bounce-target": {},
    "bounce-crypto": { categories: ["crypto"] as Category[] },
    "bounce-other-agent": { agent: "chatgpt" },
    "bounce-other-mailbox": { account: accountIds[1] },
    "bounce-other-country": { country: `${BOUNCE}-outside` },
  })) {
    const options = { country: BOUNCE, ...opts };
    const id = await lead(key, options);
    const account = options.account ?? accountIds[0]!;
    await message(id, null, "outbound", ago(10));
    await send(id, account, ago(10));
    await bounce(id, account, ago(9.5));
    if (key === "bounce-target") {
      await send(id, account, ago(9));
      await send(id, account, ago(7)); // same recipient, third accepted send did not bounce
      await send(id, account, ago(6), "sandbox");
      await send(id, account, ago(6), "failed");
      const report = await message(id, null, "inbound", ago(8));
      await bounce(id, account, ago(8), report);
      await bounce(id, account, ago(8)); // duplicates must not inflate the numerator
      await bounce(id, account, ago(8));
      await bounce(id, account, ago(11)); // report predates every send; must not match
    }
  }
  const unassigned = await lead("no-profile", { country: BOUNCE, account: null });
  await message(unassigned, null, "outbound", ago(10));

  // A full column beyond the old 500 display cap. Three imported no-draft messages per lead:
  // first outreach, inbound, founder reply. All are old, so selected-week totals must stay zero.
  const bulk = await db.query<{ id: string }>(
    `INSERT INTO prospects (id, business_name, name_key, qualification_status, status, country, categories,
       created_by_type, sending_profile_id, source_agent)
     SELECT gen_random_uuid(), $1 || n, $1 || n, 'verified', 'replied', $2, '["commodities"]'::jsonb,
       'founder', $3::uuid, 'claude' FROM generate_series(1, 507) n RETURNING id`,
    [`${PREFIX}-bulk-`, LARGE, accountIds[0]],
  );
  ids.push(...bulk.rows.map((row) => row.id));
  const bulkIds = bulk.rows.map((row) => row.id);
  await db.query(
    `INSERT INTO conversations (id, prospect_id, subject)
     SELECT gen_random_uuid(), id, 'Legacy' FROM prospects WHERE id = ANY($1::uuid[])`, [bulkIds],
  );
  await db.query(
    `INSERT INTO messages (id, prospect_id, conversation_id, direction, source, from_email, sent_at, received_at, created_at)
     SELECT gen_random_uuid(), c.prospect_id, c.id, activity.direction, 'imap', 'bulk@example.test',
       CASE WHEN activity.direction = 'outbound' THEN activity.at END,
       CASE WHEN activity.direction = 'inbound' THEN activity.at END, activity.at
       FROM conversations c CROSS JOIN (VALUES ('outbound', $2::timestamptz),
         ('inbound', $3::timestamptz), ('outbound', $4::timestamptz)) activity(direction, at)
      WHERE c.prospect_id = ANY($1::uuid[])`, [bulkIds, ago(100), ago(99), ago(98)],
  );
}, 45_000);

afterAll(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM audit_log WHERE actor_id = $1 OR (entity_type = 'prospect' AND entity_id = ANY($2::text[]))`, [userId, ids]);
  await db.query(`DELETE FROM email_bounces WHERE diagnostic = $1`, [PREFIX]);
  await db.query(`DELETE FROM outbound_sends WHERE prospect_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM messages WHERE id = ANY($1::uuid[]) OR prospect_id = ANY($2::uuid[])`, [messageIds, ids]);
  await db.query(`DELETE FROM conversations WHERE prospect_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM drafts WHERE prospect_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM prospects WHERE id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM email_accounts WHERE id = ANY($1::uuid[])`, [accountIds]);
  await db.query(`DELETE FROM api_keys WHERE created_by = $1`, [userId]);
  await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await closeDb();
});

describe("approved pipeline population and markets", () => {
  it("includes conversations/messages/sent drafts regardless of qualification; excludes uncontacted unverified and archived", async () => {
    const cards = await getPipelineCards({ country: POP });
    expect(cards.map((card) => card.prospectId).sort()).toEqual([
      "candidate-import", "rejected-inbound", "candidate-empty-thread", "verified-never", "candidate-message-only", "rejected-sent-draft",
    ].map((key) => leadIds[key]).sort());
    const byId = new Map(cards.map((card) => [card.prospectId, card]));
    expect(byId.get(leadIds["candidate-import"]!)).toMatchObject({
      column: "engaged", contacted: true, categories: ["forex", "metals"], country: POP,
      statusLine: "They replied and are waiting for your answer",
    });
    expect(byId.get(leadIds["candidate-import"]!)!.replyWaitingSince).not.toBeNull();
    expect(byId.get(leadIds["candidate-message-only"]!)).toMatchObject({ column: "outreach", contacted: true });
    expect(byId.get(leadIds["rejected-inbound"]!)).toMatchObject({ column: "engaged", contacted: false });
    expect(byId.get(leadIds["verified-never"]!)).toMatchObject({ column: "research", contacted: false });
    expect(byId.get(leadIds["rejected-sent-draft"]!)!.contacted).toBe(true);
  });

  it("lists canonical categories and filters categories separately from country", async () => {
    expect(await listMarkets()).toEqual(["forex", "metals", "crypto", "indices", "commodities"]);
    const board = await getPipelineBoard({ country: POP, market: "metals" });
    expect(board.total).toBe(2);
    expect(board.columns.flatMap((col) => col.cards).map((card) => card.prospectId).sort()).toEqual([
      leadIds["candidate-import"], leadIds["verified-never"],
    ].sort());
    expect((await getPipelineBoard({ market: POP })).total).toBe(0); // country text is never a market
    expect((await getPipelineBoard({ country: POP, market: "crypto" })).total).toBe(1);
  });

  it("counts multi-market contacted leads in each category, with countries separate", async () => {
    const data = await getPipelineAnalytics({ country: GROUP });
    expect(data.rates.market).toEqual([
      { key: "crypto", contacted: 1, replied: 0, demoPlus: 0 },
      { key: "forex", contacted: 1, replied: 1, demoPlus: 0 },
      { key: "metals", contacted: 1, replied: 1, demoPlus: 0 },
    ]);
    expect(data.rates.country).toEqual([{ key: GROUP, contacted: 2, replied: 1, demoPlus: 0 }]);
    const filtered = await getPipelineAnalytics({ country: GROUP, market: "metals" });
    expect(filtered.funnel[0]!.count).toBe(1);
    expect(filtered.rates.market.map((row) => row.key)).toEqual(["forex", "metals"]);
  });
});

describe("uncapped pipeline analytics and explicit time scopes", () => {
  it("loads beyond 500 without losing totals or leaving Load more stuck", async () => {
    const first = await getPipelineBoard({ country: LARGE });
    const prefix = await getPipelineBoard({ country: LARGE, limits: { engaged: 500 } });
    const last = await getPipelineBoard({ country: LARGE, limits: { engaged: 512 } });
    expect(first.total).toBe(507);
    expect(first.columns.find((col) => col.key === "engaged")).toMatchObject({ count: 507, hasMore: true });
    expect(first.columns.find((col) => col.key === "engaged")!.cards).toHaveLength(12);
    const window = prefix.columns.find((col) => col.key === "engaged")!;
    const full = last.columns.find((col) => col.key === "engaged")!;
    expect(window.cards).toHaveLength(500);
    expect(window.hasMore).toBe(true);
    expect(full.cards).toHaveLength(507);
    expect(full.hasMore).toBe(false);
    expect(full.cards.slice(0, 500).map((card) => card.prospectId)).toEqual(window.cards.map((card) => card.prospectId));
    expect(new Set(full.cards.map((card) => card.prospectId)).size).toBe(507);
  });

  it("aggregates the complete 507-lead history, not a board prefix or selected-week subset", async () => {
    const data = await getPipelineAnalytics({ country: LARGE, weeks: 1 });
    expect(data.funnel.slice(0, 3).map((row) => row.count)).toEqual([507, 507, 507]);
    expect(data.rates.market).toEqual([{ key: "commodities", contacted: 507, replied: 507, demoPlus: 0 }]);
    expect(data.bySequence).toEqual([{ label: "First email", sent: 507, repliedAfter: 507, rate: 1 }]);
    expect(data.replySpeed).toMatchObject({ answered: 507, medianHours: 24, waitingNow: 0 });
    expect(data.stale.count).toBe(507);
    expect(data.stale.rows).toHaveLength(20); // preview only; count is whole population
    expect(data.weeks).toHaveLength(1);
    expect(data.weeks[0]).toMatchObject({ firstEmails: 0, followUps: 0, replies: 0, yourReplies: 0, unknownOutbound: 0 });
    expect(data.scope.weekly).toMatchObject({ timezone: "UTC", label: expect.stringContaining("Selected weeks only") });
    expect(data.scope.history.label).toContain("not limited to selected weeks");
    expect(data.scope.snapshot.label).toContain("not historical stage conversion");
  });

  it("classifies an imported no-draft first send by chronology, not as Your reply", async () => {
    const data = await getPipelineAnalytics({ country: `${PREFIX}-no-draft`, weeks: 26 });
    expect(data.bySequence).toEqual([
      { label: "First email", sent: 1, repliedAfter: 0, rate: 0 },
      { label: "Unknown outbound", sent: 1, repliedAfter: 1, rate: 1 },
    ]);
    expect(data.weeks.reduce((sum, row) => sum + row.firstEmails, 0)).toBe(1);
    expect(data.weeks.reduce((sum, row) => sum + row.unknownOutbound, 0)).toBe(1);
    expect(data.weeks.reduce((sum, row) => sum + row.yourReplies, 0)).toBe(1);
    expect(data.replySpeed.answered).toBe(1);
  });

  it("does not invent historical conversions from unrelated current statuses", async () => {
    const db = await getDb();
    const id = await lead("snapshot-won-uncontacted", { country: `${PREFIX}-snapshot`, status: "won" });
    const data = await getPipelineAnalytics({ country: `${PREFIX}-snapshot` });
    expect(data.funnel.map((step) => [step.key, step.count])).toEqual([
      ["verified", 1], ["contacted", 0], ["replied", 0], ["demo", 1], ["commercial", 1], ["won", 1],
    ]);
    expect(data.funnel.filter(step => ["demo", "commercial", "won"].includes(step.key)).every(step => step.conversion === null)).toBe(true);
    expect(data.funnel.find(step => step.key === "contacted")!.conversion).toBe(0); // observed contact coverage, not a guessed sales transition
    expect(data.funnel.find((step) => step.key === "won")!.label).toContain("snapshot");
    expect(data.rates.market).toEqual([]); // no sent denominator to borrow from another stage
    expect((await db.query(`SELECT id FROM prospects WHERE id = $1`, [id])).rows).toHaveLength(1);
  });
});

describe("filtered distinct-send bounce rates", () => {
  it("uses the identical market, country, sender and agent population for numerator and denominator", async () => {
    const data = await getPipelineAnalytics({ country: BOUNCE, market: "forex", sender: accountIds[0], agent: "claude" });
    expect(data.funnel[0]!.count).toBe(1);
    expect(data.bounces).toEqual([{ accountId: accountIds[0], sends: 3, permanentBounces: 2, rate: 2 / 3 }]);
    expect(data.scope.bounceAttribution).toContain("attribution is inferred");
    const cards = await getPipelineCards({ country: BOUNCE, market: "forex", sender: accountIds[0], agent: "claude" });
    expect(cards[0]!.replyWaitingSince).toBeNull(); // a DSN is not a prospect reply
    expect(data.bySequence.every((row) => row.repliedAfter === 0)).toBe(true);
  });

  it("changes every bounce dimension consistently and gives sender none no unrelated mailbox data", async () => {
    for (const filters of [
      { country: BOUNCE, market: "crypto", sender: accountIds[0], agent: "claude" },
      { country: BOUNCE, market: "forex", sender: accountIds[0], agent: "chatgpt" },
      { country: BOUNCE, market: "forex", sender: accountIds[1], agent: "claude" },
      { country: `${BOUNCE}-outside`, market: "forex", sender: accountIds[0], agent: "claude" },
    ]) {
      const data = await getPipelineAnalytics(filters);
      expect(data.bounces).toEqual([{ accountId: filters.sender, sends: 1, permanentBounces: 1, rate: 1 }]);
    }
    expect((await getPipelineAnalytics({ country: BOUNCE, sender: "none" })).bounces).toEqual([]);
    expect((await getPipelineAnalytics({ country: `${PREFIX}-missing` })).bounces).toEqual([]);
  });
});
