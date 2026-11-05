import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import {
  getDefaultEmailAccount,
  listEmailAccounts,
  setDefaultEmailAccount,
  updateEmailAccount,
} from "@/lib/email/accounts";
import {
  changeSendingProfile,
  resolvePinnedProfile,
  resolveSendingProfile,
} from "@/lib/email/profiles";
import {
  NO_SENDER_LABEL,
  defaultSenderLabel,
  senderLabels,
  senderPillLabel,
} from "@/lib/email/senderPill";
import { getDraft } from "@/lib/services/drafts";
import { sendDraft } from "@/lib/services/email-sending";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { AppError } from "@/lib/utils";

/**
 * A mailbox is only ever the sender for the leads pinned to it.
 *
 * The defect this covers: the resolver sorted by is_default and then took the first row regardless, so
 * with one account in the table — moutsim@nomeriq.com, the import's own mailbox, which belongs only to
 * the leads the import pinned to it — every lead the import did NOT pin was shown, and could be sent
 * from, nomeriq.com. The fix: a default is an account whose is_default is true and nothing else, an
 * unpinned lead has no sender, and a first contact on an unpinned lead is refused instead of quietly
 * borrowing the only mailbox there is.
 */

const NOMERIQ = "moutsim@nomeriq.com";

const created = { accounts: [] as string[], prospects: [] as string[] };
let seq = 0;
/** The import's own mailbox, as the migration and the live database leave it: never the default. */
let moutsim = "";

/**
 * A mailbox as the live database has it: present, connected, and never the default. It is created by
 * direct insert, not by createEmailAccount, because that path promotes the first row to default — which
 * is exactly the behaviour under test.
 */
async function newAccount(
  options: {
    address?: string;
    neverDefault?: boolean;
    isDefault?: boolean;
    status?: string;
  } = {},
): Promise<string> {
  const db = await getDb();
  seq += 1;
  const address = options.address ?? `never-default-${seq}-${Date.now()}@example.test`;
  const row = await db.query<{ id: string }>(
    `INSERT INTO email_accounts (id, name, provider, email_address, normalized_email, from_name,
                                 status, daily_send_limit, min_interval_seconds, is_default, never_default)
     VALUES (gen_random_uuid(), $1, 'sandbox', $2, $2, $1, $3, 100, 5, $4, $5)
     RETURNING id`,
    [
      `Mailbox ${seq}`,
      address,
      options.status ?? "connected",
      options.isDefault ?? false,
      options.neverDefault ?? false,
    ],
  );
  created.accounts.push(row.rows[0].id);
  return row.rows[0].id;
}

async function newProspect(): Promise<string> {
  const db = await getDb();
  seq += 1;
  const row = await db.query<{ id: string }>(
    `INSERT INTO prospects (id, business_name, name_key, created_by_type)
     VALUES (gen_random_uuid(), $1, $2, 'founder')
     RETURNING id`,
    [`Never Default Co ${seq}`, `never-default-${seq}-${Date.now()}`],
  );
  created.prospects.push(row.rows[0].id);
  return row.rows[0].id;
}

