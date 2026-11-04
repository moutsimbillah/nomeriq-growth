import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { deterministicReply } from "@/lib/ai/reply";
import { createEmailAccount, getEmailAccountRecord, updateEmailAccount } from "@/lib/email/accounts";
import { sendDraft } from "@/lib/services/email-sending";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import type { ProspectDetail } from "@/lib/types";

/**
 * The signature the founder actually sees on a sent email: a profile's own, added at send, once.
 *
 * A draft body ends at "Best," by rule, so the send is where the sign-off is attached — which is also
 * why this cannot be tested by looking at the draft.
 */

const created = { accounts: [] as string[], prospects: [] as string[] };
let seq = 0;
let userId = "";

async function newAccount(signature: string): Promise<string> {
  seq += 1;
  const account = await createEmailAccount(
    {
      provider: "sandbox",
      emailAddress: `signature-${seq}-${Date.now()}@example.test`,
      fromName: `Signature ${seq}`,
      name: `Signature ${seq}`,
      dailySendLimit: 100,
      minIntervalSeconds: 5,
      signature,
    },
    userId,
  );
  created.accounts.push(account.id);
  return account.id;
}

async function newProspectWithDraft(body: string): Promise<{ prospectId: string; draftId: string }> {
  const db = await getDb();
  seq += 1;
  const recipient = `recipient-${seq}-${Date.now()}@signature.example`;
  const prospect = await db.query<{ id: string }>(
    `INSERT INTO prospects (id, business_name, name_key, created_by_type)
     VALUES (gen_random_uuid(), $1, $2, 'founder')
     RETURNING id`,
    [`Signature Co ${seq}`, `signature-co-${seq}-${Date.now()}`],
  );
  const prospectId = prospect.rows[0].id;
  created.prospects.push(prospectId);
  await db.query(
    `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type)
     VALUES (gen_random_uuid(), $1, $2, $2, 'https://signature.example', 'official_website')`,
    [prospectId, recipient],
  );
  const draft = await db.query<{ id: string }>(
    `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
                         ai_generated, warnings, created_by_type, approved_at)
     VALUES (gen_random_uuid(), $1, 'first_contact', 0, 'approved', 'A question about your signals',
             $2, $3, false, '[]'::jsonb, 'founder', now())
     RETURNING id`,
    [prospectId, body, recipient],
  );
  return { prospectId, draftId: draft.rows[0].id };
}

beforeAll(async () => {
  const db = await getDb();
  await ensureWorkspaceDefaults();
  userId = crypto.randomUUID();
  await db.query(
    `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
     VALUES ($1, $2, $3, $4, $5, 'founder')`,
    [
      userId,
      "signature@test.nomeriq.com",
      "signature@test.nomeriq.com",
      "Signature Founder",
      hashPassword("TestPassw0rd!123"),
    ],
  );
});
afterAll(async () => {
  const db = await getDb();
  for (const id of created.prospects) await db.query(`DELETE FROM prospects WHERE id = $1`, [id]);
  for (const id of created.accounts) await db.query(`DELETE FROM email_accounts WHERE id = $1`, [id]);
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

describe("the sending profile's signature", () => {
  it("is added at send, and it is the profile's own, not the workspace's", async () => {
    const accountId = await newAccount("Regards,\nProfile One");
    const { draftId } = await newProspectWithDraft("Hello, I noticed you sell paid signals.\n\nBest,");

    const outcome = await sendDraft({ draftId, accountId, actorUserId: "signature-test" });
    if ("queued" in outcome) throw new Error("expected a send, not a queued hold");

    const db = await getDb();
    const message = await db.query<{ body_text: string }>(
      `SELECT body_text FROM messages WHERE draft_id = $1`,
      [draftId],
    );
    expect(message.rows[0].body_text).toContain("Best,\n\nRegards,\nProfile One");
    // the workspace default never crept in
    expect(message.rows[0].body_text).not.toContain("Founder\nNomeriq");
  });

  it("is never added twice when the body already ends with it", async () => {
    const accountId = await newAccount("Regards,\nProfile Two");
    const body = "Hello, I noticed you sell paid signals.\n\nBest,\n\nRegards,\nProfile Two";
    const { draftId } = await newProspectWithDraft(body);

    const outcome = await sendDraft({ draftId, accountId, actorUserId: "signature-test" });
    if ("queued" in outcome) throw new Error("expected a send, not a queued hold");

    const db = await getDb();
    const message = await db.query<{ body_text: string }>(
      `SELECT body_text FROM messages WHERE draft_id = $1`,
      [draftId],
    );
    const occurrences = message.rows[0].body_text.split("Regards,\nProfile Two").length - 1;
    expect(occurrences).toBe(1);
  });

  it("keeps a signature and a warm-up start through create and update", async () => {
    const accountId = await newAccount("First signature");
    const created = await getEmailAccountRecord(accountId);
    expect(created?.signature).toBe("First signature");
    expect(created?.warmupStartedAt).toBeNull();

    const started = new Date(Date.now() - 86_400_000).toISOString();
    await updateEmailAccount(accountId, { signature: "Second signature", warmupStartedAt: started });
    const updated = await getEmailAccountRecord(accountId);
    expect(updated?.signature).toBe("Second signature");
    expect(updated?.warmupStartedAt).not.toBeNull();
  });

  it("signs a reply suggestion the same way", () => {
    const prospect = { id: "p1", contactEmail: "hello@example.test" } as unknown as ProspectDetail;
    const settings = { senderSignature: "Founder\nNomeriq" } as never;
    const signed = deterministicReply({
      prospect,
      classification: "pricing",
      lastInbound: null,
      settings,
      signature: "Regards,\nProfile Three",
    });
    expect(signed.body).toContain("Best,\nRegards,\nProfile Three");
    expect(signed.body).not.toContain("Founder\nNomeriq");

    // and with no profile signature, the workspace value is what it always was
    const workspaceOnly = deterministicReply({
      prospect,
      classification: "pricing",
      lastInbound: null,
      settings,
      signature: "  ",
    });
    expect(workspaceOnly.body).toContain("Founder\nNomeriq");
  });
});
