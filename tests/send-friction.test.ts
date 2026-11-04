import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";

/**
 * The five sending changes:
 *
 *  1. no confirmation dialog — pressing Send sends
 *  2. an unconfirmed delivery counts as sent, with a note and nothing to resolve by hand
 *  3. a founder-typed recipient is allowed and saved as a founder-entered contact
 *  4. a replied follow-up still stops, and is cancelled automatically so nothing is left to tidy
 *  5. a too-soon send is held back and can go again, instead of being refused with an error
 *
 * The transport is stubbed so the uncertain path can be produced without an SMTP server.
 */

type Deliver = (...args: unknown[]) => Promise<unknown>;
const transport = vi.hoisted(() => ({ deliver: vi.fn<Deliver>() }));

vi.mock("@/lib/email/send-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send-provider")>();
  // the real transport by default; a single call is replaced where a test needs a failure
  transport.deliver.mockImplementation(actual.deliverEmail as unknown as Deliver);
  return { ...actual, deliverEmail: (...args: unknown[]) => transport.deliver(...args) };
});

import { closeDb, getDb } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { ensureWorkspaceDefaults, updateWorkspaceSettings } from "@/lib/services/settings";
import { createEmailAccount } from "@/lib/email/accounts";
import { EmailDeliveryError } from "@/lib/email/send-provider";
import { saveProspect } from "@/lib/services/prospects";
import { approveDraft, generateDraftForProspect, getDraft, saveDraft } from "@/lib/services/drafts";
import { sendDraft } from "@/lib/services/email-sending";
import type { Category } from "@/lib/types";

const state = {
  userId: "",
  slackAccountId: "",
  slowAccountId: "",
  prospectId: "",
  accounts: [] as string[],
};

/**
 * A mailbox of its own for each case. The minimum interval is per mailbox, so two sends on one
 * mailbox inside five seconds are held back by design — sharing an account across tests would make
 * them test the interval rather than the thing under test.
 */
async function newMailbox(minIntervalSeconds = 5): Promise<string> {
  const account = await createEmailAccount(
    {
      name: `Mailbox ${state.accounts.length + 1}`,
      provider: "sandbox",
      emailAddress: `mailbox-${state.accounts.length + 1}@send-friction.test`,
      fromName: "Send Test",
      dailySendLimit: 100,
      minIntervalSeconds,
      isDefault: true,
    },
    state.userId,
  );
  state.accounts.push(account.id);
  return account.id;
}

/** Editing a draft clears its approval on purpose, so a send after an edit has to approve again. */
async function approveAgain(draftId: string) {
  const draft = await getDraft(draftId);
  if (draft?.status === "draft") await approveDraft(draftId, state.userId);
}

function payload(name: string, domain: string, email: string) {
  return {
    businessName: name,
    websiteUrl: `https://${domain}`,
    categories: ["forex"] as Category[],
    signalDescription: `${name} sells paid trading signal subscriptions to retail traders.`,
    email,
    emailSourceType: "official_website" as const,
    emailSourceUrl: `https://${domain}/contact`,
    qualificationStatus: "verified" as const,
    evidenceSummary: "A paid signal service with a published contact address.",
    sources: [{ url: `https://${domain}/pricing`, label: "Official pricing page" }],
  };
}

