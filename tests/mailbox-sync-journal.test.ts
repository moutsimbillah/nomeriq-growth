import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { getDb, type DbClient } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { finishMailboxRun, renewMailboxRun, startMailboxRun, undoMailboxRun, withMailboxRun, type BackupReceipt } from "@/lib/email/sync-journal";
import { issueVerifiedBackupReceipt } from "@/lib/email/verified-scheduled-backup";
import { mockScheduledBackupFacts } from "./helpers/scheduled-backup-facts";

function client(db: PGlite): DbClient {
  return {
    query: async <T>(text: string, params: unknown[] = []) => {
      const result = await db.query<T>(text, params);
      return { rows: result.rows as T[], rowCount: result.affectedRows ?? result.rows.length };
    },
    exec: async (sql: string) => { await db.exec(sql); },
    transaction: async <T>(fn: (tx: DbClient) => Promise<T>) => db.transaction(async (raw) => {
      const scoped: DbClient = {
        query: async <R>(text: string, params: unknown[] = []) => { const r = await raw.query<R>(text, params); return { rows: r.rows as R[], rowCount: r.affectedRows ?? r.rows.length }; },
        exec: async (sql: string) => { await raw.exec(sql); },
        transaction: async <R>(nested: (tx: DbClient) => Promise<R>) => nested(scoped),
        close: async () => {},
      };
      return fn(scoped);
    }),
    close: async () => db.close(),
  };
}

let pglite: PGlite;
let db: DbClient;
const accountId = crypto.randomUUID();
const actorId = crypto.randomUUID();
const fixtureCredential = crypto.randomUUID();
let legacyRowsPreserved = false;
const receipt: BackupReceipt = { kind: "pg_dump", verified: true, path: "/var/backups/growth/deploy-20261114T000000Z.dump", sizeBytes: 2048, tableDataCount: 50, verifiedAt: new Date().toISOString(), mode: "600" };

beforeAll(async () => {
  pglite = new PGlite();
  const files = (await fs.readdir("src/db/migrations")).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await pglite.exec(await fs.readFile(`src/db/migrations/${file}`, "utf8"));
  await dbSeed();
  const snapshot = async () => (await db.query(`SELECT jsonb_build_object(
    'account',(SELECT to_jsonb(a) FROM email_accounts a WHERE id=$1),
    'user',(SELECT to_jsonb(u) FROM users u WHERE id=$2)) AS data`, [accountId, actorId])).rows[0];
  const before = await snapshot();
  for (const file of files) await pglite.exec(await fs.readFile(`src/db/migrations/${file}`, "utf8"));
  legacyRowsPreserved = JSON.stringify(await snapshot()) === JSON.stringify(before);
});

async function dbSeed() {
  db = client(pglite);
  await db.query(`INSERT INTO users (id,email,normalized_email,name,password_hash,role) VALUES ($1,'journal@test.invalid','journal@test.invalid','Journal founder',$2,'founder')`, [actorId, hashPassword(crypto.randomUUID())]);
  await db.query(`INSERT INTO email_accounts (id,name,email_address,normalized_email,from_name,username,password_encrypted,status) VALUES ($1,'Journal mailbox','journal@example.test','journal@example.test','Journal','',$2,'connected')`, [accountId, fixtureCredential]);
}

afterAll(async () => { await pglite.close(); });

