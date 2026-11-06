import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/profiles", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/email/profiles")>();
  return {
    ...original,
    resolveSendingProfile: vi.fn(async () => ({ fromName: "Moutsim · Nomeriq", emailAddress: "moutsim@sender.example.test", signature: "" })),
  };
});

import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { buildLeadContext, callSlots, conversationBlock, CONTEXT_PARTS, RECENT_IN_FULL, type ContextMessage } from "@/lib/ai/lead-context";
import { createResearchProvider } from "@/lib/services/research-provider-admin";
import { saveTaskSetting } from "@/lib/services/ai-task-settings";
import { suggestReply, replySystemPrompt } from "@/lib/ai/reply";
import { draftSimulatedReply, simulationSystemPrompt } from "@/lib/ai/simulate";
import { generateFollowUp } from "@/lib/ai/writer";
import { getProspect } from "@/lib/services/prospects";
import type { ProductTruth } from "@/lib/types";

/** Leave no AI assignment behind: later test files expect an unconfigured registry. */
async function clearAiSettings() {
  const db = await getDb();
  await db.query(`DELETE FROM ai_task_fallbacks`);
  await db.query(`DELETE FROM ai_task_settings`);
  await db.query(`DELETE FROM research_providers`);
}
import type { WorkspaceSettings } from "@/lib/services/settings";

/**
 * The shared lead context: every part the founder listed is present, by name, and the same text is
 * what Suggest with AI, Simulate a test reply and follow-ups actually send to the model.
 */

const prospectId = crypto.randomUUID();
const conversationId = crypto.randomUUID();

async function seedLead() {
  const db = await getDb();
  await db.query(
    `INSERT INTO prospects (id, business_name, name_key, website_url, domain_key, country, categories,
        signal_description, pricing_details, qualification_status, evidence_summary, research_notes,
        instagram_url, youtube_url, telegram_url, follower_count, subscriber_count, status, founder_notes)
     VALUES ($1, 'Señales Pro', 'senales-pro-ctx', 'https://senales.example.test', 'senales-ctx.example.test', 'Spain',
        '["forex","gold"]'::jsonb, 'Daily XAUUSD and EURUSD entries with SL/TP', 'VIP 49 EUR/month',
        'verified', 'Official site lists VIP plans; Telegram channel active', 'Runs a Telegram VIP group',
        'https://instagram.example.test/senales', 'https://youtube.example.test/senales', 'https://t.me/senalespro',
        '12,400', '3,100', 'replied', 'Met at a webinar; prefers Spanish')`,
    [prospectId],
  );
  await db.query(
    `INSERT INTO prospect_sources (id, prospect_id, url, label, source_type, notes)
     VALUES ($1, $2, 'https://senales.example.test/vip', 'VIP pricing page', 'website', 'Lists 49 EUR plan'),
            ($3, $2, 'https://t.me/senalespro', 'Telegram channel', 'official_social', NULL)`,
    [crypto.randomUUID(), prospectId, crypto.randomUUID()],
  );
  await db.query(
    `INSERT INTO conversations (id, prospect_id, subject, classification) VALUES ($1, $2, 'Señales Pro and Nomeriq', 'demo')`,
    [conversationId, prospectId],
  );
  const first = crypto.randomUUID();
  const reply = crypto.randomUUID();
  await db.query(
    `INSERT INTO messages (id, conversation_id, prospect_id, direction, source, from_email, subject, body_text, sent_at)
     VALUES ($1, $2, $3, 'outbound', 'system', 'moutsim@sender.example.test', 'Señales Pro and Nomeriq', 'Hi team, a note about your VIP signals.', '2026-11-01T09:00:00Z'),
            ($4, $2, $3, 'outbound', 'system', 'moutsim@sender.example.test', 'Re: Señales Pro and Nomeriq', 'Following up on my note (follow-up #1).', '2026-11-04T09:00:00Z')`,
    [first, conversationId, prospectId, crypto.randomUUID()],
  );
  await db.query(
    `INSERT INTO messages (id, conversation_id, prospect_id, direction, source, from_email, from_name, subject, body_text, received_at)
     VALUES ($1, $2, $3, 'inbound', 'imap', 'ana@senales.example.test', 'Ana', 'Re: Señales Pro and Nomeriq', 'Hola, nos interesa. ¿Podemos hablar esta semana? Tenemos 3.100 suscriptores.', '2026-11-05T10:00:00Z')`,
    [reply, conversationId, prospectId],
  );
  await db.query(
    `INSERT INTO message_translations (message_id, source_hash, source_language, translated_text, provider, model, status)
     VALUES ($1, 'hash', 'es', 'Hi, we are interested. Can we talk this week? We have 3,100 subscribers.', 'Growth-Chat-Search', 'deepseek-flash', 'translated')`,
    [reply],
  );
  await db.query(
    `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email, ai_generated, ai_model, ai_provider, sent_at)
     VALUES ($1, $2, 'first_contact', 0, 'sent', 'Señales Pro and Nomeriq', 'Hi team, a note about your VIP signals.', 'ana@senales.example.test', true, 'deepseek-flash', 'Growth-Chat-Search', '2026-11-01T09:00:00Z')`,
    [crypto.randomUUID(), prospectId],
  );
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  await seedLead();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await clearAiSettings();
  await closeDb(); });

