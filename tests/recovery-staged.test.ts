import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { syncEmailAccount, type SyncOptions } from "@/lib/email/sync";
import { getFolderInbox } from "@/lib/services/inbox";

const fake = vi.hoisted(() => ({
  account: {} as Record<string, unknown>, folder: "", failUid: 0, validity: 31,
  paths: ["INBOX", "Sent Items", "Sent Archive"], opened: [] as string[],
  mail: new Map<string, Map<number, string>>(),
  translation: vi.fn(), bounce: vi.fn(), copies: vi.fn(), append: vi.fn(), pause: vi.fn(),
  smtp: vi.fn(() => { throw new Error("SMTP prohibited during recovery"); }),
  network: vi.fn(() => { throw new Error("Model/network calls prohibited during recovery"); }),
}));
vi.mock("nodemailer", () => ({ default: { createTransport: fake.smtp }, createTransport: fake.smtp }));
vi.mock("@/lib/email/accounts", () => ({ getEmailAccountRecord: async () => fake.account }));
vi.mock("@/lib/auth/crypto", () => ({ decryptSecret: () => crypto.randomUUID() }));
vi.mock("@/lib/services/message-translations", () => ({ translateOnArrival: fake.translation }));
vi.mock("@/lib/email/bounce-handling", () => ({ recordBounceIfAny: fake.bounce, pauseProfileIfBouncing: fake.pause }));
vi.mock("@/lib/email/sent-copy", () => ({ listUncopiedSentMessages: fake.copies, saveSentCopyForMessage: fake.append }));
vi.mock("imapflow", () => ({ ImapFlow: class {
  async connect() {}
  async logout() {}
  async list() { return fake.paths.map(path => ({ path, specialUse: path === "Sent Archive" ? "\\Sent" : undefined })); }
  async mailboxOpen(path: string, options: { readOnly: boolean }) {
    expect(options).toEqual({ readOnly: true }); fake.opened.push(path); fake.folder = path;
    return { uidValidity: fake.validity, readOnly: true };
  }
  async search(query: { uid: string; since?: Date }) {
    expect(query.since).toBeUndefined();
    return [...(fake.mail.get(fake.folder)?.keys() ?? [])].filter(uid => uid >= Number(query.uid.split(":")[0])).reverse();
  }
  async *fetch(value: string) {
    const uid = Number(value);
    if (uid === fake.failUid) throw new Error("staged synthetic failure");
    const source = fake.mail.get(fake.folder)?.get(uid);
    if (source) yield { uid, source: Buffer.from(source), flags: new Set(["\\Seen"]) };
  }
} }));
const marker = crypto.randomUUID();
const accountId = crypto.randomUUID();
const userId = crypto.randomUUID();
const leads = Array.from({ length: 5 }, (_, index) => ({ id: crypto.randomUUID(), conversation: crypto.randomUUID(),
  email: `contact${index}@${marker}.example`, seed: `<staged-seed-${marker}-${index}@example.test>` }));
