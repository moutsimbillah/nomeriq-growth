import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import {
  changeSendingProfile,
  pinSendingProfile,
  profileSignature,
  resolvePinnedProfile,
  resolveSendingProfile,
  warmupDailyLimit,
  WARMUP_DAILY_STEP,
} from "@/lib/email/profiles";
import { assertAccountCanSend, sendDraft } from "@/lib/services/email-sending";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * Sending profiles: which mailbox a lead is emailed from, and the rules around it.
 *
 * Each case builds its own mailbox — limits and minimum intervals are per mailbox, so two cases sharing
 * one account would be testing the shared counter rather than the change.
 */

const created = { accounts: [] as string[], prospects: [] as string[] };
let seq = 0;

async function newAccount(
  options: {
    isDefault?: boolean;
    limit?: number;
    interval?: number;
    warmupDaysAgo?: number | null;
    signature?: string;
  } = {},
): Promise<string> {
  const db = await getDb();
  seq += 1;
  const email = `profile-${seq}-${Date.now()}@example.test`;
  const row = await db.query<{ id: string }>(
    `INSERT INTO email_accounts (id, name, provider, email_address, normalized_email, from_name,
                                 status, daily_send_limit, min_interval_seconds, is_default, signature,
                                 warmup_started_at)
     VALUES (gen_random_uuid(), $1, 'sandbox', $2, $2, $1, 'connected', $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      `Profile ${seq}`,
      email,
      options.limit ?? 100,
      options.interval ?? 5,
      options.isDefault ?? false,
      options.signature ?? "",
      options.warmupDaysAgo == null
        ? null
        : new Date(Date.now() - options.warmupDaysAgo * 86_400_000).toISOString(),
    ],
  );
  created.accounts.push(row.rows[0].id);
  return row.rows[0].id;
}

async function newProspect(profileId: string | null = null): Promise<string> {
  const db = await getDb();
  seq += 1;
  const row = await db.query<{ id: string }>(
    `INSERT INTO prospects (id, business_name, name_key, created_by_type, sending_profile_id)
     VALUES (gen_random_uuid(), $1, $2, 'founder', $3)
     RETURNING id`,
    [`Profile Test ${seq}`, `profile-test-${seq}-${Date.now()}`, profileId],
  );
  created.prospects.push(row.rows[0].id);
  return row.rows[0].id;
}

async function newConversation(prospectId: string, profileId: string | null = null): Promise<string> {
  const db = await getDb();
  const row = await db.query<{ id: string }>(
    `INSERT INTO conversations (id, prospect_id, subject, sending_profile_id)
     VALUES (gen_random_uuid(), $1, 'A question about your signal service', $2)
     RETURNING id`,
    [prospectId, profileId],
  );
  return row.rows[0].id;
}

async function addVerifiedEmail(prospectId: string, email: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type)
     VALUES (gen_random_uuid(), $1, $2, $2, $3, 'official_website')`,
    [prospectId, email, `https://${email.split("@")[1]}`],
  );
}