describe("the shared lead context", () => {
  it("contains every part the founder listed, each marked present", async () => {
    const context = await buildLeadContext(prospectId, { conversationId });
    for (const part of CONTEXT_PARTS) expect(context.present[part], part).toBe(true);

    const text = context.text;
    // The lead.
    for (const needle of [
      "Business: Señales Pro", "Website: https://senales.example.test", "Country: Spain", "Tier: not recorded",
      "Markets: forex, gold", "Followers: 12,400", "Subscribers: 3,100", "Telegram: https://t.me/senalespro",
      "Instagram: https://instagram.example.test/senales", "YouTube: https://youtube.example.test/senales",
      "Daily XAUUSD and EURUSD entries", "Pricing: VIP 49 EUR/month", "Evidence summary: Official site lists VIP plans",
      "VIP pricing page: https://senales.example.test/vip", "Telegram channel: https://t.me/senalespro",
      "Founder notes: Met at a webinar", "Stage: replied", "Conversation classification: demo",
      "Sending profile: Moutsim · Nomeriq <moutsim@sender.example.test>",
    ]) expect(text, needle).toContain(needle);

    // The whole conversation, oldest first, with dates, follow-ups and the translation beside the original.
    const order = ["2026-11-01 09:00 UTC", "2026-11-04 09:00 UTC", "2026-11-05 10:00 UTC"].map((stamp) => text.indexOf(stamp));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("follow-up #1");
    expect(text).toContain("Hola, nos interesa.");
    expect(text).toContain("[English translation from es");
    expect(text).toContain("We have 3,100 subscribers.");
    expect(context.prospectLanguage).toBe("es");

    // Earlier drafts and what was sent, with who wrote them.
    expect(text).toContain("First email · sent · SENT 2026-11-01 09:00 UTC · written by Growth-Chat-Search · deepseek-flash");

    // Product Truth and the skill's writing rules.
    expect(text).toContain("=== PRODUCT TRUTH · version ");
    expect(text).toMatch(/PRODUCT TRUTH · version \d+ · (APPROVED|NEEDS REVIEW)/);
    expect(text).toContain("What Nomeriq is (one-liner):");
    expect(text).toContain("What Nomeriq offers:");
    expect(text).toContain("Must never be claimed:");
    expect(text).toContain("Questions to ask prospects (discovery):");
    expect(text).toContain("## First-contact drafts");
    expect(text).toContain("## Threads and replies");
  });

  it("keeps recent messages in full and condenses older ones without losing what the prospect said", () => {
    const fact = "We run 4 VIP groups and use MetaTrader 5 copiers";
    const messages: ContextMessage[] = Array.from({ length: RECENT_IN_FULL + 4 }, (_, index) => ({
      direction: index % 2 ? "inbound" : "outbound",
      fromEmail: index % 2 ? "ana@example.test" : "us@example.test",
      fromName: null,
      subject: `Message ${index}`,
      body: index === 1 ? `${fact}. ${"Detail. ".repeat(40)}` : `Our long earlier pitch number ${index}. ${"Words ".repeat(200)}`,
      at: new Date(Date.UTC(2026, 9, 1 + index)).toISOString(),
      isSandbox: false,
      translation: null,
    }));
    const block = conversationBlock(messages);
    expect(block.condensed).toBe(4);
    expect(block.text).toContain("4 older messages condensed");
    // The prospect's own older words survive; our own older email is shortened.
    expect(block.text).toContain(fact);
    expect(block.text).toContain("[cut at 280 characters]");
    // Every recent message is present in full.
    expect(block.text).toContain(`Our long earlier pitch number ${RECENT_IN_FULL + 2}. ${"Words ".repeat(200).trim()}`);
  });

  it("offers two concrete weekday call slots in the workspace timezone", () => {
    // Friday 6 Nov 2026 → Monday 9 and Tuesday 10 Nov.
    const slots = callSlots("Asia/Karachi", new Date("2026-11-06T08:00:00Z"));
    expect(slots).toEqual([
      "Monday 9 November, 11:00 (Asia/Karachi)",
      "Tuesday 10 November, 15:00 (Asia/Karachi)",
    ]);
  });
});