async function freshDraft(name: string, domain: string, email: string): Promise<string> {
  const saved = await saveProspect({
    ...payload(name, domain, email),
    actorType: "seed",
    actorUserId: state.userId,
  });
  const draft = await generateDraftForProspect({
    prospectId: saved.prospect.id,
    actorType: "seed",
    actorUserId: state.userId,
  });
  await approveDraft(draft.id, state.userId);
  return draft.id;
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  const db = await getDb();
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
     VALUES (gen_random_uuid(), 'send-friction@local.test', 'send-friction@local.test', 'Send Test', $1, 'founder')
     RETURNING id`,
    [hashPassword("not-a-real-password")],
  );
  state.userId = user.rows[0].id;
  await updateWorkspaceSettings(
    {
      legalBusinessName: "Nomeriq",
      postalAddress: "1 Test Street, Test City",
      senderSignature: "Test Founder\nNomeriq",
      footerNote: "Test footer.",
      followUpMax: 2,
      followUpDelay1Days: 4,
      followUpDelay2Days: 7,
    },
    state.userId,
  );
  state.slackAccountId = await newMailbox(5);
  // a mailbox whose own minimum interval is an hour: every second send is "too soon"
  state.slowAccountId = await newMailbox(3600);

  const saved = await saveProspect({
    ...payload("Friction Test Co", "friction-test.example", "hello@friction-test.example"),
    actorType: "seed",
    actorUserId: state.userId,
  });
  state.prospectId = saved.prospect.id;
});

afterAll(async () => {
  // clean up only what this file made
  const db = await getDb();
  await db.query(`DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE prospect_id = $1)`, [state.prospectId]);
  await db.query(`DELETE FROM messages WHERE prospect_id = $1`, [state.prospectId]);
  await db.query(`DELETE FROM conversations WHERE prospect_id = $1`, [state.prospectId]);
  await db.query(`DELETE FROM outbound_sends WHERE prospect_id = $1`, [state.prospectId]);
  await db.query(`DELETE FROM drafts WHERE prospect_id = $1`, [state.prospectId]);
  await db.query(`DELETE FROM prospect_emails WHERE prospect_id = $1`, [state.prospectId]);
  await db.query(`DELETE FROM prospect_sources WHERE prospect_id = $1`, [state.prospectId]);
  await db.query(`DELETE FROM prospects WHERE id = $1`, [state.prospectId]);
  if (state.accounts.length) {
    await db.query(`DELETE FROM email_accounts WHERE id = ANY($1::uuid[])`, [state.accounts]);
  }
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

describe("1. sending is one action", () => {
  it("has no confirmation dialog on the send path", () => {
    const ui = readFileSync("src/components/lead-actions.tsx", "utf8");
    expect(ui).not.toContain("Send this email to a real prospect?");
    expect(ui).not.toContain("Record this as a sandbox send?");
    expect(ui).not.toContain("setConfirmOpen");
    // and the send button calls the send function directly
    const button = ui.slice(ui.indexOf('disabled={!!pending || !canSend}') - 400, ui.indexOf('disabled={!!pending || !canSend}'));
    expect(button).toContain("onClick={send}");
  });

  it("shows a note, not a wall, for a held-back or unconfirmed send", () => {
    const ui = readFileSync("src/components/lead-actions.tsx", "utf8");
    expect(ui).toContain("softNote");
    expect(ui).toContain("result?.queued");
    expect(ui).toContain("result?.deliveryUncertain");
  });
});

describe("2. an unconfirmed delivery counts as sent", () => {
  it("records the send, writes the message as uncertain, and asks nothing of the founder", async () => {
    const draftId = await freshDraft("Uncertain Co", "uncertain.example", "hello@uncertain.example");
    transport.deliver.mockImplementationOnce(() => {
      throw new EmailDeliveryError("Connection reset after sending", false);
    });

    const accountId = await newMailbox();
    const result = await sendDraft({ draftId, actorUserId: state.userId, accountId });
    expect("queued" in result).toBe(false);
    if ("queued" in result) return;
    expect(result.status).toBe("uncertain");
    expect(result.deliveryUncertain).toBe(true);
    expect(result.note).toMatch(/did not confirm delivery/i);

    const draft = await getDraft(draftId);
    expect(draft?.status).toBe("sent");

    const db = await getDb();
    const send = await db.query<{ status: string }>(`SELECT status FROM outbound_sends WHERE draft_id = $1`, [draftId]);
    expect(send.rows[0].status).toBe("uncertain");

    const messages = await db.query<{ delivery_status: string }>(
      `SELECT delivery_status FROM messages WHERE draft_id = $1`,
      [draftId],
    );
    expect(messages.rows).toHaveLength(1);
    expect(messages.rows[0].delivery_status).toBe("uncertain");
  });

  it("is idempotent: an uncertain send is never repeated", async () => {
    const draftId = await freshDraft("Uncertain Twice Co", "uncertain-twice.example", "hello@uncertain-twice.example");
    transport.deliver.mockImplementationOnce(() => {
      throw new EmailDeliveryError("Timed out", false);
    });
    const accountId = await newMailbox();
    const sent = await sendDraft({ draftId, actorUserId: state.userId, accountId });
    if ("queued" in sent) throw new Error("the first send should not have been held back");

    const again = await sendDraft({ draftId, actorUserId: state.userId, accountId });
    if ("queued" in again) throw new Error("expected an idempotent send");
    expect(again.alreadySent).toBe(true);
    expect(again.deliveryUncertain).toBe(true);

    const db = await getDb();
    const messages = await db.query(`SELECT 1 FROM messages WHERE draft_id = $1`, [draftId]);
    expect(messages.rows).toHaveLength(1);
  });

  it("still treats a definitive refusal as a failure", async () => {
    const draftId = await freshDraft("Refused Co", "refused.example", "hello@refused.example");
    transport.deliver.mockImplementationOnce(() => {
      throw new EmailDeliveryError("550 mailbox unavailable", true);
    });
    const accountId = await newMailbox();
    await expect(
      sendDraft({ draftId, actorUserId: state.userId, accountId }),
    ).rejects.toMatchObject({ code: "smtp_rejected" });

    const db = await getDb();
    const send = await db.query<{ status: string }>(`SELECT status FROM outbound_sends WHERE draft_id = $1`, [draftId]);
    expect(send.rows[0].status).toBe("failed");
    const messages = await db.query(`SELECT 1 FROM messages WHERE draft_id = $1`, [draftId]);
    expect(messages.rows).toHaveLength(0);
  });
});

describe("3. a founder-typed recipient", () => {
  it("is saved as a founder-entered contact when the founder edits the draft", async () => {
    const draftId = await freshDraft("Typed Recipient Co", "typed.example", "hello@typed.example");
    const typed = "founder.typed@typed.example";

    await saveDraft({
      id: draftId,
      subject: "A short question about your signal service",
      body: "Hi team, I noticed you sell paid signals and wanted to ask how you handle access today.",
      recipientEmail: typed,
      actorType: "founder",
      actorUserId: state.userId,
    });

    const db = await getDb();
    const row = await db.query<{ source_type: string }>(
      `SELECT source_type FROM prospect_emails WHERE normalized_email = $1`,
      [typed],
    );
    expect(row.rows[0]?.source_type).toBe("founder_entered");
  });

  it("keeps refusing an unverified recipient when the caller did not ask for one", async () => {
    // A draft whose recipient was never recorded — what a campaign or a tool would be holding. The
    // founder's own paths (save and approve) record a typed address, so this is built directly.
    const db = await getDb();
    const draft = await db.query<{ id: string }>(
      `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
                           ai_generated, warnings, created_by_type, approved_at)
       VALUES (gen_random_uuid(), $1, 'follow_up', 9, 'approved', 'A question about your signals',
               'Following up on my earlier note about signal access and how you handle subscribers.',
               'never-recorded@nowhere.example', false, '[]'::jsonb, 'founder', now())
       RETURNING id`,
      [state.prospectId],
    );
    const draftId = draft.rows[0].id;
    const accountId = await newMailbox();
    await expect(
      sendDraft({ draftId, actorUserId: state.userId, accountId }),
    ).rejects.toMatchObject({ code: "unverified_recipient" });

    // and a first-contact draft for a typed address goes through when the founder's own path asks for it
    const firstContact = await db.query<{ id: string }>(
      `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
                           ai_generated, warnings, created_by_type, approved_at)
       VALUES (gen_random_uuid(), $1, 'first_contact', 0, 'approved', 'A question about your signals',
               'Hello, I noticed you sell paid trading signals and wanted to ask how access works.',
               'typed-at-send@nowhere.example', false, '[]'::jsonb, 'founder', now())
       RETURNING id`,
      [state.prospectId],
    );
    const allowed = await sendDraft({
      draftId: firstContact.rows[0].id,
      actorUserId: state.userId,
      accountId,
      allowFounderRecipient: true,
    });
    if ("queued" in allowed) throw new Error("expected a send");
    const recorded = await db.query<{ source_type: string }>(
      `SELECT source_type FROM prospect_emails WHERE normalized_email = $1`,
      ["typed-at-send@nowhere.example"],
    );
    expect(recorded.rows[0].source_type).toBe("founder_entered");
  });

  it("sends to a founder-typed recipient when the founder's own path allows it", async () => {
    const draftId = await freshDraft("Allowed Recipient Co", "allowed.example", "hello@allowed.example");
    await saveDraft({
      id: draftId,
      subject: "A short question about your signal service",
      body: "Hi team, I noticed you sell paid signals and wanted to ask how you handle access today.",
      recipientEmail: "typed-by-founder@allowed.example",
      actorType: "founder",
      actorUserId: state.userId,
    });
    const db = await getDb();
    await db.query(`DELETE FROM prospect_emails WHERE normalized_email = $1`, ["typed-by-founder@allowed.example"]);
    await approveAgain(draftId);

    const accountId = await newMailbox();
    const result = await sendDraft({
      draftId,
      actorUserId: state.userId,
      accountId,
      allowFounderRecipient: true,
    });
    if ("queued" in result) throw new Error("expected a send");
    expect(result.alreadySent).toBe(false);

    const recorded = await db.query<{ source_type: string }>(
      `SELECT source_type FROM prospect_emails WHERE normalized_email = $1`,
      ["typed-by-founder@allowed.example"],
    );
    expect(recorded.rows[0].source_type).toBe("founder_entered");
  });
});

describe("4. a replied follow-up is cancelled automatically", () => {
  it("stops the send and leaves nothing for the founder to tidy up", async () => {
    const db = await getDb();
    const prospectId = state.prospectId; // reused: this file's own prospect
    const conversationId = (await db.query<{ id: string }>(
      `INSERT INTO conversations (id, prospect_id, subject, status, last_message_at, last_inbound_at, last_outbound_at)
       VALUES (gen_random_uuid(), $1, 'Re: your signals', 'replied', now(), now(), now() - interval '1 hour')
       ON CONFLICT (prospect_id) DO UPDATE SET last_inbound_at = now(), last_outbound_at = now() - interval '1 hour'
       RETURNING id`,
      [prospectId],
    )).rows[0].id;
    await db.query(
      `INSERT INTO messages (id, conversation_id, prospect_id, direction, source, from_email, subject, body_text, sent_at, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'inbound', 'imap', 'hello@friction-test.example', 'Re: your signals', 'We already have a provider.', now(), now())`,
      [conversationId, prospectId],
    );
    const draft = await db.query<{ id: string }>(
      `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
                           ai_generated, warnings, created_by_type, approved_at)
       VALUES (gen_random_uuid(), $1, 'follow_up', 1, 'approved', 'Re: your signals',
               'Just following up on my earlier note about signal access.', 'hello@friction-test.example',
               false, '[]'::jsonb, 'founder', now())
       RETURNING id`,
      [prospectId],
    );
    const draftId = draft.rows[0].id;
    const probe = await db.query<{ normalized_email: string }>(
      `SELECT normalized_email FROM prospect_emails WHERE prospect_id = $1`,
      [state.prospectId],
    );
    console.log("PROBE prospect_emails:", JSON.stringify(probe.rows));
    const probeDraft = await db.query<{ recipient_email: string; kind: string }>(
      `SELECT recipient_email, kind FROM drafts WHERE id = $1`,
      [draftId],
    );
    console.log("PROBE draft:", JSON.stringify(probeDraft.rows));
    const { normalizeEmail } = await import("@/lib/utils");
    console.log("PROBE normalizeEmail:", JSON.stringify(normalizeEmail("never-recorded@nowhere.example")));
    const probeMatch = await db.query(
      `SELECT 1 FROM prospect_emails WHERE prospect_id = $1 AND normalized_email = $2`,
      [state.prospectId, normalizeEmail("never-recorded@nowhere.example")],
    );
    console.log("PROBE exact-match rows:", probeMatch.rows.length);

    const accountId = await newMailbox();
    await expect(
      sendDraft({ draftId, actorUserId: state.userId, accountId }),
    ).rejects.toMatchObject({ code: "prospect_replied" });

    const after = await getDraft(draftId);
    expect(after?.status).toBe("cancelled");
    const reason = await db.query<{ last_error: string }>(
      `SELECT last_error FROM drafts WHERE id = $1`,
      [draftId],
    );
    expect(reason.rows[0].last_error).toMatch(/replied before this follow-up/i);
  });
});

describe("5. a too-soon send is held back, not refused", () => {
  it("returns a queued result, leaves no attempt behind, and keeps the draft approved", async () => {
    const first = await freshDraft("Slow Mailbox One Co", "slow-one.example", "hello@slow-one.example");
    const firstResult = await sendDraft({ draftId: first, actorUserId: state.userId, accountId: state.slowAccountId });
    if ("queued" in firstResult) throw new Error("the first send should not have been held back");

    const second = await freshDraft("Slow Mailbox Two Co", "slow-two.example", "hello@slow-two.example");
    const queued = await sendDraft({ draftId: second, actorUserId: state.userId, accountId: state.slowAccountId });
    expect("queued" in queued).toBe(true);
    if (!("queued" in queued)) return;
    expect(queued.retryAfterSeconds).toBeGreaterThan(0);
    expect(queued.note).toMatch(/held back/i);

    // nothing was sent, so nothing is recorded: the draft is still approved and can go again
    const draft = await getDraft(second);
    expect(draft?.status).toBe("approved");
    const db = await getDb();
    const rows = await db.query(`SELECT 1 FROM outbound_sends WHERE draft_id = $1`, [second]);
    expect(rows.rows).toHaveLength(0);
  });

  it("refuses a lead marked do not contact, before anything else is even considered", async () => {
    // The lever used to hold a lead whose email already went out from somewhere else. Nothing else in
    // the suite covered it, so the hold would have rested on an untested path.
    const accountId = await newMailbox();
    const draftId = await freshDraft("Held Lead Co", "held-lead.example", "hello@held-lead.example");
    const db = await getDb();
    const draft = await getDraft(draftId);
    await db.query(`UPDATE prospects SET do_not_contact = true WHERE id = $1`, [draft?.prospectId]);

    try {
      await expect(
        sendDraft({ draftId, actorUserId: state.userId, accountId }),
      ).rejects.toMatchObject({ code: "do_not_contact" });

      // refused before a ledger row exists, and the draft is untouched
      const rows = await db.query(`SELECT 1 FROM outbound_sends WHERE draft_id = $1`, [draftId]);
      expect(rows.rows).toHaveLength(0);
      expect((await getDraft(draftId))?.status).toBe("approved");
    } finally {
      await db.query(`UPDATE prospects SET do_not_contact = false WHERE id = $1`, [draft?.prospectId]);
    }
  });

  it("still refuses once the daily limit is reached", async () => {
    const accountId = await newMailbox();
    const first = await freshDraft("Daily Limit One Co", "daily-limit-one.example", "hello@daily-limit-one.example");
    const sent = await sendDraft({ draftId: first, actorUserId: state.userId, accountId });
    if ("queued" in sent) throw new Error("the first send should not have been held back");

    // one send is now on the ledger for this mailbox; a limit of one means the next one is refused
    const db = await getDb();
    await db.query(`UPDATE email_accounts SET daily_send_limit = 1 WHERE id = $1`, [accountId]);
    const second = await freshDraft("Daily Limit Two Co", "daily-limit-two.example", "hello@daily-limit-two.example");
    await expect(
      sendDraft({ draftId: second, actorUserId: state.userId, accountId }),
    ).rejects.toMatchObject({ code: "daily_limit_reached" });
  });
});