const dates = ["2026-10-17T23:25:00Z", "2026-10-24T09:47:00Z"];
function raw(uid: number, index = 0, inbound = false, date = dates[1], extra = "", body = "Historical webmail reply") {
  return `From: ${inbound ? leads[index].email : "founder@staged.example"}\r\nTo: ${inbound ? "founder@staged.example" : leads[index].email}\r\nSubject: Re: Staged ${index}\r\nMessage-ID: <staged-${marker}-${uid}@example.test>\r\nIn-Reply-To: ${leads[index].seed}\r\nDate: ${new Date(date).toUTCString()}\r\n${extra}\r\n${body}`;
}
const stage = (recoveryFolder: "Sent Items" | "INBOX"): SyncOptions => ({ mode: "backfill", founderUserId: userId, recoveryFolder });
async function protectedSnapshot() {
  const db = await getDb();
  const snapshot: Record<string, unknown> = {};
  for (const table of ["prospect_emails", "prospect_aliases", "suppressions", "email_bounces", "workspace_settings", "ai_task_settings", "outbound_sends", "message_translations"]) {
    snapshot[table] = (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return snapshot;
}
let baseline: Record<string, unknown>;
beforeAll(async () => {
  vi.stubGlobal("fetch", fake.network);
  const db = await getDb();
  await db.query(`INSERT INTO users(id,email,normalized_email,name,password_hash,role) VALUES($1,$2,$2,'Staged fixture',$3,'founder')`, [userId, `${marker}@example.test`, hashPassword(crypto.randomUUID())]);
  await db.query(`INSERT INTO email_accounts(id,name,provider,email_address,normalized_email,from_name,created_by) VALUES($1,'Staged fixture','sandbox','founder@staged.example','founder@staged.example','Founder',$2)`, [accountId, userId]);
  fake.account = { id: accountId, provider: "ionos", status: "connected", emailAddress: "founder@staged.example", fromName: "Founder", imapHost: "invalid.example.test", imapPort: 993, imapSecure: true, username: crypto.randomUUID(), passwordEncrypted: crypto.randomUUID() };
  for (const [index, lead] of leads.entries()) {
    await db.query(`INSERT INTO prospects(id,business_name,name_key,created_by_type) VALUES($1,$2,$3,'founder')`, [lead.id, index === 0 ? "OnwardBTC" : `Staged ${index}`, `${marker}-${index}`]);
    await db.query(`INSERT INTO prospect_emails(id,prospect_id,email,normalized_email,source_url,source_type) VALUES($1,$2,$3,$3,'https://example.test','official_website')`, [crypto.randomUUID(), lead.id, lead.email]);
    await db.query(`INSERT INTO conversations(id,prospect_id,subject,status) VALUES($1,$2,$3,'replied')`, [lead.conversation, lead.id, `Staged ${index}`]);
    await db.query(`INSERT INTO messages(id,account_id,prospect_id,conversation_id,message_id,direction,from_email,body_text,received_at) VALUES($1,$2,$3,$4,$5,'inbound',$6,'Earlier real reply','2026-10-10T09:00:00Z')`, [crypto.randomUUID(), accountId, lead.id, lead.conversation, lead.seed, lead.email]);
  }
  await db.query(`INSERT INTO mailbox_sync_state(id,account_id,folder,uidvalidity,last_uid,history_complete) VALUES($1,$2,'Sent',31,2000,false)`, [crypto.randomUUID(), accountId]);
  const sent = new Map<number, string>([[1, raw(1, 0, false, dates[0])], [2, raw(2)]]);
  for (let uid = 3; uid <= 6; uid++) sent.set(uid, raw(uid, uid - 2, false, "2026-11-05T10:00:00Z"));
  for (let uid = 7; uid <= 153; uid++) sent.set(uid, raw(uid, 0, false, "2026-11-05T10:00:00Z").replace(`In-Reply-To: ${leads[0].seed}\r\n`, "").replace(leads[0].email, `unknown@${uid}.example`).replace("Re: Staged 0", "Unrelated"));
  fake.mail = new Map([["Sent Items", sent], ["Sent Archive", new Map([[1, raw(1)]])], ["INBOX", new Map([
    [1, raw(800, 0, true, "2026-11-08T10:00:00Z")],
    [2, raw(801, 0, true, "2026-11-09T10:00:00Z", "Content-Type: multipart/report; report-type=delivery-status\r\n", "Final-Recipient: rfc822; dead@example.test\r\nStatus: 5.1.1\r\nAction: failed")],
  ])]]);
  // Initialize read-service defaults before recording immutable settings evidence.
  await getFolderInbox({ focus: leads[0].id });
  baseline = await protectedSnapshot();
});
afterAll(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM messages WHERE account_id=$1`, [accountId]);
  await db.query(`DELETE FROM prospects WHERE id=ANY($1::uuid[])`, [leads.map(lead => lead.id)]);
  await db.query(`DELETE FROM email_accounts WHERE id=$1`, [accountId]);
  await db.query(`DELETE FROM users WHERE id=$1`, [userId]);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
describe("exact physical-folder staged write-path recovery on real PGlite", () => {
  it("rejects non-backfill and malformed folder values before opening anything", async () => {
    await expect(syncEmailAccount(accountId, { recoveryFolder: "INBOX" })).rejects.toMatchObject({ code: "backfill_required" });
    for (const value of ["Sent", "sent items", "Sent Archive", "INBOX/child", "Trash", "", null, ["INBOX"], {}]) {
      await expect(syncEmailAccount(accountId, { ...stage("INBOX"), recoveryFolder: value } as SyncOptions)).rejects.toMatchObject({ code: "invalid_recovery_folder" });
    }
    expect(fake.opened).toEqual([]);
  });
  it("fails closed when the exact folder is absent, even with a special-use Sent alternative", async () => {
    fake.paths = ["INBOX", "Sent Archive"];
    const result = await syncEmailAccount(accountId, stage("Sent Items"));
    expect(result).toMatchObject({ complete: false, historyIncomplete: true, imported: 0, progress: [] });
    expect(result.errors).toHaveLength(1); expect(fake.opened).toEqual([]);
    fake.paths = ["INBOX", "Sent Items", "Sent Archive"];
  });
  it("Sent-only pages recover five leads and both exact Message-ID timestamps without ever touching INBOX", async () => {
    for (const lead of leads) expect((await getFolderInbox({ focus: lead.id })).focused?.folder).toBe("needs_reply");
    const first = await syncEmailAccount(accountId, stage("Sent Items"));
    expect(first).toMatchObject({ imported: 100, complete: false, historyIncomplete: true, progress: [{ folder: "Sent Items", lastUid: 100, remaining: 53, complete: false }] });
    fake.failUid = 105;
    const failed = await syncEmailAccount(accountId, stage("Sent Items"));
    expect(failed).toMatchObject({ complete: false, historyIncomplete: true, progress: [{ folder: "Sent Items", lastUid: 104, complete: false }] });
    expect(failed.errors).toHaveLength(1);
    const db = await getDb();
    expect((await db.query(`SELECT last_uid FROM mailbox_sync_state WHERE account_id=$1 AND folder='backfill:Sent Items'`, [accountId])).rows[0]).toMatchObject({ last_uid: 104 });
    fake.failUid = 0;
    expect(await syncEmailAccount(accountId, stage("Sent Items"))).toMatchObject({ complete: true, historyIncomplete: false, imported: 49 });
    const examples = await db.query<{ message_id: string; sent_at: string; conversation_id: string }>(`SELECT message_id,sent_at,conversation_id FROM messages WHERE account_id=$1 AND uid IN (1,2) ORDER BY uid`, [accountId]);
    expect(examples.rows.map(row => [row.message_id, new Date(row.sent_at).toISOString(), row.conversation_id])).toEqual(dates.map((date, index) => [`<staged-${marker}-${index + 1}@example.test>`, new Date(date).toISOString(), leads[0].conversation]));
    for (const lead of leads) expect((await getFolderInbox({ focus: lead.id })).focused?.folder).toBe("in_conversation");
    expect(fake.opened).toEqual(["Sent Items", "Sent Items", "Sent Items"]);
    expect((await db.query(`SELECT last_uid FROM mailbox_sync_state WHERE account_id=$1 AND folder='Sent'`, [accountId])).rows[0]).toMatchObject({ last_uid: 2000 });
    expect(await protectedSnapshot()).toEqual(baseline);
  });
  it("a fresh completed repeat imports/fills zero with zero duplicate groups; UIDVALIDITY reset remains bounded", async () => {
    expect(await syncEmailAccount(accountId, stage("Sent Items"))).toMatchObject({ imported: 0, filled: 0, complete: true });
    const db = await getDb();
    for (const columns of ["message_id", "uid,uidvalidity,folder"]) {
      expect((await db.query(`SELECT count(*)::int n FROM (SELECT ${columns} FROM messages WHERE account_id=$1 AND source='imap' GROUP BY ${columns} HAVING count(*)>1) duplicates`, [accountId])).rows[0]).toEqual({ n: 0 });
    }
    fake.validity = 32;
    expect(await syncEmailAccount(accountId, stage("Sent Items"))).toMatchObject({ imported: 0, filled: 0, complete: false, progress: [{ folder: "Sent Items", uidValidity: 32, lastUid: 100, remaining: 53 }] });
    expect(await syncEmailAccount(accountId, stage("Sent Items"))).toMatchObject({ imported: 0, filled: 0, complete: true, progress: [{ folder: "Sent Items", uidValidity: 32, lastUid: 153, remaining: 0 }] });
  });
  it("INBOX-only subsequently imports an actual later inbound, but a DSN remains pending without suppression", async () => {
    fake.opened = []; fake.paths = ["INBOX"]; // No Sent folder is needed for this phase.
    expect(await syncEmailAccount(accountId, stage("INBOX"))).toMatchObject({ imported: 2, complete: true, progress: [{ folder: "INBOX", complete: true }] });
    expect(fake.opened).toEqual(["INBOX"]);
    expect((await getFolderInbox({ focus: leads[0].id })).focused?.folder).toBe("needs_reply");
    const db = await getDb();
    expect((await db.query<{ raw_headers: unknown }>(`SELECT raw_headers FROM messages WHERE account_id=$1 AND message_id=$2`, [accountId, `<staged-${marker}-801@example.test>`])).rows[0].raw_headers).toMatchObject({ deliveryReport: true, historicalBouncePending: true });
    expect(await protectedSnapshot()).toEqual(baseline);
    for (const fn of [fake.translation, fake.bounce, fake.copies, fake.append, fake.pause, fake.smtp, fake.network]) expect(fn).not.toHaveBeenCalled();
    expect(await syncEmailAccount(accountId, stage("INBOX"))).toMatchObject({ imported: 0, filled: 0, complete: true });
  });
  it("a foreign sender in Sent Items fails with checkpoint held and cannot manufacture outbound chronology", async () => {
    fake.paths = ["Sent Items", "INBOX"];
    fake.mail.get("Sent Items")!.set(154, raw(154).replace("From: founder@staged.example", "From: foreign@example.test"));
    const result = await syncEmailAccount(accountId, stage("Sent Items"));
    expect(result.complete).toBe(false); expect(result.errors).toHaveLength(1);
    expect(result.progress).toMatchObject([{ folder: "Sent Items", lastUid: 153, complete: false }]);
    expect((await getFolderInbox({ focus: leads[0].id })).focused?.folder).toBe("needs_reply");
  });
});