async function addAcceptedSend(accountId: string, index: number): Promise<void> {
  const db = await getDb();
  const prospectId = await newProspect();
  const draft = await db.query<{ id: string }>(
    `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
                         ai_generated, warnings, created_by_type)
     VALUES (gen_random_uuid(), $1, 'follow_up', $2, 'sent', 'Subject', 'Body', 'a@b.test',
             false, '[]'::jsonb, 'founder')
     RETURNING id`,
    [prospectId, index],
  );
  await db.query(
    `INSERT INTO outbound_sends (id, draft_id, account_id, recipient_email, subject, idempotency_key,
                                 status, completed_at)
     VALUES (gen_random_uuid(), $1, $2, 'a@b.test', 'Subject', $3, 'accepted', now())`,
    [draft.rows[0].id, accountId, `profile-test-key-${index}-${Date.now()}`],
  );
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
});
afterAll(async () => {
  const db = await getDb();
  for (const id of created.prospects) await db.query(`DELETE FROM prospects WHERE id = $1`, [id]);
  for (const id of created.accounts) await db.query(`DELETE FROM email_accounts WHERE id = $1`, [id]);
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

describe("sending profiles", () => {
  it("resolves the lead's profile, then the thread's, then the default", async () => {
    const fallback = await newAccount({ isDefault: true });
    const pinned = await newAccount({ isDefault: false });

    // the lead has its own profile: it wins even though it is not the default
    const withPin = await newProspect(pinned);
    expect((await resolvePinnedProfile({ prospectId: withPin }))?.id).toBe(pinned);
    expect((await resolveSendingProfile({ prospectId: withPin }))?.id).toBe(pinned);

    // no lead profile, but the thread has one
    const threadOnly = await newProspect(null);
    const conversation = await newConversation(threadOnly, pinned);
    expect((await resolvePinnedProfile({ prospectId: threadOnly, conversationId: conversation }))?.id).toBe(
      pinned,
    );

    // neither: nothing is pinned, and the default account is what a new lead would use
    const brandNew = await newProspect(null);
    expect(await resolvePinnedProfile({ prospectId: brandNew })).toBeNull();
    expect((await resolveSendingProfile({ prospectId: brandNew }))?.id).toBe(fallback);
  });

  it("pins a lead and its thread once, and never moves them again", async () => {
    const first = await newAccount();
    const second = await newAccount();
    const prospectId = await newProspect(null);
    const conversationId = await newConversation(prospectId, null);

    await pinSendingProfile({ prospectId, conversationId, accountId: first });

    const db = await getDb();
    const pinned = await db.query<{ sending_profile_id: string; sending_profile_pinned_at: string | null }>(
      `SELECT sending_profile_id, sending_profile_pinned_at FROM prospects WHERE id = $1`,
      [prospectId],
    );
    expect(pinned.rows[0].sending_profile_id).toBe(first);
    expect(pinned.rows[0].sending_profile_pinned_at).not.toBeNull();
    const thread = await db.query<{ sending_profile_id: string }>(
      `SELECT sending_profile_id FROM conversations WHERE id = $1`,
      [conversationId],
    );
    expect(thread.rows[0].sending_profile_id).toBe(first);

    // the first send wins: a later pin attempt must not move the lead or its thread
    await pinSendingProfile({ prospectId, conversationId, accountId: second });
    const after = await db.query<{ sending_profile_id: string }>(
      `SELECT sending_profile_id FROM prospects WHERE id = $1`,
      [prospectId],
    );
    expect(after.rows[0].sending_profile_id).toBe(first);
    const threadAfter = await db.query<{ sending_profile_id: string }>(
      `SELECT sending_profile_id FROM conversations WHERE id = $1`,
      [conversationId],
    );
    expect(threadAfter.rows[0].sending_profile_id).toBe(first);
  });

  it("allows the founder's one-click change until the lead has been emailed, then refuses it", async () => {
    const chosen = await newAccount();
    const other = await newAccount();
    const prospectId = await newProspect(null);

    await changeSendingProfile({ prospectId, accountId: chosen });
    const db = await getDb();
    const before = await db.query<{ sending_profile_id: string }>(
      `SELECT sending_profile_id FROM prospects WHERE id = $1`,
      [prospectId],
    );
    expect(before.rows[0].sending_profile_id).toBe(chosen);

    await pinSendingProfile({ prospectId, accountId: chosen });
    await expect(changeSendingProfile({ prospectId, accountId: other })).rejects.toMatchObject({
      code: "profile_pinned",
    });
    const after = await db.query<{ sending_profile_id: string }>(
      `SELECT sending_profile_id FROM prospects WHERE id = $1`,
      [prospectId],
    );
    expect(after.rows[0].sending_profile_id).toBe(chosen);
  });

  it("ramps the daily limit during warm-up, per profile", async () => {
    const now = new Date("2026-11-05T09:00:00.000Z");
    const day = 86_400_000;

    // pure ramp: nothing set means the profile's own limit
    expect(warmupDailyLimit(50, null, now)).toBe(50);
    expect(warmupDailyLimit(50, now, now)).toBe(WARMUP_DAILY_STEP);
    expect(warmupDailyLimit(50, new Date(now.getTime() - day), now)).toBe(WARMUP_DAILY_STEP * 2);
    expect(warmupDailyLimit(50, new Date(now.getTime() - 2 * day), now)).toBe(WARMUP_DAILY_STEP * 3);
    // it can never exceed the profile's own limit, and never falls below one send
    expect(warmupDailyLimit(7, new Date(now.getTime() - 30 * day), now)).toBe(7);
    expect(warmupDailyLimit(50, new Date(now.getTime() + day), now)).toBe(WARMUP_DAILY_STEP);
    expect(warmupDailyLimit(0, new Date(now.getTime() - 30 * day), now)).toBe(1);

    // and the limit the gate actually enforces follows the ramp
    const warmingUp = await newAccount({ limit: 10, warmupDaysAgo: 0 });
    for (let index = 1; index <= WARMUP_DAILY_STEP; index += 1) {
      await addAcceptedSend(warmingUp, index);
    }
    await expect(assertAccountCanSend(warmingUp)).rejects.toMatchObject({ code: "daily_limit_reached" });
    let refusal: Error | null = null;
    try {
      await assertAccountCanSend(warmingUp);
    } catch (error) {
      refusal = error as Error;
    }
    expect(refusal?.message).toContain(`${WARMUP_DAILY_STEP} sends per rolling 24 hours`);
    expect(refusal?.message).toContain("warming up");

    // the same profile, four days in, allows its full limit again
    const db = await getDb();
    await db.query(`UPDATE email_accounts SET warmup_started_at = now() - interval '4 days' WHERE id = $1`, [
      warmingUp,
    ]);
    await expect(assertAccountCanSend(warmingUp)).resolves.toBeUndefined();

    // a different profile's sends never count against it
    const other = await newAccount({ limit: 10, warmupDaysAgo: 0 });
    await addAcceptedSend(other, 99);
    await expect(assertAccountCanSend(other)).resolves.toBeUndefined();
  });

  it("prefers the profile's own signature and falls back to the workspace one", () => {
    expect(profileSignature("Best,\nFounder\nNomeriq", "Workspace")).toBe("Best,\nFounder\nNomeriq");
    expect(profileSignature("  Best,\nFounder  ", "Workspace")).toBe("Best,\nFounder");
    expect(profileSignature("", "Workspace")).toBe("Workspace");
    expect(profileSignature("   ", "Workspace")).toBe("Workspace");
  });

  it("ties the lead and its thread to the profile that actually sends", async () => {
    const accountId = await newAccount({ limit: 100, interval: 5 });
    const prospectId = await newProspect(null);
    const recipient = `sent-${Date.now()}@profile-send.example`;
    await addVerifiedEmail(prospectId, recipient);
    const db = await getDb();
    const draft = await db.query<{ id: string }>(
      `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
                           ai_generated, warnings, created_by_type, approved_at)
       VALUES (gen_random_uuid(), $1, 'first_contact', 0, 'approved', 'A question about your signals',
               'Hello, I noticed you sell paid trading signals and wanted to ask how access works.',
               $2, false, '[]'::jsonb, 'founder', now())
       RETURNING id`,
      [prospectId, recipient],
    );
    const draftId = draft.rows[0].id;

    const outcome = await sendDraft({ draftId, accountId, actorUserId: "sending-profiles-test" });
    if ("queued" in outcome) throw new Error("expected a send, not a queued hold");

    const prospect = await db.query<{ sending_profile_id: string; sending_profile_pinned_at: string | null }>(
      `SELECT sending_profile_id, sending_profile_pinned_at FROM prospects WHERE id = $1`,
      [prospectId],
    );
    expect(prospect.rows[0].sending_profile_id).toBe(accountId);
    expect(prospect.rows[0].sending_profile_pinned_at).not.toBeNull();

    const message = await db.query<{ account_id: string; conversation_id: string }>(
      `SELECT account_id, conversation_id FROM messages WHERE draft_id = $1`,
      [draftId],
    );
    expect(message.rows[0].account_id).toBe(accountId);
    const thread = await db.query<{ sending_profile_id: string }>(
      `SELECT sending_profile_id FROM conversations WHERE id = $1`,
      [message.rows[0].conversation_id],
    );
    expect(thread.rows[0].sending_profile_id).toBe(accountId);

    // and once emailed, the lead's profile can no longer be changed
    const other = await newAccount();
    await expect(changeSendingProfile({ prospectId, accountId: other })).rejects.toMatchObject({
      code: "profile_pinned",
    });
  });
});
