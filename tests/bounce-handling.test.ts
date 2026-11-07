import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";

import { closeDb, getDb, type DbClient } from "@/lib/db/client";
import {
  bounceRateForAccount,
  countPriorSoftBounces,
  getBouncePauseState,
  pauseProfileIfBouncing,
  recordBounceIfAny,
  resumeFromBouncePause,
} from "@/lib/email/bounce-handling";

/**
 * Bounce handling, against the real database.
 *
 * The rules being pinned are the ones that change what happens to a real prospect: a permanent bounce
 * suppresses that address, a soft bounce waits for the third before it does, a complaint is a
 * suppression too, and a profile that bounces more than 3% of its last 50 sends stops sending by
 * itself. The last one is the dangerous one — a profile that pauses wrongly stops outreach, and one
 * that never pauses keeps sending to addresses that do not exist.
 */

let db: DbClient;
const accountIds: string[] = [];
const prospectIds: string[] = [];
const messageIds: string[] = [];
const RUN = `bounce-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function createAccount(label: string, status = "connected"): Promise<string> {
  const id = crypto.randomUUID();
  accountIds.push(id);
  await db.query(
    `INSERT INTO email_accounts (id, name, provider, email_address, normalized_email, from_name,
       status, smtp_host, imap_host, username, password_encrypted, is_default)
     VALUES ($1, $2, 'smtp_imap', $3, $3, 'Bounce', $4, 'smtp.example.test', 'imap.example.test',
             'user', 'x', false)`,
    [id, `${RUN} ${label}`, `${label}-${RUN}@example.test`, status],
  );
  return id;
}

async function seedRecipient(email: string): Promise<void> {
  // A suppression row must not already exist for the address, so each test uses its own.
  await db.query(`DELETE FROM suppressions WHERE normalized_email = $1`, [email]);
  await db.query(`DELETE FROM email_bounces WHERE normalized_email = $1`, [email]);
}

/** Each report is a stored, dated message: replay safety and rate windows need its identity. */
async function reportMessage(accountId: string | null, receivedAt = new Date()): Promise<string> {
  const id = crypto.randomUUID();
  messageIds.push(id);
  await db.query(
    `INSERT INTO messages (id, account_id, direction, source, from_email, received_at)
     VALUES ($1, $2, 'inbound', 'imap', $3, $4)`,
    [id, accountId, `mailer-daemon-${RUN}@mx.example.test`, receivedAt.toISOString()],
  );
  return id;
}

beforeAll(async () => {
  // AUTO_MIGRATE is on in tests, so opening the database applies 024 before anything looks at it.
  db = await getDb();
});

afterAll(async () => {
  await db.query(`DELETE FROM email_bounces WHERE normalized_email LIKE $1 OR message_id = ANY($2::uuid[])`, [`%-${RUN}@%`, messageIds]);
  for (const id of messageIds) await db.query(`DELETE FROM messages WHERE id = $1`, [id]);
  await db.query(`DELETE FROM suppressions WHERE normalized_email LIKE $1`, [`%-${RUN}@%`]);
  await db.query(`DELETE FROM outbound_sends WHERE account_id = ANY($1::uuid[])`, [accountIds]);
  for (const id of prospectIds) await db.query(`DELETE FROM prospects WHERE id = $1`, [id]);
  for (const id of accountIds) await db.query(`DELETE FROM email_accounts WHERE id = $1`, [id]);
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

describe("a permanent bounce becomes a suppression", () => {
  it("suppresses the address and records why", async () => {
    const accountId = await createAccount("perm");
    const email = `gone-${RUN}@example.test`;
    await seedRecipient(email);

    const result = await recordBounceIfAny({
      accountId,
      messageDbId: await reportMessage(accountId),
      fromEmail: `MAILER-DAEMON-${RUN}@mx.example.test`,
      subject: "Undelivered Mail Returned to Sender",
      bodyText: `Final-Recipient: rfc822; ${email}\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 user unknown`,
    });

    expect(result.isBounce).toBe(true);
    expect(result.kind).toBe("permanent");
    expect(result.recipient).toBe(email);
    expect(result.action).toBe("suppressed");

    const suppressed = await db.query<{ reason: string; active: boolean; note: string | null }>(
      `SELECT reason, active, note FROM suppressions WHERE normalized_email = $1`,
      [email],
    );
    expect(suppressed.rows).toHaveLength(1);
    expect(suppressed.rows[0].reason).toBe("bounce");
    expect(suppressed.rows[0].active).toBe(true);
    expect(suppressed.rows[0].note).toMatch(/5\.1\.1/);

    const logged = await db.query<{ kind: string; action: string }>(
      `SELECT kind, action FROM email_bounces WHERE normalized_email = $1`,
      [email],
    );
    expect(logged.rows).toEqual([{ kind: "permanent", action: "suppressed" }]);
  });

  it("suppresses an abuse complaint as its own reason", async () => {
    const email = `complaint-${RUN}@example.test`;
    await seedRecipient(email);
    const result = await recordBounceIfAny({
      accountId: null,
      messageDbId: await reportMessage(null),
      fromEmail: `staff-${RUN}@abuse.example.test`,
      subject: "Abuse report",
      bodyText: `Original-Recipient: rfc822; ${email}`,
      contentType: "multipart/report; report-type=feedback-report",
    });
    expect(result.kind).toBe("complaint");
    const row = await db.query<{ reason: string }>(
      `SELECT reason FROM suppressions WHERE normalized_email = $1`,
      [email],
    );
    expect(row.rows[0].reason).toBe("complaint");
  });
});

describe("a soft bounce is retried, then suppressed", () => {
  it("waits for three transient reports before it stops contact", async () => {
    const email = `soft-${RUN}@example.test`;
    await seedRecipient(email);
    // Three distinct reports. A replay of the same report would not count again.
    const report = async (status: string) => ({
      accountId: null,
      messageDbId: await reportMessage(null),
      fromEmail: `postmaster-${RUN}@mx.example.test`,
      subject: "Delivery Status Notification (Delay)",
      bodyText: `Final-Recipient: rfc822; ${email}\nAction: delayed\nStatus: ${status}`,
    });

    const first = await recordBounceIfAny(await report("4.2.2"));
    expect(first.action).toBe("retried");
    expect(await countPriorSoftBounces(email)).toBe(1);
    const afterOne = await db.query(`SELECT 1 FROM suppressions WHERE normalized_email = $1`, [email]);
    expect(afterOne.rows).toHaveLength(0);

    const second = await recordBounceIfAny(await report("4.2.2"));
    expect(second.action).toBe("retried");
    const afterTwo = await db.query(`SELECT 1 FROM suppressions WHERE normalized_email = $1`, [email]);
    expect(afterTwo.rows).toHaveLength(0);

    // The third is the one that ends it, and it keeps the soft-bounce history that explains why.
    const third = await recordBounceIfAny(await report("4.2.2"));
    expect(third.action).toBe("suppressed");
    const afterThree = await db.query<{ reason: string }>(
      `SELECT reason FROM suppressions WHERE normalized_email = $1`,
      [email],
    );
    expect(afterThree.rows[0].reason).toBe("bounce");
    expect(await countPriorSoftBounces(email)).toBe(3);
  });

  it("does not overwrite a suppression that already exists", async () => {
    const email = `already-${RUN}@example.test`;
    await seedRecipient(email);
    await db.query(
      `INSERT INTO suppressions (id, normalized_email, email, reason, source, note)
       VALUES (gen_random_uuid(), $1, $1, 'unsubscribe', 'founder', 'asked on the phone')`,
      [email],
    );
    await recordBounceIfAny({
      accountId: null,
      messageDbId: null,
      fromEmail: `mailer-daemon-${RUN}@mx.example.test`,
      subject: "Undelivered Mail Returned to Sender",
      bodyText: `Final-Recipient: rfc822; ${email}\nStatus: 5.1.1`,
    });
    const row = await db.query<{ reason: string; note: string }>(
      `SELECT reason, note FROM suppressions WHERE normalized_email = $1`,
      [email],
    );
    // The first reason recorded is the one that explains why contact stopped.
    expect(row.rows[0].reason).toBe("unsubscribe");
    expect(row.rows[0].note).toBe("asked on the phone");
  });
});

describe("ordinary mail is never treated as a bounce", () => {
  it("answers isBounce false and writes nothing", async () => {
    const before = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM email_bounces`);
    const result = await recordBounceIfAny({
      accountId: null,
      messageDbId: null,
      fromEmail: `prospect-${RUN}@example.test`,
      subject: "Re: your message",
      bodyText: "Thanks, not interested.",
    });
    expect(result.isBounce).toBe(false);
    const after = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM email_bounces`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe("a profile pauses itself when its bounce rate is too high", () => {
  async function seedSends(accountId: string, count: number, bounced: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      // The address carries the account id: a bounce is a fact about an address, so two accounts
      // sharing one fixture address would count each other's bounces.
      const recipient = `send-${index}-${accountId.slice(0, 8)}-${RUN}@example.test`;
      await db.query(
        `INSERT INTO outbound_sends (id, account_id, idempotency_key, status, recipient_email, completed_at)
         VALUES (gen_random_uuid(), $1, $2, 'accepted', $3, now() - ($4 || ' minutes')::interval)`,
        [accountId, `${RUN}-${accountId}-${index}`, recipient, String(index)],
      );
      if (index < bounced) {
        await seedRecipient(recipient);
        await db.query(
          `INSERT INTO email_bounces (id, account_id, message_id, normalized_email, kind, action)
           VALUES (gen_random_uuid(), $1, $3, $2, 'permanent', 'suppressed')`,
          [accountId, recipient, await reportMessage(accountId)],
        );
      }
    }
  }

  it("counts the last 50 sends and pauses above 3%", async () => {
    const accountId = await createAccount("pause");
    await seedSends(accountId, 50, 2); // 4%

    const rate = await bounceRateForAccount(accountId);
    expect(rate.sends).toBe(50);
    expect(rate.bounces).toBe(2);
    expect(rate.exceeded).toBe(true);

    expect(await pauseProfileIfBouncing(accountId)).toBe(true);
    const state = await getBouncePauseState(accountId);
    expect(state.paused).toBe(true);
    expect(state.note).toMatch(/4\.0%/);
    expect(state.pausedAt).not.toBeNull();
  });

  it("leaves a profile alone below the limit", async () => {
    const accountId = await createAccount("healthy");
    await seedSends(accountId, 50, 1); // 2%
    expect(await pauseProfileIfBouncing(accountId)).toBe(false);
    const state = await getBouncePauseState(accountId);
    expect(state.paused).toBe(false);
  });

  it("does not judge a mailbox that has sent fewer than 50", async () => {
    const accountId = await createAccount("warmup");
    await seedSends(accountId, 5, 2); // 40% of a tiny sample
    expect(await pauseProfileIfBouncing(accountId)).toBe(false);
  });

  it("resumes only by hand, and only from a bounce pause", async () => {
    const accountId = await createAccount("resume");
    await db.query(`UPDATE email_accounts SET status = 'paused_bounce' WHERE id = $1`, [accountId]);
    await resumeFromBouncePause(accountId);
    const state = await getBouncePauseState(accountId);
    expect(state.paused).toBe(false);

    await expect(resumeFromBouncePause(accountId)).rejects.toThrow(/not paused/i);
  });

  it("is refused by the send gate with its own code", async () => {
    const accountId = await createAccount("gate", "paused_bounce");
    const { assertAccountCanSend } = await import("@/lib/services/email-sending");
    await expect(assertAccountCanSend(accountId)).rejects.toMatchObject({
      code: "bounce_rate_paused",
    });
  });
});

describe("the migration is recorded and the schema it adds is present", () => {
  it("exists as its own file and is applied by the runner", () => {
    const sql = readFileSync("src/db/migrations/024_email_bounces.sql", "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS email_bounces");
    expect(sql).toContain("paused_bounce");
    expect(sql).toContain("sent_copy_saved_at");
    // Append-only and safe to re-run: every statement guards itself.
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS");
  });

  it("has the table and the widened status check in the live schema", async () => {
    const table = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
                       WHERE table_name = 'email_bounces') AS exists`,
    );
    expect(table.rows[0].exists).toBe(true);
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'messages' AND column_name = 'sent_copy_saved_at'`,
    );
    expect(columns.rows).toHaveLength(1);
    const check = await db.query<{ condef: string }>(
      `SELECT pg_get_constraintdef(oid) AS condef FROM pg_constraint
        WHERE conname = 'email_accounts_status_check'`,
    );
    expect(check.rows[0].condef).toContain("paused_bounce");
  });
});