import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { syncEmailAccount } from "@/lib/email/sync";
import { cleanupMailboxRuns } from "./helpers/mailbox-run-cleanup";

const fake = vi.hoisted(() => ({
  account: {} as Record<string, unknown>,
  folder: "",
  connectError: null as Error | null,
  listError: null as Error | null,
  searchError: null as Error | null,
  searchOverride: null as number[] | null,
  uidValidity: 41,
  authValue: crypto.randomUUID(),
  openErrors: new Set<string>(),
  failUids: new Set<number>(),
  missingUids: new Set<number>(),
  fetched: [] as number[],
  mail: new Map<string, Map<number, string>>(),
}));

vi.mock("@/lib/email/accounts", () => ({ getEmailAccountRecord: async () => fake.account }));
vi.mock("@/lib/auth/crypto", () => ({ decryptSecret: () => fake.authValue }));
vi.mock("@/lib/email/sent-copy", () => ({
  listUncopiedSentMessages: async () => [],
  saveSentCopyForMessage: async () => ({ saved: false, alreadyPresent: false }),
}));
vi.mock("imapflow", () => ({ ImapFlow: class {
  async connect() { if (fake.connectError) throw fake.connectError; }
  async logout() {}
  async list() {
    if (fake.listError) throw fake.listError;
    return [{ path: "INBOX" }, { path: "Sent Items", specialUse: "\\Sent" }];
  }
  async mailboxOpen(path: string) {
    fake.folder = path;
    if (fake.openErrors.has(path)) throw new Error(`open failed for ${path}`);
    return { uidValidity: fake.uidValidity, readOnly: true };
  }
  async search(query: { uid?: string }) {
    if (fake.searchError) throw fake.searchError;
    if (fake.searchOverride) return fake.searchOverride;
    const after = query.uid ? Number(query.uid.split(":")[0]) : 0;
    return [...(fake.mail.get(fake.folder)?.keys() ?? [])]
      .filter((uid) => uid >= after)
      .reverse();
  }
  async *fetch(uidText: string) {
    const uid = Number(uidText);
    fake.fetched.push(uid);
    if (fake.failUids.has(uid)) throw new Error(`fetch failed for ${uid}`);
    if (fake.missingUids.has(uid)) return;
    const source = fake.mail.get(fake.folder)?.get(uid);
    if (source) yield {
      uid,
      source: Buffer.from(source),
      flags: new Set(["\\Seen"]),
      internalDate: new Date("2026-11-14T09:00:00Z"),
    };
  }
} }));

const marker = crypto.randomUUID();
const accountId = crypto.randomUUID();
const userId = crypto.randomUUID();
const oldSyncAt = "2026-11-13T09:00:00.000Z";

function source(uid: number) {
  return [
    `From: founder@incremental-${marker}.example`,
    `To: recipient@incremental-${marker}.example`,
    `Subject: Synthetic UID ${uid}`,
    `Message-ID: <incremental-${marker}-${uid}@example.test>`,
    "Date: Fri, 14 Nov 2026 09:00:00 +0000",
    "",
    `Synthetic mailbox message ${uid}`,
  ].join("\r\n");
}

async function state(folder: string) {
  const db = await getDb();
  return db.query<{ uidvalidity: string; last_uid: string; history_complete: boolean; error: string | null }>(
    `SELECT uidvalidity,last_uid,history_complete,error FROM mailbox_sync_state WHERE account_id=$1 AND folder=$2`,
    [accountId, folder],
  );
}

async function account() {
  const db = await getDb();
  return db.query<{ last_sync_at: Date | null; last_error: string | null }>(
    `SELECT last_sync_at,last_error FROM email_accounts WHERE id=$1`, [accountId],
  );
}

