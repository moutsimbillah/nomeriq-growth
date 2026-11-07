import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb, closeDb, type DbClient } from "@/lib/db/client";
import { previewHistoricalBounces } from "@/lib/email/bounce-handling";
import { checkSent, checkpointComplete, importFolder, forbiddenSnapshot, runRecoveryCommand, NEEDS_REPLY_NAMES, ONWARD_MESSAGE_IDS } from "../scripts/recover-mailbox";
import type { SyncResult } from "@/lib/email/sync";

let db: DbClient;
const accountId = crypto.randomUUID(), prospectId = crypto.randomUUID(), conversationId = crypto.randomUUID(), founderId = crypto.randomUUID();
const tag = `recovery-command-${crypto.randomUUID()}`;
const ids: string[] = [];
const reader = vi.fn(async () => ({ focused: { folder: "in_conversation" } }));
function page(complete = true): SyncResult {
  return { accountId, imported: 0, skipped: 0, filled: 0, errors: [], complete, historyIncomplete: !complete,
    folders: [{ folder: "Sent Items", imported: 0, scanned: 0 }],
    progress: [{ folder: "Sent Items", uidValidity: 1, lastUid: 1, remaining: complete ? 0 : 1, complete }] };
}
async function message(time: string, direction = "outbound", body = "", name = "Sent Items", messageId = `<${crypto.randomUUID()}@example.test>`) {
  const id = crypto.randomUUID(); ids.push(id);
  await db.query(`INSERT INTO messages (id,account_id,prospect_id,conversation_id,direction,source,folder,from_email,body_text,sent_at,received_at,message_id)
    VALUES ($1,$2,$3,$4,$5,'imap',$6,'mailer-daemon@example.test',$7,$8,$8,$9)`, [id, accountId, prospectId, conversationId, direction, name, body, time, messageId]);
  return id;
}
beforeAll(async () => {
  db = await getDb();
  await db.query(`INSERT INTO users (id,email,normalized_email,name,password_hash,role) VALUES ($1,$2,$2,'Recovery command fixture',$3,'founder')`, [founderId, `${tag}-founder@example.test`, crypto.randomUUID()]);
  await db.query(`INSERT INTO email_accounts (id,name,provider,email_address,normalized_email,from_name,status,username,password_encrypted,is_default)
    VALUES ($1,$2,'smtp_imap',$3,$3,'Fixture','connected','fixture','x',false)`, [accountId, tag, `${tag}@example.test`]);
  for (const name of [...NEEDS_REPLY_NAMES, "IVI Cryptos"]) {
    const id = name === "OnwardBTC" ? prospectId : crypto.randomUUID(); ids.push(id);
    await db.query(`INSERT INTO prospects (id,business_name,name_key) VALUES ($1,$2,$3)`, [id, name, `${tag}-${name}`]);
  }
  await db.query(`INSERT INTO conversations (id,prospect_id,subject) VALUES ($1,$2,'Fixture')`, [conversationId, prospectId]);
});
afterAll(async () => {
  await db.query(`DELETE FROM suppressions WHERE normalized_email LIKE $1`, [`%${tag}%`]);
  await db.query(`DELETE FROM messages WHERE account_id = $1`, [accountId]);
  await db.query(`DELETE FROM mailbox_sync_state WHERE account_id = $1`, [accountId]);
  await db.query(`DELETE FROM conversations WHERE id = $1`, [conversationId]);
  await db.query(`DELETE FROM prospects WHERE id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM email_accounts WHERE id = $1`, [accountId]);
  await db.query(`DELETE FROM users WHERE id = $1`, [founderId]);
  await closeDb();
});