describe("mailbox sync journal foundation", () => {
  it("is idempotent and preserves legacy rows while capturing exact first-before/latest-after", async () => {
    expect(legacyRowsPreserved).toBe(true);
    expect((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM users WHERE id=$1", [actorId])).rows[0].n).toBe("1");
    const run = await startMailboxRun(db, { accountId, mode: "manual", leaseOwner: crypto.randomUUID() });
    const messageId = crypto.randomUUID();
    await withMailboxRun(db, run, async () => {
      const scoped = await getDb();
      await scoped.query(`INSERT INTO messages (id,account_id,direction,source,from_email,subject,body_text,received_at) VALUES ($1,$2,'inbound','imap','sender@example.test','Before','microsecond body','2026-11-14 00:00:00.123456+00')`, [messageId, accountId]);
      await getDb().then((tx) => tx.query("UPDATE messages SET subject='After', body_text='Latest' WHERE id=$1", [messageId]));
    });
    const journal = await db.query<{ before_data: Record<string, unknown>; after_data: Record<string, unknown>; operation: string }>("SELECT before_data,after_data,operation FROM mailbox_sync_journal WHERE run_id=$1 AND table_name='messages'", [run.id]);
    expect(journal.rows).toHaveLength(1);
    expect(journal.rows[0].operation).toBe("INSERT");
    expect(journal.rows[0].before_data).toBeNull();
    expect(journal.rows[0].after_data.subject).toBe("After");
    expect(journal.rows[0].after_data.received_at).toContain("00:00:00.123456");
    await finishMailboxRun(db, run);
    expect(await undoMailboxRun(db, run.id, actorId)).toEqual({ undone: true, conflict: false });
    expect(await undoMailboxRun(db, run.id, actorId)).toEqual({ undone: false, conflict: false });
    expect((await db.query("SELECT id FROM messages WHERE id=$1", [messageId])).rows).toHaveLength(0);
    const account = await db.query<{ password_encrypted: string; status: string }>("SELECT password_encrypted,status FROM email_accounts WHERE id=$1", [accountId]);
    expect(account.rows[0]).toEqual({ password_encrypted: fixtureCredential, status: "connected" });
  });

  it("requires backup proof only for scheduled runs and rejects overlapping leases", async () => {
    await expect(startMailboxRun(db, { accountId, mode: "scheduled", leaseOwner: crypto.randomUUID() })).rejects.toThrow("backup receipt");
    const first = await startMailboxRun(db, { accountId, mode: "manual", leaseOwner: crypto.randomUUID() });
    await renewMailboxRun(db, first, 10);
    await expect(startMailboxRun(db, { accountId, mode: "manual", leaseOwner: crypto.randomUUID() })).rejects.toThrow("already held");
    await db.query("UPDATE mailbox_sync_leases SET lease_until=now()-interval '1 second' WHERE account_id=$1", [accountId]);
    const second = await startMailboxRun(db, { accountId, mode: "manual", leaseOwner: crypto.randomUUID() });
    const prior = await db.query<{ status: string }>("SELECT status FROM mailbox_sync_runs WHERE id=$1", [first.id]);
    expect(prior.rows[0].status).toBe("expired");
    await expect(withMailboxRun(db, first, async () => undefined)).rejects.toThrow("fence rejected");
    await finishMailboxRun(db, second);
  });

  it("closes and undoes an interrupted scheduled run only after its lease expires", async () => {
    const restoreFacts = mockScheduledBackupFacts();
    try {
      const verified = await issueVerifiedBackupReceipt({ ...receipt, verifiedAt: new Date().toISOString() });
      const run = await startMailboxRun(db, { accountId, mode: "scheduled", leaseOwner: crypto.randomUUID(), backupReceipt: verified });
      const messageId = crypto.randomUUID();
      await withMailboxRun(db, run, async (tx) => {
        await tx.query(`INSERT INTO messages (id,account_id,direction,source,from_email,subject,body_text) VALUES ($1,$2,'inbound','imap','interrupted@example.test','Interrupted','Body')`, [messageId, accountId]);
      });

      await expect(undoMailboxRun(db, run.id, actorId, verified)).rejects.toThrow("not terminal");
      expect((await db.query("SELECT id FROM messages WHERE id=$1", [messageId])).rows).toHaveLength(1);

      await db.query("UPDATE mailbox_sync_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE account_id=$1", [accountId]);
      expect(await undoMailboxRun(db, run.id, actorId, verified)).toEqual({ undone: true, conflict: false });
      expect((await db.query("SELECT status FROM mailbox_sync_runs WHERE id=$1", [run.id])).rows[0].status).toBe("undone");
      expect((await db.query("SELECT id FROM mailbox_sync_journal WHERE run_id=$1", [run.id])).rows).toHaveLength(1);
      expect((await db.query("SELECT id FROM messages WHERE id=$1", [messageId])).rows).toHaveLength(0);
    } finally { restoreFacts(); }
  });

  it("rolls back both business writes and their journal entries on transaction failure", async () => {
    const run = await startMailboxRun(db, { accountId, mode: "manual", leaseOwner: crypto.randomUUID() });
    const messageId = crypto.randomUUID();
    await expect(withMailboxRun(db, run, async (tx) => {
      await tx.query(`INSERT INTO messages (id,account_id,direction,source,from_email,subject,body_text) VALUES ($1,$2,'inbound','imap','rollback@example.test','Rollback','Body')`, [messageId, accountId]);
      throw new Error("synthetic write failure");
    })).rejects.toThrow("synthetic write failure");
    expect((await db.query("SELECT id FROM messages WHERE id=$1", [messageId])).rows).toHaveLength(0);
    expect((await db.query("SELECT id FROM mailbox_sync_journal WHERE run_id=$1", [run.id])).rows).toHaveLength(0);
    await finishMailboxRun(db, run, "failed", "synthetic write failure");
  });

  it("refuses undo when a later founder edit changed the captured value", async () => {
    const run = await startMailboxRun(db, { accountId, mode: "manual", leaseOwner: crypto.randomUUID() });
    const messageId = crypto.randomUUID();
    await withMailboxRun(db, run, async (tx) => {
      await tx.query(`INSERT INTO messages (id,account_id,direction,source,from_email,subject,body_text) VALUES ($1,$2,'inbound','imap','conflict@example.test','Original','Body')`, [messageId, accountId]);
      await tx.query("UPDATE messages SET subject='Sync edit' WHERE id=$1", [messageId]);
    });
    await finishMailboxRun(db, run);
    await db.query("UPDATE messages SET subject='Founder edit' WHERE id=$1", [messageId]);
    expect(await undoMailboxRun(db, run.id, actorId)).toEqual({ undone: false, conflict: true });
    expect((await db.query<{ subject: string }>("SELECT subject FROM messages WHERE id=$1", [messageId])).rows[0].subject).toBe("Founder edit");
  });

  it("preflights every row before mutating, so an early insert is not partially undone", async () => {
    const run = await startMailboxRun(db, { accountId, mode: "manual", leaseOwner: crypto.randomUUID() });
    const first = crypto.randomUUID(); const second = crypto.randomUUID();
    await withMailboxRun(db, run, async (tx) => {
      for (const [id, subject] of [[first, "first"], [second, "second"]]) await tx.query(`INSERT INTO messages (id,account_id,direction,source,from_email,subject,body_text) VALUES ($1,$2,'inbound','imap',$3,$4,'body')`, [id, accountId, `${id}@example.test`, subject]);
    });
    await finishMailboxRun(db, run);
    await db.query("UPDATE messages SET subject='founder changed' WHERE id=$1", [second]);
    expect(await undoMailboxRun(db, run.id, actorId)).toEqual({ undone: false, conflict: true });
    expect((await db.query<{ subject: string }>("SELECT subject FROM messages WHERE id=$1", [first])).rows[0].subject).toBe("first");
    expect((await db.query<{ subject: string }>("SELECT subject FROM messages WHERE id=$1", [second])).rows[0].subject).toBe("founder changed");
    expect((await db.query("SELECT 1 FROM audit_log WHERE action='mailbox_sync_undo_conflict' AND entity_id=$1", [run.id])).rows).toHaveLength(1);
  });

  it("restores parent and children in capture-sequence reverse order", async () => {
    const prospect = crypto.randomUUID(); const conversation = crypto.randomUUID(); const message = crypto.randomUUID(); const attachment = crypto.randomUUID();
    await db.query(`INSERT INTO prospects (id,business_name,name_key,domain_key) VALUES ($1,'Order lead',$2,$3)`, [prospect, `order-${prospect}`, `order-${prospect}.test`]);
    const run = await startMailboxRun(db, { accountId, mode: "manual", leaseOwner: crypto.randomUUID() });
    await withMailboxRun(db, run, async (tx) => {
      await tx.query(`INSERT INTO conversations (id,prospect_id,subject) VALUES ($1,$2,'ordered')`, [conversation, prospect]);
      await tx.query(`INSERT INTO messages (id,conversation_id,prospect_id,account_id,direction,source,from_email,subject,body_text) VALUES ($1,$2,$3,$4,'inbound','imap','ordered@example.test','ordered','body')`, [message, conversation, prospect, accountId]);
      await tx.query(`INSERT INTO message_attachments (id,message_id,filename,content_type,size,content) VALUES ($1,$2,'a.txt','text/plain',3,'abc')`, [attachment, message]);
      await tx.query("UPDATE conversations SET subject='Updated after children' WHERE id=$1", [conversation]);
    });
    await finishMailboxRun(db, run);
    expect(await undoMailboxRun(db, run.id, actorId)).toEqual({ undone: true, conflict: false });
    for (const [table, id] of [["message_attachments", attachment], ["messages", message], ["conversations", conversation]]) expect((await db.query(`SELECT 1 FROM "${table}" WHERE id=$1`, [id])).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM prospects WHERE id=$1", [prospect])).rows).toHaveLength(1);
  });

  it("retains audit history while undoing rejection-related rows", async () => {
    const prospect = crypto.randomUUID(); const recommendation = crypto.randomUUID(); const message = crypto.randomUUID();
    await db.query(`INSERT INTO prospects (id,business_name,name_key,domain_key) VALUES ($1,'Coverage lead',$2,$3)`, [prospect, `coverage-${prospect}`, `coverage-${prospect}.test`]);
    const run = await startMailboxRun(db, { accountId, mode: "manual", leaseOwner: crypto.randomUUID() });
    await withMailboxRun(db, run, async (tx) => {
      await tx.query(`INSERT INTO messages (id,account_id,direction,source,from_email,subject,body_text) VALUES ($1,$2,'inbound','imap','reject@example.test','no','not interested')`, [message, accountId]);
      await tx.query(`INSERT INTO prospect_rejection_recommendations (id,prospect_id,message_id,reason,objection,provenance_key) VALUES ($1,$2,$3,'not a fit','no',$4)`, [recommendation, prospect, message, `test:${recommendation}`]);
      await tx.query(`INSERT INTO audit_log (id,actor_type,action,entity_type,entity_id,metadata) VALUES ($1,'system','test_audit','prospect',$2,'{"kept":true}')`, [crypto.randomUUID(), prospect]);
    });
    await finishMailboxRun(db, run);
    expect(await undoMailboxRun(db, run.id, actorId)).toEqual({ undone: true, conflict: false });
    expect((await db.query("SELECT 1 FROM prospect_rejection_recommendations WHERE id=$1", [recommendation])).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM audit_log WHERE action='test_audit' AND entity_id=$1", [prospect])).rows).toHaveLength(1);
  });

  it("restores only the account projection and preserves credentials and configuration", async () => {
    const before = (await db.query<{ password_encrypted: string; username: string; daily_send_limit: number }>("SELECT password_encrypted,username,daily_send_limit FROM email_accounts WHERE id=$1", [accountId])).rows[0];
    const run = await startMailboxRun(db, { accountId, mode: "manual", leaseOwner: crypto.randomUUID() });
    await withMailboxRun(db, run, async (tx) => { await tx.query("UPDATE email_accounts SET status='error',last_error='temporary',last_sync_at='2026-11-14 00:00:00.123456+00',daily_send_limit=99 WHERE id=$1", [accountId]); });
    await finishMailboxRun(db, run);
    expect(await undoMailboxRun(db, run.id, actorId)).toEqual({ undone: true, conflict: false });
    expect((await db.query<{ password_encrypted: string; username: string; daily_send_limit: number; status: string }>("SELECT password_encrypted,username,daily_send_limit,status FROM email_accounts WHERE id=$1", [accountId])).rows[0]).toEqual({ ...before, daily_send_limit: 99, status: "connected" });
    const captured = (await db.query<{ after_data: Record<string, unknown> }>("SELECT after_data FROM mailbox_sync_journal WHERE run_id=$1", [run.id])).rows[0].after_data;
    expect(Object.keys(captured).sort()).toEqual(["last_checked_at", "last_error", "last_sync_at", "status", "updated_at"].sort());
  });

  it("rejects weak or stale scheduled receipts", async () => {
    const bad = { kind: "pg_dump" as const, verified: true as const, path: "/var/backups/growth/deploy-bad.dump", sizeBytes: 42, tableDataCount: 12, verifiedAt: new Date().toISOString() };
    await expect(startMailboxRun(db, { accountId, mode: "scheduled", leaseOwner: crypto.randomUUID(), backupReceipt: bad })).rejects.toThrow("backup receipt");
    await expect(startMailboxRun(db, { accountId, mode: "scheduled", leaseOwner: crypto.randomUUID(), backupReceipt: { ...bad, sizeBytes: 2048, tableDataCount: 50, verifiedAt: "2020-01-01T00:00:00Z" } })).rejects.toThrow("backup receipt");
  });

  it("restores an existing row's JSON arrays and exact microsecond timestamp", async () => {
    const id = crypto.randomUUID();
    await db.query(`INSERT INTO messages(id,account_id,direction,from_email,to_emails,received_at)
      VALUES($1,$2,'inbound','typed@example.test','["original@example.test"]','2026-11-14 00:00:00.123456+00')`, [id, accountId]);
    const read = async () => (await db.query("SELECT to_emails,received_at::text AS stamp FROM messages WHERE id=$1", [id])).rows[0];
    const before = await read();
    const run = await startMailboxRun(db, { accountId, mode: "manual", leaseOwner: crypto.randomUUID() });
    await withMailboxRun(db, run, tx => tx.query(`UPDATE messages SET to_emails='["later@example.test"]',received_at='2026-11-14 01:00:00.654321+00' WHERE id=$1`, [id]));
    await finishMailboxRun(db, run);
    expect(await undoMailboxRun(db, run.id, actorId)).toEqual({ undone: true, conflict: false });
    expect(await read()).toEqual(before);
  });

  it("rolls back the entire undo rather than cascade-delete a later unrecorded child", async () => {
    const prospect = crypto.randomUUID(), conversation = crypto.randomUUID(), original = crypto.randomUUID(), later = crypto.randomUUID();
    await db.query("INSERT INTO prospects(id,business_name,name_key,domain_key) VALUES($1,'Cascade fixture',$2,$3)", [prospect, prospect, `${prospect}.example.test`]);
    const run = await startMailboxRun(db, { accountId, mode: "manual", leaseOwner: crypto.randomUUID() });
    await withMailboxRun(db, run, async tx => {
      await tx.query("INSERT INTO conversations(id,prospect_id,subject) VALUES($1,$2,'Parent')", [conversation, prospect]);
      await tx.query("INSERT INTO messages(id,conversation_id,account_id,direction,from_email) VALUES($1,$2,$3,'inbound','original@example.test')", [original, conversation, accountId]);
    });
    await finishMailboxRun(db, run);
    await db.query("INSERT INTO messages(id,conversation_id,account_id,direction,from_email) VALUES($1,$2,$3,'inbound','later@example.test')", [later, conversation, accountId]);
    expect(await undoMailboxRun(db, run.id, actorId)).toEqual({ undone: false, conflict: true });
    expect((await db.query("SELECT id FROM messages WHERE conversation_id=$1", [conversation])).rows).toHaveLength(2);
    expect((await db.query("SELECT id FROM conversations WHERE id=$1", [conversation])).rows).toHaveLength(1);
  });

  it("rolls business writes back if the lease expires before the callback completes", async () => {
    const run = await startMailboxRun(db, { accountId, mode: "manual", leaseOwner: crypto.randomUUID() });
    const id = crypto.randomUUID();
    await expect(withMailboxRun(db, run, async tx => {
      await tx.query("INSERT INTO messages(id,account_id,direction,from_email) VALUES($1,$2,'inbound','expiry@example.test')", [id, accountId]);
      await tx.query("UPDATE mailbox_sync_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE account_id=$1", [accountId]);
    })).rejects.toThrow("fence rejected");
    expect((await db.query("SELECT id FROM messages WHERE id=$1", [id])).rows).toHaveLength(0);
    expect((await db.query("SELECT id FROM mailbox_sync_journal WHERE run_id=$1", [run.id])).rows).toHaveLength(0);
    await finishMailboxRun(db, run, "failed");
  });

  it("refuses protected inserts and all business deletions before they can commit", async () => {
    const run = await startMailboxRun(db, { accountId, mode: "manual", leaseOwner: crypto.randomUUID() });
    const prospect = crypto.randomUUID(), message = crypto.randomUUID();
    await db.query("INSERT INTO messages(id,account_id,direction,from_email) VALUES($1,$2,'inbound','protected@example.test')", [message, accountId]);
    await expect(withMailboxRun(db, run, tx => tx.query("INSERT INTO prospects(id,business_name,name_key) VALUES($1,'Protected',$2)", [prospect, prospect]))).rejects.toThrow("not recoverable");
    await expect(withMailboxRun(db, run, tx => tx.query("DELETE FROM messages WHERE id=$1", [message]))).rejects.toThrow("not recoverable");
    expect((await db.query("SELECT id FROM prospects WHERE id=$1", [prospect])).rows).toHaveLength(0);
    expect((await db.query("SELECT id FROM messages WHERE id=$1", [message])).rows).toHaveLength(1);
    await finishMailboxRun(db, run, "failed");
  });
});