describe("every writer sends the shared context and reports who wrote it", () => {
  async function assignAll() {
    const db = await getDb();
    await db.query(`DELETE FROM ai_task_fallbacks`);
    await db.query(`DELETE FROM ai_task_settings`);
    await db.query(`DELETE FROM research_providers`);
    const id = await createResearchProvider({ name: "Ctx gateway", provider: "custom", model: "ctx-model", apiKey: "fixture-ctx", baseUrl: "https://ctx.example.test/v1" });
    await db.query(`UPDATE research_providers SET last_test_ok = true WHERE id = $1`, [id]);
    for (const task of ["suggest_reply", "simulate_reply", "follow_up"] as const) await saveTaskSetting(task, { providerId: id });
  }

  function stub(answer: unknown) {
    const seen: { system: string; user: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body));
      seen.push({ system: body.messages[0].content, user: body.messages[1].content });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    }));
    return seen;
  }

  it("Suggest with AI: whole context, the prospect's language with English, exact sentences to confirm, provenance", async () => {
    await assignAll();
    const confirm = "Nuestro plan incluye 5.000 suscriptores.";
    const seen = stub({
      subject: "Re: Señales Pro and Nomeriq",
      body: `Hola Ana, encantado. ${confirm} ¿Le va bien el lunes o el martes?`,
      language: "es",
      englishBody: "Hi Ana, delighted. Our plan includes 5,000 subscribers. Does Monday or Tuesday suit you?",
      confirmSentences: [confirm, "A sentence that is not in the body."],
      needsFounderInput: true,
    });
    const prospect = (await getProspect(prospectId))!;
    const suggestion = await suggestReply({
      truth: { oneLiner: "x", approvedClaims: [], prohibitedClaims: [], status: "needs_review" } as unknown as ProductTruth,
      prospect,
      classification: "demo",
      turns: [],
      settings: { senderSignature: "", timezone: "Asia/Karachi" } as unknown as WorkspaceSettings,
      conversationId,
    });

    expect(seen).toHaveLength(1);
    const sent = seen[0]!;
    expect(sent.system).toBe(replySystemPrompt());
    for (const needle of ["Business: Señales Pro", "VIP pricing page: https://senales.example.test/vip", "Hola, nos interesa.", "=== PRODUCT TRUTH", "## Threads and replies"]) {
      expect(sent.user).toContain(needle);
    }
    expect(sent.user).toMatch(/offer exactly these two options: .+ or .+\./);
    // What the founder sees in "Context used" is exactly what was sent.
    expect(suggestion.context).toBe(`SYSTEM\n${sent.system}\n\nREQUEST\n${sent.user}`);
    expect(suggestion.provider).toBe("Ctx gateway");
    expect(suggestion.model).toBe("ctx-model");
    expect(suggestion.language).toBe("es");
    expect(suggestion.englishBody).toContain("Hi Ana");
    // Only sentences that really occur in the body are kept, so the highlight is always exact.
    expect(suggestion.confirmSentences).toEqual([confirm]);
    expect(suggestion.note).toBeNull();
  });

  it("the suggestion prompt demands an answer to the latest message, a concrete call and no hedging", () => {
    const prompt = replySystemPrompt();
    expect(prompt).toMatch(/LATEST message/);
    expect(prompt).toMatch(/two time options/);
    expect(prompt).toMatch(/no hedging/);
    expect(prompt).toMatch(/confirmSentences/);
    expect(prompt).toMatch(/prospect's language/);
  });

  it("Simulate a test reply: written as this prospect, from the same context, with provenance", async () => {
    await assignAll();
    const seen = stub({ body: "Gracias. ¿Cuánto cuesta para 3.100 suscriptores?", language: "es" });
    const draft = await draftSimulatedReply(conversationId);
    expect(seen[0]!.system).toBe(simulationSystemPrompt());
    expect(seen[0]!.system).toMatch(/language and tone they used/);
    expect(seen[0]!.user).toContain("Hola, nos interesa.");
    expect(seen[0]!.user).toContain("Business: Señales Pro");
    expect(draft.body).toContain("Gracias");
    expect(draft.provider).toBe("Ctx gateway");
    expect(draft.context).toContain("Founder notes: Met at a webinar");
  });

  it("Follow-ups: written by the assigned provider from the full thread, the template only as a fallback", async () => {
    await assignAll();
    const seen = stub({ subject: "ignored", body: "Hola Ana, una idea nueva sobre sus grupos VIP de oro: ¿cómo comparten hoy los resultados con los suscriptores?" });
    const prospect = (await getProspect(prospectId))!;
    const settings = { senderSignature: "Moutsim\nNomeriq", timezone: "UTC" } as unknown as WorkspaceSettings;
    const generated = await generateFollowUp({ prospect, originalSubject: "Señales Pro and Nomeriq", previousBody: "x", sequence: 2, settings });
    expect(generated.usedAi).toBe(true);
    expect(generated.provider).toBe("Ctx gateway");
    expect(generated.subject).toBe("Re: Señales Pro and Nomeriq");
    expect(seen[0]!.user).toContain("follow-up #1");
    expect(seen[0]!.user).toContain("=== EARLIER DRAFTS AND WHAT WAS SENT ===");

    // No provider answers → the standard template, clearly not AI.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const fallback = await generateFollowUp({ prospect, originalSubject: "Señales Pro and Nomeriq", previousBody: "x", sequence: 2, settings });
    expect(fallback.usedAi).toBe(false);
    expect(fallback.provider ?? null).toBeNull();
  });
});