describe("real PGlite staged recovery guards", () => {
  it("failed Sent check blocks INBOX before any sync/write", async () => {
    const sync = vi.fn();
    const before = await forbiddenSnapshot(db);
    await expect(importFolder({ db, sync, getFolderInbox: reader }, accountId, "founder", "INBOX")).rejects.toThrow("sent_check_failed");
    expect(sync).not.toHaveBeenCalled();
    expect(await forbiddenSnapshot(db)).toEqual(before);
  });
  it("requires checkpoint and both verified Message-IDs in the same Onward thread, not rounded times", async () => {
    expect(await checkpointComplete(db, accountId, "Sent Items")).toBe(false);
    await db.query(`INSERT INTO mailbox_sync_state (id,account_id,folder,uidvalidity,last_uid,history_complete) VALUES ($1,$2,'backfill:Sent Items',1,1,true)`, [crypto.randomUUID(), accountId]);
    await message("2026-10-17T23:25:11Z", "outbound", "", "Sent Items", ONWARD_MESSAGE_IDS[0]);
    await message("2026-10-24T09:47:02Z", "outbound", "", "Sent Items", ONWARD_MESSAGE_IDS[1]);
    const result = await checkSent(db, accountId, reader);
    expect(result.complete).toBe(true);
    expect(result.onward.map(r => r.count)).toEqual([1, 1]);
    expect(Object.keys(result.folders)).toHaveLength(11);
    const extra = await message("2026-10-24T09:47:02Z");
    expect((await checkSent(db, accountId, reader)).onward.map(r => r.count)).toEqual([1, 1]);
    await expect(db.query(`UPDATE messages SET message_id = $2 WHERE id = $1`, [extra, ONWARD_MESSAGE_IDS[1]]))
      .rejects.toThrow('messages_account_message_unique');
    expect((await checkSent(db, accountId, reader)).complete).toBe(true);
    await db.query(`DELETE FROM messages WHERE id = $1`, [extra]);
  });
  it("rejects missing identities, wrong account, wrong lead, wrong thread and wrong direction", async () => {
    const row = (await db.query<{ id: string }>(`SELECT id FROM messages WHERE account_id=$1 AND message_id=$2`, [accountId, ONWARD_MESSAGE_IDS[0]])).rows[0];
    for (const [column, badValue, original] of [
      ["message_id", "<unrelated@example.test>", ONWARD_MESSAGE_IDS[0]],
      ["account_id", null, accountId],
      ["prospect_id", null, prospectId],
      ["conversation_id", null, conversationId],
      ["direction", "inbound", "outbound"],
      ["folder", "INBOX", "Sent Items"],
    ] as const) {
      await db.query(`UPDATE messages SET ${column}=$2 WHERE id=$1`, [row.id, badValue]);
      expect((await checkSent(db, accountId, reader)).complete, column).toBe(false);
      await db.query(`UPDATE messages SET ${column}=$2 WHERE id=$1`, [row.id, original]);
    }
    expect((await checkSent(db, accountId, reader)).complete).toBe(true);
  });
  it("stops on errors and never treats a capped run as complete", async () => {
    const failed = { ...page(), errors: ["redacted"] };
    const sync = vi.fn(async () => failed);
    const result = await importFolder({ db, sync, getFolderInbox: reader }, accountId, "founder", "Sent Items");
    expect(result.complete).toBe(false); expect(sync).toHaveBeenCalledTimes(1);
    const capped = vi.fn(async () => page(false));
    const cap = await importFolder({ db, sync: capped, getFolderInbox: reader }, accountId, "founder", "Sent Items");
    expect(cap.complete).toBe(false); expect(cap.totals.passes).toBe(60);
    expect(capped).toHaveBeenCalledTimes(60);
    expect(capped.mock.calls[0]).toEqual([accountId, { mode: "backfill", founderUserId: "founder", recoveryFolder: "Sent Items", linkCertainAddresses: false, processHistoricalBounces: false }]);
  });
  it("permits a genuine later inbound only after the Sent stage", async () => {
    const laterReply = async () => ({ focused: { folder: "needs_reply" } });
    expect((await checkSent(db, accountId, laterReply)).complete).toBe(false);
    expect((await checkSent(db, accountId, laterReply, { requireAnsweredFolders: false })).complete).toBe(true);
    const sync = vi.fn();
    await expect(importFolder({ db, sync, getFolderInbox: laterReply }, accountId, "founder", "INBOX")).rejects.toThrow("sent_check_failed");
    expect(sync).not.toHaveBeenCalled();
  });
  it("CLI wrapper returns nonzero on a page cap or error, without advancing to INBOX", async () => {
    const capped = vi.fn(async () => page(false));
    const cap = await runRecoveryCommand("sent", { db, sync: capped, getFolderInbox: reader });
    expect(cap.exitCode).toBe(1); expect(cap.report.complete).toBe(false);
    expect(capped).toHaveBeenCalledTimes(60);
    const failed = vi.fn(async () => ({ ...page(), errors: ["provider error is never printed"] }));
    const error = await runRecoveryCommand("sent", { db, sync: failed, getFolderInbox: reader });
    expect(error.exitCode).toBe(1); expect(failed).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error)).not.toContain("provider error");
  });
  it("counts new per-lead rows from IDs captured before sync", async () => {
    const sync = vi.fn(async (_account: string, options: unknown) => {
      expect(options).toMatchObject({ recoveryFolder: "Sent Items", mode: "backfill", processHistoricalBounces: false, linkCertainAddresses: false });
      await message("2026-10-25T00:00:00Z");
      return { ...page(), imported: 1, skipped: 2, filled: 3 };
    });
    const result = await importFolder({ db, sync, getFolderInbox: reader }, accountId, "founder", "Sent Items");
    expect(result.complete).toBe(true);
    expect(result.perLead).toEqual([{ lead: "OnwardBTC", imported: 1, threads: 1 }]);
    expect(result.perFolder).toEqual([{ folder: "Sent Items", imported: 1, skipped: 2, filled: 3 }]);
  });
  it("rejects forbidden import side effects", async () => {
    const sync = vi.fn(async () => {
      await db.query(`INSERT INTO suppressions (id,email,normalized_email,reason,source) VALUES ($1,$2,$2,'manual','manual')`, [crypto.randomUUID(), `${tag}-forbidden@example.test`]);
      return page();
    });
    await expect(importFolder({ db, sync, getFolderInbox: reader }, accountId, "founder", "Sent Items")).rejects.toThrow("forbidden_effects_changed");
    await db.query(`DELETE FROM suppressions WHERE normalized_email = $1`, [`${tag}-forbidden@example.test`]);
  });
  it("bounce apply refuses an incomplete preview before suppression or bounce writes", async () => {
    await db.query(`INSERT INTO mailbox_sync_state (id,account_id,folder,uidvalidity,last_uid,history_complete) VALUES ($1,$2,'backfill:INBOX',1,1,true)`, [crypto.randomUUID(), accountId]);
    const incomplete = await message("2026-10-29T00:00:00Z", "inbound", "Final-Recipient: rfc822;\nAction: failed\nStatus: 5.1.1", "INBOX");
    const before = await forbiddenSnapshot(db);
    const result = await runRecoveryCommand("bounces-apply", { db, sync: vi.fn(), getFolderInbox: reader });
    expect(result.exitCode).toBe(1);
    expect(result.report).toEqual({ complete: false, error: "bounce_preview_incomplete" });
    expect(await forbiddenSnapshot(db)).toEqual(before);
    await db.query(`DELETE FROM messages WHERE id = $1`, [incomplete]);
  });
  it("supplied READ ONLY client previews exact newly planned addresses and names only on opt-in", async () => {
    const email = `${tag}-new@example.test`, suppressed = `${tag}-old@example.test`;
    const report = (address: string) => `Final-Recipient: rfc822; ${address}\nAction: failed\nStatus: 5.1.1`;
    await message("2026-10-26T00:00:00Z", "inbound", report(email), "INBOX");
    await message("2026-10-27T00:00:00Z", "inbound", report(email), "INBOX");
    await message("2026-10-28T00:00:00Z", "inbound", report(suppressed), "INBOX");
    await db.query(`INSERT INTO suppressions (id,email,normalized_email,reason,source) VALUES ($1,$2,$2,'manual','manual')`, [crypto.randomUUID(), suppressed]);
    const before = await forbiddenSnapshot(db);
    await db.transaction(async tx => {
      await tx.query("SET TRANSACTION READ ONLY");
      const privateSummary = await previewHistoricalBounces(accountId, { suppliedDbClient: tx });
      expect(privateSummary).not.toHaveProperty("newlySuppressed");
      const explicit = await previewHistoricalBounces(accountId, { suppliedDbClient: tx, includeAddresses: true });
      expect(explicit.wouldNewlySuppress).toBe(1);
      expect(explicit.newlySuppressed).toEqual([{ address: email, leadNames: ["OnwardBTC"] }]);
    });
    expect(await forbiddenSnapshot(db)).toEqual(before);
  });
});
