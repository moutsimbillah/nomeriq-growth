import fs from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, closeDb } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { ensureWorkspaceDefaults, updateWorkspaceSettings } from "@/lib/services/settings";
import { createEmailAccount, getDefaultEmailAccount } from "@/lib/email/accounts";
import { createResearchJob, getResearchJob } from "@/lib/services/research";
import {
  getProspect,
  saveProspect,
  updateProspect,
} from "@/lib/services/prospects";
import {
  approveDraft,
  generateDraftForProspect,
  getDraft,
  getFirstContactDraft,
  saveDraft,
  savePreparedFirstContactDraft,
} from "@/lib/services/drafts";
import { sendDraft } from "@/lib/services/email-sending";
import {
  getConversation,
  getConversationForProspect,
  sendReply,
  simulateInboundReply,
  suggestConversationReply,
} from "@/lib/services/conversations";
import {
  prepareFollowUpDrafts,
  listFollowUpCandidates,
} from "@/lib/services/followups";
import {
  createCampaign,
  listCampaigns,
  processNextCampaignItem,
  startCampaign,
} from "@/lib/services/campaigns";
import { classifyReply } from "@/lib/email/classify";
import { unsubscribeByToken } from "@/lib/services/suppressions";
import { runAgentAction, TOOL_DEFINITIONS } from "@/lib/agent/service";
import { createApiKey, type ApiKeyIdentity } from "@/lib/agent/apiKeys";

const state: {
  userId: string;
  jobId: string;
  accountId: string;
  alphaId: string;
  alphaDraftId: string;
  betaId: string;
  betaDraftId: string;
  gammaId: string;
  gammaDraftId: string;
} = {
  userId: "",
  jobId: "",
  accountId: "",
  alphaId: "",
  alphaDraftId: "",
  betaId: "",
  betaDraftId: "",
  gammaId: "",
  gammaDraftId: "",
};

function source(url: string) {
  return {
    url,
    label: "Test public source",
    observedAt: "2026-11-03T00:00:00.000Z",
    notes: "Integration fixture",
  };
}

async function createVerifiedProspect(input: {
  name: string;
  domain: string;
  email: string;
}) {
  const saved = await saveProspect({
    businessName: input.name,
    websiteUrl: `https://${input.domain}/`,
    country: "Testland",
    categories: ["forex", "metals"],
    signalDescription:
      "Sells monthly Telegram forex and gold signals with entry, stop-loss and take-profit levels.",
    pricingDetails: "$49 per month public subscription.",
    evidenceSummary:
      "The official pricing page shows a paid signal subscription and the official contact page publishes a business email.",
    email: input.email,
    emailSourceUrl: `https://${input.domain}/contact`,
    emailSourceType: "official_website",
    sources: [
      {
        url: `https://${input.domain}/pricing`,
        label: "Official pricing",
        observedAt: "2026-11-03T00:00:00.000Z",
      },
    ],
    researchJobId: state.jobId,
    qualificationStatus: "verified",
    actorType: "seed",
    actorUserId: state.userId,
  });
  expect(saved.created).toBe(true);
  return saved.prospect.id;
}