async function addVerifiedEmail(prospectId: string, email: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type)
     VALUES (gen_random_uuid(), $1, $2, $2, $3, 'official_website')`,
    [prospectId, email, "https://never-default.example/contact"],
  );
}

async function newFirstContactDraft(prospectId: string, recipient: string): Promise<string> {
  const db = await getDb();
  const row = await db.query<{ id: string }>(
    `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
                         ai_generated, warnings, created_by_type, approved_at)
     VALUES (gen_random_uuid(), $1, 'first_contact', 0, 'approved', 'A question about your signals',
             'Hello, I noticed you sell paid trading signals and wanted to ask how access works.',
             $2, false, '[]'::jsonb, 'founder', now())
     RETURNING id`,
    [prospectId, recipient],
  );
  return row.rows[0].id;
}

/** The refusal a call produced, so its code, status and message can be read without a wrapper. */
async function refusalFrom(call: () => Promise<unknown>): Promise<AppError> {
  try {
    await call();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a refusal, but the call resolved");
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  // exactly one row for the address: the live database has the import's own mailbox, unconnected and
  // never the default, and normalized_email is unique
  moutsim = await newAccount({ address: NOMERIQ, neverDefault: true, status: "connected" });
});
afterAll(async () => {
  const db = await getDb();
  for (const id of created.prospects) await db.query(`DELETE FROM prospects WHERE id = $1`, [id]);
  for (const id of created.accounts) await db.query(`DELETE FROM email_accounts WHERE id = $1`, [id]);
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

describe("a mailbox is only the sender for the leads pinned to it", () => {
  it("resolves to no account at all while nothing is marked default", async () => {
    const db = await getDb();
    const prospectId = await newProspect();

    // nothing in the table is default, so there is no default — the import's mailbox is not promoted
    // into one merely by being the only non-disabled row
    const defaults = await db.query<{ id: string }>(
      `SELECT id FROM email_accounts WHERE is_default = true`,
    );
    expect(defaults.rows).toHaveLength(0);
    expect(await getDefaultEmailAccount()).toBeNull();
    expect(await getDefaultEmailAccount(true)).toBeNull();

    // the lead has no pin, so it has no sender: not null-vs-something, and specifically not nomeriq.com
    expect(await resolvePinnedProfile({ prospectId })).toBeNull();
    expect(await resolveSendingProfile({ prospectId })).toBeNull();
    const listed = (await listEmailAccounts()).find((row) => row.id === moutsim);
    expect(listed?.neverDefault).toBe(true);
    expect(listed?.isDefault).toBe(false);
  });

  it("shows 'No sender yet' for a lead with no pinned profile, never a domain", () => {
    // the shared label helper: a mailbox that may never be the default is not named as the sender an
    // unpinned lead would go out from
    expect(defaultSenderLabel({ emailAddress: NOMERIQ, neverDefault: true })).toBe(NO_SENDER_LABEL);
    // a genuine default is still named, with its domain — the old behaviour, kept
    expect(defaultSenderLabel({ emailAddress: "outreach@nomeriq.info" })).toBe("nomeriq.info · default");
    // and the pill renders what the caller composed, so the lead page's label is what shows
    expect(senderPillLabel({ id: null, label: NO_SENDER_LABEL })).toBe("No sender yet");
    expect(NO_SENDER_LABEL).not.toMatch(/default/i);
    expect(NO_SENDER_LABEL).not.toContain("nomeriq.com");
    // a lead pinned to the import's mailbox still names it
    expect(senderLabels([{ id: "abc", emailAddress: NOMERIQ }]).get("abc")).toBe("nomeriq.com");
    // the lead page uses that label for a lead with no pinned profile, and never the old fallback
    const page = readFileSync("src/app/(app)/leads/[id]/page.tsx", "utf8");
    expect(page).toContain("{ id: null, label: NO_SENDER_LABEL }");
    expect(page).not.toContain("defaultLabel");
  });

  it("refuses to make the import's mailbox the default, and nothing can un-mark it", async () => {
    const db = await getDb();

    // by the dedicated route
    await expect(setDefaultEmailAccount(moutsim)).rejects.toMatchObject({
      code: "never_default_account",
      status: 409,
    });
    const refusal = await refusalFrom(() => setDefaultEmailAccount(moutsim));
    expect(refusal.message).toContain(NOMERIQ);
    expect(refusal.message).toMatch(/imported leads/i);
    expect(refusal.message).toMatch(/never be the workspace default/i);

    // and by the ordinary update path
    await expect(updateEmailAccount(moutsim, { isDefault: true })).rejects.toMatchObject({
      code: "never_default_account",
    });
    const after = await db.query<{ is_default: boolean; never_default: boolean }>(
      `SELECT is_default, never_default FROM email_accounts WHERE id = $1`,
      [moutsim],
    );
    expect(after.rows[0].is_default).toBe(false);
    expect(after.rows[0].never_default).toBe(true);

    // the mark is not part of the update input at all, so nothing an update carries can clear it
    await updateEmailAccount(moutsim, { neverDefault: false } as never);
    const still = await db.query<{ never_default: boolean }>(
      `SELECT never_default FROM email_accounts WHERE id = $1`,
      [moutsim],
    );
    expect(still.rows[0].never_default).toBe(true);

    // it remains an ordinary profile in every other respect
    const renamed = await updateEmailAccount(moutsim, { fromName: "Moutsim" });
    expect(renamed.fromName).toBe("Moutsim");
    expect(renamed.neverDefault).toBe(true);
    expect(renamed.isDefault).toBe(false);
  });

  it("refuses a first contact on an unpinned lead, and sends once a profile is pinned", async () => {
    const db = await getDb();
    const prospectId = await newProspect();
    const recipient = `sent-${Date.now()}@never-default.example`;
    await addVerifiedEmail(prospectId, recipient);
    const draftId = await newFirstContactDraft(prospectId, recipient);

    // no pin and no explicit choice: refused with a typed reason, never sent by the only account there is
    await expect(sendDraft({ draftId, actorUserId: "never-default-test" })).rejects.toMatchObject({
      code: "no_sender_profile",
      status: 409,
    });
    const refusal = await refusalFrom(() => sendDraft({ draftId, actorUserId: "never-default-test" }));
    expect(refusal.message).toMatch(/no sending profile yet/i);
    expect(refusal.message).toMatch(/lead page/i);

    // nothing was sent, and nothing was left behind that would block a later attempt
    expect((await getDraft(draftId))?.status).toBe("approved");
    const ledger = await db.query(`SELECT 1 FROM outbound_sends WHERE draft_id = $1`, [draftId]);
    expect(ledger.rows).toHaveLength(0);
    const unspent = await db.query(`SELECT 1 FROM messages WHERE draft_id = $1`, [draftId]);
    expect(unspent.rows).toHaveLength(0);

    // the founder's explicit choice for this lead: pin it to the import's mailbox, and the send goes
    await changeSendingProfile({ prospectId, accountId: moutsim });
    const outcome = await sendDraft({ draftId, actorUserId: "never-default-test" });
    if ("queued" in outcome) throw new Error("expected a send, not a queued hold");
    expect(outcome.alreadySent).toBe(false);
    expect(outcome.accountEmail).toBe(NOMERIQ);

    const message = await db.query<{ account_id: string }>(
      `SELECT account_id FROM messages WHERE draft_id = $1`,
      [draftId],
    );
    expect(message.rows).toHaveLength(1);
    expect(message.rows[0].account_id).toBe(moutsim);
    expect((await getDraft(draftId))?.status).toBe("sent");
  });
});
