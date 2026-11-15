import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { currentDbContext } from "@/lib/db/context";
import { parseScheduledReceipt, runScheduledMailboxSync } from "@/lib/email/scheduled-sync";
import { backfillSentCopies } from "@/lib/email/sync";
import { finishMailboxRun, startMailboxRun, undoMailboxRun } from "@/lib/email/sync-journal";
import { cleanupMailboxRuns } from "./helpers/mailbox-run-cleanup";
import { mockScheduledBackupFacts } from "./helpers/scheduled-backup-facts";

let restoreBackupFacts: () => void;
beforeEach(() => { restoreBackupFacts = mockScheduledBackupFacts(); });
afterEach(() => restoreBackupFacts());

const fake = vi.hoisted(() => ({ account: {} as Record<string, unknown>, folder: "", failUid: 0, fetched: [] as number[], mail: new Map<string, Map<number, string>>(), pending: [] as { id: string; messageId: string; to: string; subject: string }[], translate: vi.fn(), append: vi.fn(), saveCopy: vi.fn() }));
vi.mock("@/lib/email/accounts", () => ({ getEmailAccountRecord: async () => fake.account }));
vi.mock("@/lib/auth/crypto", () => ({ decryptSecret: () => crypto.randomUUID() }));
vi.mock("@/lib/services/message-translations", () => ({ translateOnArrival: fake.translate }));
vi.mock("@/lib/email/sent-copy", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/email/sent-copy")>(),
  listUncopiedSentMessages: async () => fake.pending,
  saveSentCopy: fake.saveCopy,
  saveSentCopyForMessage: fake.append,
}));
vi.mock("imapflow", () => ({ ImapFlow: class {
  private noDb() { if (currentDbContext()) throw new Error("synthetic IMAP used inside active DB context"); }
  async connect() { this.noDb(); } async logout() { this.noDb(); }
  async list() { this.noDb(); return [{ path: "INBOX" }, { path: "Sent Items", specialUse: "\\Sent" }]; }
  async mailboxOpen(path: string) { this.noDb(); fake.folder = path; return { uidValidity: 77, readOnly: true }; }
  async search(query: { uid?: string }) { this.noDb(); const after = query.uid ? Number(query.uid.split(":")[0]) : 0; return [...(fake.mail.get(fake.folder)?.keys() ?? [])].filter((uid) => uid >= after).sort((a, b) => b - a); }
  async *fetch(uidText: string) { this.noDb(); const uid = Number(uidText); fake.fetched.push(uid); if (fake.failUid === uid) throw new Error(`synthetic fetch failure ${uid}`); const source = fake.mail.get(fake.folder)?.get(uid); if (source) yield { uid, source: Buffer.from(source), flags: new Set(["\\Seen"]), internalDate: new Date("2026-11-14T09:00:00Z") }; }
} }));

const marker = crypto.randomUUID(); const accountId = crypto.randomUUID(); const userId = crypto.randomUUID(); const prospectId = crypto.randomUUID(); const conversationId = crypto.randomUUID(); const draftId = crypto.randomUUID(); const seedMessageId = `<scheduled-seed-${marker}@example.test>`;
function mime(uid: number) { return [`From: contact@scheduled-${marker}.example`, `To: founder@scheduled-${marker}.example`, "Subject: Re: Scheduled synthetic thread", `Message-ID: <scheduled-inbound-${marker}-${uid}@example.test>`, `In-Reply-To: ${seedMessageId}`, "Date: Fri, 14 Nov 2026 09:00:00 +0000", "", "Yes, please send the details."].join("\r\n"); }
function receipt() { const now = new Date(); return parseScheduledReceipt(JSON.stringify({ kind: "pg_dump", verified: true, path: `/var/backups/growth/deploy-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}.dump`, sizeBytes: 2048, tableDataCount: 50, verifiedAt: now.toISOString(), mode: "600" })); }
function deps() { const now = Date.now(); return { platform: "linux" as const, now: () => now, readStdin: async () => "", readFile: async () => "", lstat: async () => ({ mode: 0o100600, size: 2048, nlink: 1, uid: 1000, mtimeMs: now }), realpath: async (file: string) => file, execFile: async () => ({ stdout: Array.from({ length: 50 }, (_, i) => `x TABLE DATA ${i}`).join("\n"), stderr: "" }), initializeDb: getDb, appRoot: "/usr/local/lib/growth-mailbox-sync", currentUid: () => 1000 }; }