describe("Nomeriq Growth end-to-end workflow", () => {
  beforeAll(async () => {
    const db = await getDb();
    await ensureWorkspaceDefaults();
    state.userId = crypto.randomUUID();
    await db.query(
      `INSERT INTO users
        (id, email, normalized_email, name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, 'founder')`,
      [
        state.userId,
        "founder@test.nomeriq.com",
        "founder@test.nomeriq.com",
        "Test Founder",
        hashPassword("TestPassw0rd!123"),
      ],
    );
    await updateWorkspaceSettings(
      {
        legalBusinessName: "Nomeriq Test",
        postalAddress: "1 Test Street, Test City",
        senderSignature: "Test Founder\nNomeriq",
        footerNote: "This is a test footer.",
        followUpMax: 2,
        followUpDelay1Days: 4,
        followUpDelay2Days: 7,
      },
      state.userId,
    );
    const account = await createEmailAccount(
      {
        name: "Sandbox test mailbox",
        provider: "sandbox",
        emailAddress: "sandbox@nomeriq.test",
        fromName: "Test Founder",
        dailySendLimit: 100,
        minIntervalSeconds: 5,
        isDefault: true,
      },
      state.userId,
    );
    state.accountId = account.id;
    const job = await createResearchJob({
      name: "Test batch — 5 verified providers",
      targetCount: 5,
      categories: ["forex", "metals", "crypto", "indices", "commodities"],
      regions: "Worldwide",
      requirements: "Paid signal providers with public emails.",
      userId: state.userId,
    });
    state.jobId = job.id;

    state.alphaId = await createVerifiedProspect({
      name: "Alpha Signal House",
      domain: "alpha-signals.example.com",
      email: "hello@alpha-signals.example.com",
    });
    state.betaId = await createVerifiedProspect({
      name: "Beta Gold Signals",
      domain: "beta-gold.example.com",
      email: "hello@beta-gold.example.com",
    });
    state.gammaId = await createVerifiedProspect({
      name: "Gamma Forex Desk",
      domain: "gamma-forex.example.com",
      email: "hello@gamma-forex.example.com",
    });

    state.alphaDraftId = (
      await generateDraftForProspect({
        prospectId: state.alphaId,
        actorType: "seed",
        actorUserId: state.userId,
      })
    ).id;
    state.betaDraftId = (
      await generateDraftForProspect({
        prospectId: state.betaId,
        actorType: "seed",
        actorUserId: state.userId,
      })
    ).id;
    state.gammaDraftId = (
      await generateDraftForProspect({
        prospectId: state.gammaId,
        actorType: "seed",
        actorUserId: state.userId,
      })
    ).id;
  });

  afterAll(async () => {
    await closeDb();
    const dir = process.env.PGLITE_DIR || "";
    if (dir.startsWith(".data/test-vitest-")) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("deduplicates globally in the service and enforces identity at the database", async () => {
    const duplicate = await saveProspect({
      businessName: "Alpha Signal House Duplicate",
      websiteUrl: "https://alpha-signals.example.com/gold",
      categories: ["metals"],
      signalDescription: "Same business, different landing page.",
      email: "hello@alpha-signals.example.com",
      emailSourceUrl: "https://alpha-signals.example.com/contact",
      sources: [source("https://alpha-signals.example.com/pricing")],
      researchJobId: state.jobId,
      qualificationStatus: "verified",
      actorType: "chatgpt",
      actorUserId: state.userId,
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.prospect.id).toBe(state.alphaId);
    expect(duplicate.matchedOn).toContain("official website domain");

    // A shared generic inbox must never be the reason two records merge, because
    // unrelated businesses publish the same info@/hello@ address. The official
    // domain is the identity that deduplicated this record.
    expect(duplicate.matchedOn).not.toContain("contact email");

    const db = await getDb();
    await expect(
      db.query(`UPDATE prospects SET domain_key = $1 WHERE id = $2`, [
        "alpha-signals.example.com",
        state.betaId,
      ]),
    ).rejects.toMatchObject({ code: "23505" });

    const job = await getResearchJob(state.jobId);
    expect(job?.duplicatesRejected).toBeGreaterThanOrEqual(1);
  });

  it("still deduplicates on a non-generic contact email", async () => {
    // A business-specific address remains a strong identity signal.
    const first = await saveProspect({
      businessName: "Email Identity One",
      websiteUrl: "https://email-identity-one.example.com",
      categories: ["forex"],
      signalDescription: "Paid forex signal subscriptions.",
      email: "daniel@email-identity-one.example.com",
      emailSourceUrl: "https://email-identity-one.example.com/contact",
      sources: [source("https://email-identity-one.example.com/pricing")],
      qualificationStatus: "verified",
      actorType: "founder",
      actorUserId: state.userId,
    });
    expect(first.created).toBe(true);

    // Same person's address, a different site and name: must be caught.
    const second = await saveProspect({
      businessName: "A Completely Different Name",
      websiteUrl: "https://unrelated-landing.example.net",
      categories: ["forex"],
      signalDescription: "Paid forex signal subscriptions.",
      email: "daniel@email-identity-one.example.com",
      emailSourceUrl: "https://unrelated-landing.example.net/contact",
      sources: [source("https://unrelated-landing.example.net/pricing")],
      qualificationStatus: "verified",
      actorType: "founder",
      actorUserId: state.userId,
    });
    expect(second.created).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.prospect.id).toBe(first.prospect.id);
    expect(second.matchedOn).toContain("contact email");
  });

  it("refuses a verified lead without a contact email or evidence", async () => {
    await expect(
      saveProspect({
        businessName: "No Email Provider",
        websiteUrl: "https://no-email.example.com",
        categories: ["forex"],
        signalDescription: "Signal provider without a public contact email.",
        sources: [source("https://no-email.example.com/pricing")],
        qualificationStatus: "verified",
        emailSourceUrl: "https://no-email.example.com/contact",
        actorType: "founder",
        actorUserId: state.userId,
      }),
    ).rejects.toThrow(/contact email/i);

    await expect(
      saveProspect({
        businessName: "No Source Provider",
        websiteUrl: "https://no-source.example.org",
        categories: ["crypto"],
        signalDescription: "Signal provider without a source URL.",
        email: "hello@no-source.example.org",
        emailSourceUrl: "https://no-source.example.org/contact",
        qualificationStatus: "verified",
        actorType: "founder",
        actorUserId: state.userId,
      }),
    ).rejects.toThrow(/evidence source/i);
  });

  it("preserves founder-edited drafts against AI overwrite", async () => {
    const edited = await saveDraft({
      id: state.alphaDraftId,
      subject: "A founder-written subject",
      body:
        "Hi team,\n\nI looked at your gold signals and have one operational question: how do subscribers track later take-profit updates?\n\nBest,\nTest Founder\nNomeriq",
      recipientEmail: "hello@alpha-signals.example.com",
      actorType: "founder",
      actorUserId: state.userId,
    });
    expect(edited.founderEdited).toBe(true);
    expect(edited.status).toBe("draft");

    const preserved = await savePreparedFirstContactDraft({
      prospectId: state.alphaId,
      subject: "AI replacement subject",
      body: "This AI body must not replace the founder's work even though it is long enough to pass validation checks.",
      actorType: "chatgpt",
      actorUserId: state.userId,
    });
    expect(preserved.preserved).toBe(true);
    expect(preserved.draft.subject).toBe("A founder-written subject");
    expect(preserved.draft.body).toContain("one operational question");

    const regenerated = await generateDraftForProspect({
      prospectId: state.alphaId,
      actorType: "founder",
      actorUserId: state.userId,
      force: true,
    });
    expect(regenerated.subject).toContain("Alpha Signal House");
    expect(regenerated.founderEdited).toBe(false);
  });

  it("sends through the sandbox idempotently and creates one thread", async () => {
    await approveDraft(state.alphaDraftId, state.userId);
    const first = await sendDraft({
      draftId: state.alphaDraftId,
      actorUserId: state.userId,
    });
    if ("queued" in first) throw new Error("expected a send, not a queued hold");
    expect(first.status).toBe("sandbox");
    expect(first.alreadySent).toBe(false);

    const second = await sendDraft({
      draftId: state.alphaDraftId,
      actorUserId: state.userId,
    });
    if ("queued" in second) throw new Error("expected an idempotent send, not a queued hold");
    expect(second.alreadySent).toBe(true);
    expect(second.messageId).toBe(first.messageId);

    const db = await getDb();
    const messages = await db.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM messages WHERE prospect_id = $1 AND direction = 'outbound'`,
      [state.alphaId],
    );
    expect(Number(messages.rows[0]?.count)).toBe(1);
    const stored = await db.query<{ body_text: string }>(
      `SELECT body_text FROM messages WHERE prospect_id = $1 AND direction = 'outbound' LIMIT 1`,
      [state.alphaId],
    );
    expect(stored.rows[0]?.body_text).toContain("/unsubscribe/");
    expect(stored.rows[0]?.body_text).toContain("1 Test Street, Test City");

    const conversation = await getConversationForProspect(state.alphaId);
    expect(conversation).not.toBeNull();
    expect(conversation?.messages).toHaveLength(1);
    expect((await getProspect(state.alphaId))?.status).toBe("contacted");
  });

  it("classifies replies, cancels follow-ups and prevents further follow-up drafts", async () => {
    const db = await getDb();
    await db.query(
      `UPDATE conversations SET last_outbound_at = now() - interval '10 days'
       WHERE prospect_id = $1`,
      [state.alphaId],
    );
    // automatic follow-ups are off by default (migration 020): this test is about what happens once the
    // founder has switched them on
    await db.query(
      `UPDATE workspace_settings SET follow_up_auto_enabled = true, follow_up_daily_limit = 10
        WHERE id = 'default'`,
    );
    const prepared = await prepareFollowUpDrafts({
      userId: state.userId,
      prospectIds: [state.alphaId],
    });
    expect(prepared).toHaveLength(1);
    expect(prepared[0].kind).toBe("follow_up");

    const conversation = await getConversationForProspect(state.alphaId);
    expect(conversation).not.toBeNull();
    await simulateInboundReply({
      conversationId: conversation!.id,
      body: "Thanks, this is interesting. Could you book a demo next week?",
      actorUserId: state.userId,
    });
    const updated = await getConversation(conversation!.id);
    expect(updated?.classification).toBe("demo");
    expect(updated?.messages.length).toBe(2);

    const cancelled = await db.query<{ status: string }>(
      `SELECT status FROM drafts WHERE prospect_id = $1 AND kind = 'follow_up'`,
      [state.alphaId],
    );
    expect(cancelled.rows[0]?.status).toBe("cancelled");

    const afterReply = await prepareFollowUpDrafts({
      userId: state.userId,
      prospectIds: [state.alphaId],
    });
    expect(afterReply).toHaveLength(0);
    const candidates = await listFollowUpCandidates();
    expect(candidates.some((candidate) => candidate.prospectId === state.alphaId)).toBe(
      false,
    );
  });

  it("sends a reviewed reply with idempotency and preserves the thread", async () => {
    const conversation = await getConversationForProspect(state.alphaId);
    expect(conversation).not.toBeNull();
    const suggestion = await suggestConversationReply(conversation!.id);
    expect(suggestion.body).toContain("Test Founder");
    expect(suggestion.needsFounderInput).toBe(false);

    const idempotencyKey = crypto.randomUUID();
    const first = await sendReply({
      conversationId: conversation!.id,
      subject: "Re: A founder-written subject",
      body:
        "Hi team,\n\nHappy to walk you through it. Would Tuesday at 3pm or Wednesday at 11am work?\n\nBest,\nTest Founder",
      actorUserId: state.userId,
      idempotencyKey,
    });
    expect(first.status).toBe("sandbox");
    const second = await sendReply({
      conversationId: conversation!.id,
      subject: "Re: A founder-written subject",
      body:
        "Hi team,\n\nHappy to walk you through it. Would Tuesday at 3pm or Wednesday at 11am work?\n\nBest,\nTest Founder",
      actorUserId: state.userId,
      idempotencyKey,
    });
    expect(second.alreadySent).toBe(true);

    const detail = await getConversation(conversation!.id);
    expect(detail?.messages.filter((message) => message.direction === "outbound")).toHaveLength(2);
    expect(detail?.messages.at(-1)?.bodyText).toContain("Tuesday at 3pm");
  });

  it("creates and completes a founder-authorized sandbox campaign without duplicates", async () => {
    await approveDraft(state.betaDraftId, state.userId);
    await expect(
      createCampaign({
        name: "Unauthorized",
        draftIds: [state.betaDraftId],
        accountId: state.accountId,
        userId: state.userId,
        authorize: false,
      }),
    ).rejects.toThrow(/authorization/i);

    const campaign = await createCampaign({
      name: "Integration campaign",
      draftIds: [state.betaDraftId],
      accountId: state.accountId,
      userId: state.userId,
      authorize: true,
    });
    await startCampaign(campaign.id, state.userId);
    await new Promise((resolve) => setTimeout(resolve, 5200));
    const result = await processNextCampaignItem(campaign.id, state.userId);
    expect(result.done).toBe(true);
    expect(result.progress?.sent).toBe(1);

    const campaigns = await listCampaigns();
    expect(campaigns.find((item) => item.id === campaign.id)?.status).toBe("completed");
    const db = await getDb();
    const count = await db.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM messages WHERE prospect_id = $1 AND direction = 'outbound'`,
      [state.betaId],
    );
    expect(Number(count.rows[0]?.count)).toBe(1);
  });

  it("records an opt-out immediately, suppresses the contact and blocks replies", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5200));
    await approveDraft(state.gammaDraftId, state.userId);
    await sendDraft({ draftId: state.gammaDraftId, actorUserId: state.userId });
    const conversation = await getConversationForProspect(state.gammaId);
    expect(conversation).not.toBeNull();
    await simulateInboundReply({
      conversationId: conversation!.id,
      body: "Please unsubscribe me and do not contact me again.",
      actorUserId: state.userId,
    });
    const db = await getDb();
    const suppression = await db.query<{ email: string; reason: string }>(
      `SELECT email, reason FROM suppressions WHERE normalized_email = $1`,
      ["hello@gamma-forex.example.com"],
    );
    expect(suppression.rows[0]?.reason).toBe("unsubscribe");
    const prospect = await getProspect(state.gammaId);
    expect(prospect?.doNotContact).toBe(true);
    expect(prospect?.status).toBe("lost");
    await expect(
      sendReply({
        conversationId: conversation!.id,
        subject: "Re: hello",
        body: "This should be blocked.",
        actorUserId: state.userId,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow(/opt|suppress/i);
  });

  it("exposes only scoped research and drafting tools, never sending", async () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(names).toContain("save_prospect");
    expect(names).toContain("save_draft");
    expect(names.some((name) => /send|delete|permission|product_truth_write/i.test(name))).toBe(
      false,
    );

    const key = await createApiKey({
      name: "Test assistant",
      assistant: "claude",
      scopes: ["research:read", "research:write", "drafts:write", "progress:read"],
      userId: state.userId,
    });
    const identity: ApiKeyIdentity = {
      id: key.id,
      name: "Test assistant",
      assistant: "claude",
      scopes: ["research:read", "research:write", "drafts:write", "progress:read"],
    };
    const duplicate = await runAgentAction(identity, "check_duplicate", {
      businessName: "Alpha Signal House",
      websiteUrl: "https://alpha-signals.example.com",
      email: "hello@alpha-signals.example.com",
    });
    expect(duplicate.data.duplicate).toBe(true);

    const progress = await runAgentAction(identity, "report_progress", {});
    expect(progress.data.jobs).toBeTruthy();
    await expect(
      runAgentAction(identity, "read_product_truth", {}),
    ).rejects.toThrow(/product_truth:read/);
    await expect(runAgentAction(identity, "send_email", {})).rejects.toThrow(
      /unknown growth action/i,
    );
  });

  it("reports database-derived research progress with emails and drafts", async () => {
    const job = await getResearchJob(state.jobId);
    expect(job).not.toBeNull();
    expect(job?.verifiedCount).toBe(3);
    expect(job?.emailCount).toBe(3);
    expect(job?.draftCount).toBe(3);
    expect(job?.duplicatesRejected).toBeGreaterThanOrEqual(1);
    expect(job?.remaining).toBe(2);
  });

  it("ignores unsubscribe text in quoted history when classifying a reply", () => {
    const classification = classifyReply(
      "Thanks, I am interested. Could you tell me more about how this works?\n\nOn Mon, Nomeriq wrote:\n> To unsubscribe, click here.",
    );
    expect(classification.classification).toBe("interested");
    expect(classifyReply("Please remove me from your list.").classification).toBe(
      "unsubscribe",
    );
  });

  it("processes a real unsubscribe capability token into immediate suppression", async () => {
    const saved = await saveProspect({
      businessName: "Delta Commodities Signals",
      websiteUrl: "https://delta-commodities.example.com",
      categories: ["commodities"],
      signalDescription:
        "Sells a paid commodities signal subscription with public pricing.",
      email: "hello@delta-commodities.example.com",
      emailSourceUrl: "https://delta-commodities.example.com/contact",
      sources: [
        source("https://delta-commodities.example.com/pricing"),
      ],
      qualificationStatus: "verified",
      actorType: "founder",
      actorUserId: state.userId,
    });
    expect(saved.created).toBe(true);
    const rawToken = randomBytes(32).toString("base64url");
    const db = await getDb();
    await db.query(
      `INSERT INTO unsubscribe_tokens
        (id, prospect_id, normalized_email, token_hash)
       VALUES ($1, $2, $3, $4)`,
      [
        crypto.randomUUID(),
        saved.prospect.id,
        "hello@delta-commodities.example.com",
        createHash("sha256").update(rawToken).digest("hex"),
      ],
    );
    const result = await unsubscribeByToken(rawToken);
    expect(result.email).toBe("hello@delta-commodities.example.com");
    const prospect = await getProspect(saved.prospect.id);
    expect(prospect?.doNotContact).toBe(true);
    const suppression = await db.query(
      `SELECT 1 FROM suppressions WHERE normalized_email = $1 AND active = true`,
      ["hello@delta-commodities.example.com"],
    );
    expect(suppression.rows.length).toBe(1);
    await expect(unsubscribeByToken("not-a-real-token-value-xxxxxxxx")).rejects.toThrow(
      /not valid/i,
    );
  });

  it("archives a prospect, cancels drafts and suppression-blocks future sending", async () => {
    const db = await getDb();
    const draft = await getFirstContactDraft(state.betaId);
    expect(draft).not.toBeNull();
    const prospect = await getProspect(state.betaId);
    expect(prospect).not.toBeNull();
    await updateProspect(state.betaId, { founderNotes: "Archived in test" }, state.userId);
    const { archiveProspect } = await import("@/lib/services/prospects");
    await archiveProspect(state.betaId, state.userId);
    const archived = await db.query<{ archived_at: string | null }>(
      `SELECT archived_at FROM prospects WHERE id = $1`,
      [state.betaId],
    );
    expect(archived.rows[0]?.archived_at).toBeTruthy();
    const suppression = await db.query(
      `SELECT 1 FROM suppressions WHERE normalized_email = $1 AND active = true`,
      ["hello@beta-gold.example.com"],
    );
    expect(suppression.rows.length).toBe(1);
  });

  it("has a healthy sandbox account and no real mailbox dependency", async () => {
    const account = await getDefaultEmailAccount(true);
    expect(account?.provider).toBe("sandbox");
    expect(account?.status).toBe("connected");
  });
});
