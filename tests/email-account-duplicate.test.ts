import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { createEmailAccount } from "@/lib/email/accounts";
import { hashPassword } from "@/lib/auth/password";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * The import creates moutsim@nomeriq.com as an account row with no password, and the founder connects
 * that same row later. A second account for the address would split the imported messages — the sync
 * matches them on (account_id, message_id) — so connecting must refuse it and say where to go.
 */

const ADDRESS = "moutsim@nomeriq.com";
let userId = "";
let importedAccountId = "";

beforeAll(async () => {
  const db = await getDb();
  await ensureWorkspaceDefaults();
  userId = crypto.randomUUID();
  await db.query(
    `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
     VALUES ($1, $2, $3, $4, $5, 'founder')`,
    [userId, "dup-account@test.nomeriq.com", "dup-account@test.nomeriq.com", "Dup Account", hashPassword("TestPassw0rd!123")],
  );

  // exactly what the importer will do: the profile exists, unconnected, already warmed, 15 a day
  const account = await db.query<{ id: string }>(
    `INSERT INTO email_accounts (id, name, provider, email_address, normalized_email, from_name,
                                 status, daily_send_limit, min_interval_seconds, is_default, signature,
                                 warmup_started_at, created_by)
     VALUES (gen_random_uuid(), 'Old portal (moutsim)', 'ionos', $1, $1, 'Moutasim Billah',
             'unverified', 15, 60, false, '', null, $2)
     RETURNING id`,
    [ADDRESS, userId],
  );
  importedAccountId = account.rows[0].id;
});

afterAll(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM email_accounts WHERE normalized_email = $1`, [ADDRESS]);
  await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

describe("connecting an address that already has a profile", () => {
  it("refuses to create a second account, and names the one to connect", async () => {
    const db = await getDb();
    let failure: { code?: string; status?: number; message?: string } | null = null;
    try {
      await createEmailAccount(
        {
          provider: "ionos",
          emailAddress: ADDRESS,
          fromName: "Moutasim Billah",
          smtpHost: "smtp.ionos.com",
          imapHost: "imap.ionos.com",
          username: ADDRESS,
          password: "a-password",
        },
        userId,
      );
    } catch (error) {
      failure = error as { code?: string; status?: number; message?: string };
    }

    expect(failure?.code).toBe("email_account_exists");
    expect(failure?.status).toBe(409);
    // the message has to tell the founder what to do, not just that it failed
    expect(failure?.message).toContain("Old portal (moutsim)");
    expect(failure?.message).toContain("Add its password");

    // and there is still exactly one row for that address — the import's
    const rows = await db.query<{ id: string; status: string; daily_send_limit: number }>(
      `SELECT id, status, daily_send_limit FROM email_accounts WHERE normalized_email = $1`,
      [ADDRESS],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].id).toBe(importedAccountId);
    expect(rows.rows[0].status).toBe("unverified");
    expect(rows.rows[0].daily_send_limit).toBe(15);
  });

  it("still allows a genuinely different address", async () => {
    const account = await createEmailAccount(
      {
        provider: "sandbox",
        emailAddress: "outreach@nomeriq.info",
        fromName: "Nomeriq Growth",
        name: "New outreach (nomeriq.info)",
      },
      userId,
    );
    expect(account.emailAddress).toBe("outreach@nomeriq.info");
    await getDb().then((db) => db.query(`DELETE FROM email_accounts WHERE id = $1`, [account.id]));
  });
});