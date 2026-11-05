import { getDb } from "@/lib/db/client";
import { DEFAULT_TIMEZONE, calendarDaysBetween } from "@/lib/dates/timezone";
import { getDefaultEmailAccount, getEmailAccountRecord, type EmailAccountRecord } from "@/lib/email/accounts";
import { AppError } from "@/lib/utils";

/**
 * Sending profiles.
 *
 * A profile is an email account used as an identity: its own display name, signature, reply-to, daily
 * limit and warm-up. Every lead is tied to the profile that first emailed it, so its follow-ups and
 * replies keep coming from the same address and stay in the same thread — the plan's "a prospect never
 * hears from two addresses".
 *
 * Resolution order is fixed and short: the lead's own profile, then its conversation's, then the
 * default account for anything new. A pinned profile always wins, even when it is no longer the
 * default — otherwise changing the default would silently move every lead already in flight.
 */

/** A minimal runner, so the pin can join the transaction that writes the message row. */
export interface QueryRunner {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** The warm-up ramp: this many sends on day one, adding the same again each full day, up to the cap. */
export const WARMUP_DAILY_STEP = 5;

/**
 * The figure a profile's daily limit is measured against today.
 *
 * Pure on purpose: no clock is read inside, so the ramp can be tested without waiting for days to pass.
 * A profile with no warm-up start simply uses its own limit.
 */
export function warmupDailyLimit(
  limit: number,
  warmupStartedAt: Date | null,
  now: Date,
  timezone: string = DEFAULT_TIMEZONE,
): number {
  if (!warmupStartedAt) return limit;
  // A start in the future would otherwise produce a negative day count.
  const wholeDaysElapsed = Math.max(0, calendarDaysBetween(warmupStartedAt, now, timezone));
  const ramped = WARMUP_DAILY_STEP * (1 + wholeDaysElapsed);
  return Math.max(1, Math.min(limit, ramped));
}

/** The profile's own signature when it has one; otherwise the workspace-wide value, unchanged. */
export function profileSignature(
  profileSignatureValue: string,
  workspaceSignature: string,
): string {
  const trimmed = (profileSignatureValue ?? "").trim();
  return trimmed || workspaceSignature;
}

async function prospectProfileId(prospectId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.query<{ sending_profile_id: string | null }>(
    `SELECT sending_profile_id FROM prospects WHERE id = $1 AND archived_at IS NULL`,
    [prospectId],
  );
  return row.rows[0]?.sending_profile_id ?? null;
}

async function conversationProfileId(conversationId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.query<{ sending_profile_id: string | null }>(
    `SELECT sending_profile_id FROM conversations WHERE id = $1`,
    [conversationId],
  );
  return row.rows[0]?.sending_profile_id ?? null;
}

/** The lead's pinned profile, or its conversation's. Null when neither is set. */
export async function resolvePinnedProfile(input: {
  prospectId: string;
  conversationId?: string | null;
}): Promise<EmailAccountRecord | null> {
  const pinned = await prospectProfileId(input.prospectId);
  if (pinned) {
    const record = await getEmailAccountRecord(pinned);
    if (record) return record;
  }
  if (input.conversationId) {
    const fromConversation = await conversationProfileId(input.conversationId);
    if (fromConversation) {
      const record = await getEmailAccountRecord(fromConversation);
      if (record) return record;
    }
  }
  return null;
}

/**
 * Which profile an email to this lead goes out from, for anything that has to *show* the answer:
 * the pin when there is one, otherwise the default account. Null when no account exists at all.
 *
 * The send path is stricter — it lets an explicit choice stand in place of the default until the lead
 * is pinned — so it calls resolvePinnedProfile itself. Never throws for "nothing configured": the
 * caller decides what to tell the founder.
 */
export async function resolveSendingProfile(input: {
  prospectId: string;
  conversationId?: string | null;
}): Promise<EmailAccountRecord | null> {
  const pinned = await resolvePinnedProfile(input);
  if (pinned) return pinned;
  return (await getDefaultEmailAccount(true)) ?? null;
}

/**
 * Pins the profile that a lead and its conversation have just been emailed from.
 *
 * Only fills a blank: the first successful send wins, and calling it again never moves a lead that is
 * already pinned. Pass the send's transaction so the pin and the message row commit together, or a
 * message could exist with no record of which mailbox produced it.
 */
export async function pinSendingProfile(
  input: { prospectId: string; conversationId?: string | null; accountId: string },
  runner?: QueryRunner,
): Promise<void> {
  const db = await getDb();
  const run = runner ?? db;
  await run.query(
    `UPDATE prospects SET
       sending_profile_id = coalesce(sending_profile_id, $2),
       sending_profile_pinned_at = coalesce(sending_profile_pinned_at, now())
     WHERE id = $1`,
    [input.prospectId, input.accountId],
  );
  if (input.conversationId) {
    await run.query(
      `UPDATE conversations SET sending_profile_id = coalesce(sending_profile_id, $2)
       WHERE id = $1`,
      [input.conversationId, input.accountId],
    );
  }
}

/**
 * The founder's one-click change of a lead's profile.
 *
 * Refused once the lead has been emailed from the profile it is pinned to: the prospect has already
 * seen that address, and its replies are in that thread. The refusal is a plain error the interface
 * shows beside the pill, never a dialog.
 */
export async function changeSendingProfile(input: {
  prospectId: string;
  accountId: string;
}): Promise<void> {
  const db = await getDb();
  const pinned = await db.query<{ sending_profile_pinned_at: string | null }>(
    `SELECT sending_profile_pinned_at FROM prospects WHERE id = $1 AND archived_at IS NULL`,
    [input.prospectId],
  );
  if (!pinned.rows[0]) throw new AppError("Prospect not found.", 404, "prospect_not_found");
  if (pinned.rows[0].sending_profile_pinned_at) {
    throw new AppError(
      "This lead has already been emailed from its current profile, so it stays there — its replies are in that thread.",
      409,
      "profile_pinned",
    );
  }
  const account = await getEmailAccountRecord(input.accountId);
  if (!account) throw new AppError("Email account not found.", 404, "email_account_not_found");
  await db.query(`UPDATE prospects SET sending_profile_id = $2, updated_at = now() WHERE id = $1`, [
    input.prospectId,
    input.accountId,
  ]);
}