beforeAll(async () => { const db = await getDb();
  await db.query(`INSERT INTO users(id,email,normalized_email,name,password_hash,role) VALUES($1,$2,$2,'Scheduled fixture',$3,'founder')`, [userId, `${marker}@scheduled-user.example`, hashPassword(crypto.randomUUID())]);
  await db.query(`INSERT INTO email_accounts(id,name,provider,email_address,normalized_email,from_name,imap_host,username,password_encrypted,status,created_by) VALUES($1,'Scheduled fixture','ionos',$2,$2,'Founder','synthetic.example','','','connected',$3)`, [accountId, `founder@scheduled-${marker}.example`, userId]);
  await db.query(`INSERT INTO prospects(id,business_name,name_key,created_by_type) VALUES($1,$2,$3,'founder')`, [prospectId, `Scheduled prospect ${marker}`, `scheduled-${marker}`]);
  await db.query(`INSERT INTO prospect_emails(id,prospect_id,email,normalized_email,source_url,source_type) VALUES($1,$2,$3,$3,'https://scheduled.example','official_website')`, [crypto.randomUUID(), prospectId, `contact@scheduled-${marker}.example`]);
  await db.query(`INSERT INTO conversations(id,prospect_id,subject,status) VALUES($1,$2,'Scheduled synthetic thread','waiting')`, [conversationId, prospectId]);
  await db.query(`INSERT INTO messages(id,account_id,prospect_id,conversation_id,message_id,direction,source,from_email,to_emails,subject,body_text,sent_at,received_at,external) VALUES($1,$2,$3,$4,$5,'outbound','smtp',$6,$7::jsonb,'Scheduled synthetic thread','Initial outreach',now(),now(),false)`, [crypto.randomUUID(), accountId, prospectId, conversationId, seedMessageId, `founder@scheduled-${marker}.example`, JSON.stringify([`contact@scheduled-${marker}.example`])]);
  await db.query(`INSERT INTO drafts(id,prospect_id,kind,sequence,status,subject,body,recipient_email,created_by_type) VALUES($1,$2,'follow_up',1,'approved','Follow up','Details',$3,'founder')`, [draftId, prospectId, `contact@scheduled-${marker}.example`]);
  await db.query(`INSERT INTO workspace_settings(id) VALUES('default') ON CONFLICT (id) DO NOTHING`);
  fake.account = { id: accountId, provider: "ionos", status: "connected", emailAddress: `founder@scheduled-${marker}.example`, fromName: "Founder", imapHost: "synthetic.example", imapPort: 993, imapSecure: true, username: crypto.randomUUID(), passwordEncrypted: crypto.randomUUID() };
});
beforeEach(async () => { const db = await getDb(); await db.query(`DELETE FROM messages WHERE account_id=$1 AND uid IS NOT NULL`, [accountId]); await db.query(`DELETE FROM mailbox_sync_state WHERE account_id=$1`, [accountId]); await db.query(`UPDATE email_accounts SET last_sync_at=NULL,last_error=NULL WHERE id=$1`, [accountId]); await db.query(`UPDATE drafts SET status='approved' WHERE id=$1`, [draftId]); fake.failUid = 0; fake.fetched = []; fake.translate.mockReset(); fake.append.mockReset(); fake.translate.mockImplementation(() => { throw new Error("scheduled sync must not translate"); }); fake.append.mockImplementation(() => { throw new Error("scheduled sync must not append Sent copies"); }); fake.mail = new Map([["INBOX", new Map([[1, mime(1)], [2, mime(2)]])], ["Sent Items", new Map()]]); fake.pending = []; fake.saveCopy.mockReset(); fake.saveCopy.mockImplementation(async () => ({ saved: true, alreadyPresent: false, folder: "Sent Items", note: "saved" })); });
afterEach(async () => { await cleanupMailboxRuns(await getDb(), [accountId]); });
afterAll(async () => { const db = await getDb(); await cleanupMailboxRuns(db, [accountId]); await db.query(`DELETE FROM messages WHERE account_id=$1`, [accountId]); await db.query(`DELETE FROM drafts WHERE id=$1`, [draftId]); await db.query(`DELETE FROM conversations WHERE id=$1`, [conversationId]); await db.query(`DELETE FROM prospects WHERE id=$1`, [prospectId]); await db.query(`DELETE FROM email_accounts WHERE id=$1`, [accountId]); await db.query(`DELETE FROM users WHERE id=$1`, [userId]); });