beforeAll(async () => {
  const db = await getDb();
  await db.query(
    `INSERT INTO users(id,email,normalized_email,name,password_hash,role)
     VALUES($1,$2,$2,'Incremental fixture',$3,'founder')`,
    [userId, `${marker}@example.test`, hashPassword(crypto.randomUUID())],
  );
  await db.query(
    `INSERT INTO email_accounts(id,name,provider,email_address,normalized_email,from_name,imap_host,username,password_encrypted,status,last_sync_at,last_error,created_by)
     VALUES($1,'Incremental fixture','ionos',$2,$2,'Founder','synthetic.example','','','connected',$3,'previous error',$4)`,
    [accountId, `founder@incremental-${marker}.example`, oldSyncAt, userId],
  );
  fake.account = {
    id: accountId, provider: "ionos", status: "connected",
    emailAddress: `founder@incremental-${marker}.example`, fromName: "Founder",
    imapHost: "synthetic.example", imapPort: 993, imapSecure: true,
    username: "", passwordEncrypted: "",
  };
});

beforeEach(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM messages WHERE account_id=$1`, [accountId]);
  await db.query(`DELETE FROM mailbox_sync_state WHERE account_id=$1`, [accountId]);
  await db.query(
    `INSERT INTO mailbox_sync_state(id,account_id,folder,uidvalidity,last_uid,history_complete,error)
     VALUES($1,$2,'INBOX',41,10,true,NULL),($3,$2,'Sent',41,1,true,NULL)`,
    [crypto.randomUUID(), accountId, crypto.randomUUID()],
  );
  fake.connectError = null;
  fake.listError = null;
  fake.searchError = null;
  fake.searchOverride = null;
  fake.uidValidity = 41;
  fake.openErrors.clear();
  fake.failUids.clear();
  fake.missingUids.clear();
  fake.fetched = [];
  fake.mail = new Map([
    ["INBOX", new Map()],
    ["Sent Items", new Map()],
  ]);
  await db.query(`UPDATE email_accounts SET last_sync_at=$2,last_error='previous error' WHERE id=$1`, [accountId, oldSyncAt]);
});

afterEach(() => vi.clearAllMocks());
afterAll(async () => {
  const db = await getDb();
  await cleanupMailboxRuns(db, [accountId]);
  await db.query(`DELETE FROM email_accounts WHERE id=$1`, [accountId]);
  await db.query(`DELETE FROM users WHERE id=$1`, [userId]);
});

describe("incremental mailbox cursor and freshness safety", () => {
  it("stops at a failed UID and resumes that UID and later UIDs exactly once", async () => {
    fake.mail.set("INBOX", new Map([[11, source(11)], [12, source(12)], [13, source(13)]]));
    fake.failUids.add(12);

    const failed = await syncEmailAccount(accountId);
    expect(failed.errors).toEqual([expect.stringContaining("INBOX UID 12")]);
    expect(fake.fetched).toEqual([11, 12]);
    expect((await state("INBOX")).rows[0]).toMatchObject({ last_uid: 11, history_complete: false });
    expect((await account()).rows[0].last_sync_at).toEqual(new Date(oldSyncAt));

    fake.failUids.clear();
    fake.fetched = [];
    const resumed = await syncEmailAccount(accountId);
    expect(resumed.errors).toEqual([]);
    expect(fake.fetched).toEqual([12, 13]);
    expect((await state("INBOX")).rows[0]).toMatchObject({ last_uid: 13, history_complete: false, error: null });
    const messages = await (await getDb()).query(`SELECT uid FROM messages WHERE account_id=$1 AND folder='INBOX' ORDER BY uid`, [accountId]);
    expect(messages.rows).toEqual([{ uid: 11 }, { uid: 12 }, { uid: 13 }]);
  });

  it("does not silently skip a missing source", async () => {
    fake.mail.set("INBOX", new Map([[11, source(11)], [12, source(12)], [13, source(13)]]));
    fake.missingUids.add(12);

    const result = await syncEmailAccount(accountId);
    expect(result.errors).toEqual([expect.stringContaining("UID 12 was not fetched")]);
    expect(fake.fetched).toEqual([11, 12]);
    expect((await state("INBOX")).rows[0].last_uid).toBe(11);
  });

  it("preserves the cursor and freshness on connection, list, and folder-open failures", async () => {
    fake.connectError = new Error("synthetic connection detail");
    await expect(syncEmailAccount(accountId)).rejects.toMatchObject({
      code: "imap_connect_failed",
      message: "Could not connect to IMAP. Check Settings and try again.",
    });
    expect((await state("INBOX")).rows[0]).toMatchObject({ uidvalidity: 41, last_uid: 10, history_complete: true });
    expect((await account()).rows[0]).toMatchObject({ last_sync_at: new Date(oldSyncAt), last_error: "synthetic connection detail" });

    fake.connectError = null;
    fake.listError = new Error("synthetic list detail");
    await expect(syncEmailAccount(accountId)).rejects.toMatchObject({
      code: "sync_failed",
      message: "Mailbox sync failed. Check the mailbox settings and try again.",
    });
    expect((await state("INBOX")).rows[0].last_uid).toBe(10);
    expect((await account()).rows[0].last_sync_at).toEqual(new Date(oldSyncAt));

    fake.listError = null;
    fake.openErrors.add("INBOX");
    const result = await syncEmailAccount(accountId);
    expect(result.errors).toEqual([expect.stringContaining("INBOX: open failed")]);
    expect((await state("INBOX")).rows[0]).toMatchObject({ uidvalidity: 41, last_uid: 10, history_complete: true, error: null });
    expect((await account()).rows[0].last_sync_at).toEqual(new Date(oldSyncAt));
  });

  it("marks a successful normal run fresh and clears the prior error", async () => {
    const before = await account();
    const result = await syncEmailAccount(accountId);
    expect(result.errors).toEqual([]);
    const after = await account();
    expect(after.rows[0].last_sync_at!.getTime()).toBeGreaterThan(before.rows[0].last_sync_at!.getTime());
    expect(after.rows[0].last_error).toBeNull();
  });

  it("preserves a checkpoint when search fails before any fetch", async () => {
    fake.searchError = new Error("synthetic search failure");
    const result = await syncEmailAccount(accountId);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(fake.fetched).toEqual([]);
    expect((await state("INBOX")).rows[0]).toMatchObject({ uidvalidity: 41, last_uid: 10, history_complete: true });
    expect((await account()).rows[0].last_sync_at).toEqual(new Date(oldSyncAt));
  });

  it("never reuses an old UID cursor after UIDVALIDITY changes", async () => {
    fake.uidValidity = 42;
    fake.mail.set("INBOX", new Map([[1, source(1)], [2, source(2)]]));
    fake.failUids.add(1);
    const failed = await syncEmailAccount(accountId);
    expect(failed.errors).toEqual([expect.stringContaining("INBOX UID 1")]);
    expect((await state("INBOX")).rows[0]).toMatchObject({ uidvalidity: 42, last_uid: 0, history_complete: false });
    fake.failUids.clear();
    fake.fetched = [];
    expect((await syncEmailAccount(accountId)).errors).toEqual([]);
    expect(fake.fetched).toEqual([1, 2]);
    expect((await state("INBOX")).rows[0].last_uid).toBe(2);
  });

  it("ignores n:* tail UIDs below the cursor rather than rewinding it", async () => {
    await (await getDb()).query(`UPDATE mailbox_sync_state SET last_uid=10 WHERE account_id=$1 AND folder='Sent'`, [accountId]);
    fake.searchOverride = [10];
    expect((await syncEmailAccount(accountId)).errors).toEqual([]);
    expect(fake.fetched).toEqual([]);
    expect((await state("INBOX")).rows[0].last_uid).toBe(10);
  });

  it("refuses malformed search UIDs without advancing checkpoints or freshness", async () => {
    fake.searchOverride = [11, Number.NaN, 12];
    const result = await syncEmailAccount(accountId);
    expect(result.errors).toEqual([
      expect.stringContaining("INBOX: Mailbox returned invalid search UIDs"),
      expect.stringContaining("Sent: Mailbox returned invalid search UIDs"),
    ]);
    expect(fake.fetched).toEqual([]);
    expect((await state("INBOX")).rows[0]).toMatchObject({ last_uid: 10, history_complete: true });
    expect((await account()).rows[0].last_sync_at).toEqual(new Date(oldSyncAt));
  });
});