describe("real scheduled mailbox ingestion", () => {
  it("journals sync, cancels follow-up on reply, and isolates side effects", async () => { fake.failUid = 2; await expect(runScheduledMailboxSync(receipt(), deps())).rejects.toThrow("scheduled_sync_failed"); const db = await getDb(); const run = await db.query(`SELECT id,status,error FROM mailbox_sync_runs WHERE account_id=$1`, [accountId]); expect(run.rows).toHaveLength(1); expect(run.rows[0].status).toBe("failed");    expect(String(run.rows[0].error)).toContain("scheduled_sync_failed"); const journal = await db.query(`SELECT table_name,operation FROM mailbox_sync_journal WHERE run_id=$1`, [run.rows[0].id]); expect(journal.rows.some((row) => row.table_name === "messages" && row.operation === "INSERT")).toBe(true); expect((await db.query(`SELECT status FROM drafts WHERE id=$1`, [draftId])).rows[0].status).toBe("cancelled"); expect(fake.translate).not.toHaveBeenCalled(); expect(fake.append).not.toHaveBeenCalled(); expect((await db.query(`SELECT count(*)::int AS n FROM outbound_sends WHERE account_id=$1`, [accountId])).rows[0].n).toBe(0); });
  it("resumes failed UID and replays idempotently with terminal run/checkpoint readback", async () => { fake.failUid = 2; await expect(runScheduledMailboxSync(receipt(), deps())).rejects.toThrow(); fake.failUid = 0; fake.fetched = []; const resumed = await runScheduledMailboxSync(receipt(), deps()); expect(resumed.accountId).toBe(accountId); expect(fake.fetched).toEqual([2]); fake.fetched = []; const replay = await runScheduledMailboxSync(receipt(), deps()); expect(replay.imported).toBe(0); expect(fake.fetched).toEqual([]); const db = await getDb(); const runs = await db.query(`SELECT status,mode FROM mailbox_sync_runs WHERE account_id=$1 ORDER BY started_at`, [accountId]); expect(runs.rows.map((row) => [row.status, row.mode])).toEqual([["failed", "scheduled"], ["completed", "scheduled"], ["completed", "scheduled"]]); const checkpoint = await db.query(`SELECT uidvalidity,last_uid,history_complete,error FROM mailbox_sync_state WHERE account_id=$1 AND folder='INBOX'`, [accountId]); expect(checkpoint.rows[0]).toMatchObject({ uidvalidity: 77, last_uid: 2, history_complete: false, error: null }); const messages = await db.query(`SELECT uid,message_id FROM messages WHERE account_id=$1 AND folder='INBOX'`, [accountId]); expect(messages.rows).toHaveLength(2); expect(new Set(messages.rows.map((row) => row.message_id)).size).toBe(2); });
  it("journals manual Sent-copy intent before network and refuses undo after external effect", async () => {
    const db = await getDb();
    const seed = (await db.query<{ id: string; message_id: string }>("SELECT id,message_id FROM messages WHERE account_id=$1 AND direction='outbound' LIMIT 1", [accountId])).rows[0];
    fake.pending = [{ id: seed.id, messageId: seed.message_id, to: `contact@scheduled-${marker}.example`, subject: "Initial outreach" }];
    fake.saveCopy.mockImplementation(async () => {
      expect(currentDbContext()).toBeUndefined();
      return { saved: true, alreadyPresent: false, folder: "Sent Items", note: "accepted" };
    });
    const run = await startMailboxRun(db, { accountId, mode: "manual", leaseOwner: crypto.randomUUID() });
    const result = await backfillSentCopies(accountId, 10, { run, mode: "manual" });
    expect(result).toEqual({ attempted: 1, saved: 1, alreadyPresent: 0 });
    await finishMailboxRun(db, run);
    expect((await db.query("SELECT sent_copy_saved_at FROM messages WHERE id=$1 AND sent_copy_saved_at IS NOT NULL", [seed.id])).rows).toHaveLength(1);
    expect((await db.query("SELECT 1 FROM audit_log WHERE action='mailbox_sent_copy_append_intent' AND entity_id=$1", [run.id])).rows).toHaveLength(1);
    await expect(undoMailboxRun(db, run.id, userId)).rejects.toThrow("external Sent-copy effect intent");
    expect((await db.query("SELECT status FROM mailbox_sync_runs WHERE id=$1", [run.id])).rows[0].status).toBe("completed");
  });
  it("refuses omitted, scheduled or mismatched-account Sent-copy contexts before any network work", async () => {
    const run = { id: crypto.randomUUID(), accountId, mode: "scheduled" as const, fence: 1, leaseOwner: crypto.randomUUID() };
    await expect(backfillSentCopies(accountId)).rejects.toThrow("manual_sent_copy_context_invalid");
    await expect(backfillSentCopies(accountId, 10, { run, mode: "scheduled" })).rejects.toThrow("manual_sent_copy_context_invalid");
    await expect(backfillSentCopies(accountId, 10, { run: { ...run, mode: "manual", accountId: crypto.randomUUID() }, mode: "manual" })).rejects.toThrow("manual_sent_copy_context_invalid");
    expect(fake.saveCopy).not.toHaveBeenCalled();
  });
  it("refuses terminal manual-run contexts before append intent, network or marker persistence", async () => {
    const db = await getDb();
    const seed = (await db.query<{ id: string; message_id: string; sent_copy_saved_at: unknown }>("SELECT id,message_id,sent_copy_saved_at FROM messages WHERE account_id=$1 AND direction='outbound' LIMIT 1", [accountId])).rows[0];
    fake.pending = [{ id: seed.id, messageId: seed.message_id, to: `contact@scheduled-${marker}.example`, subject: "Initial outreach" }];
    const run = await startMailboxRun(db, { accountId, mode: "manual", leaseOwner: crypto.randomUUID() });
    await finishMailboxRun(db, run);
    await expect(backfillSentCopies(accountId, 10, { run, mode: "manual" })).rejects.toThrow("mailbox sync fence rejected");
    expect(fake.saveCopy).not.toHaveBeenCalled();
    expect((await db.query("SELECT 1 FROM audit_log WHERE action='mailbox_sent_copy_append_intent' AND entity_id=$1", [run.id])).rows).toHaveLength(0);
    expect((await db.query("SELECT sent_copy_saved_at FROM messages WHERE id=$1", [seed.id])).rows[0].sent_copy_saved_at).toEqual(seed.sent_copy_saved_at);
  });
});
