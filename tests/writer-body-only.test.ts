import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { buildFollowUp, deterministicFirstContact, generateFirstContact, generateFollowUp } from "@/lib/ai/writer";
import { createResearchProvider } from "@/lib/services/research-provider-admin";
import { saveTaskSetting } from "@/lib/services/ai-task-settings";
import { getDb } from "@/lib/db/client";
import type { ProspectDetail, ProductTruth } from "@/lib/types";
import type { WorkspaceSettings } from "@/lib/services/settings";

const signature = "Moutsim\nNomeriq";
const settings = { senderSignature: signature, timezone: "UTC" } as unknown as WorkspaceSettings;

const prospect = {
  id: randomUUID(),
  businessName: "Signal Works",
  websiteUrl: "https://signalworks.example",
  country: "Pakistan",
  categories: ["forex"],
  qualificationStatus: "verified",
  status: "verified",
  contactEmail: "ana@signalworks.example",
  signalDescription: "Paid Telegram signal service.",
  pricingDetails: null,
  evidenceSummary: "Publishes daily signals.",
  researchNotes: null,
  founderNotes: null,
  doNotContact: false,
  otherSocials: [],
} as unknown as ProspectDetail;

const truth = {
  id: randomUUID(),
  version: 1,
  status: "approved",
  oneLiner: "White-label SaaS for trading-signal businesses.",
  offerSummary: "Full platform under the client's brand.",
  howItWorks: "Connect, brand, sell.",
  pricingNotes: "Monthly subscription.",
  integrations: "Telegram and email delivery.",
  limitations: "Not an exchange.",
  approvedClaims: ["White-label platform"],
  prohibitedClaims: ["Guaranteed profits"],
  discoveryQuestions: ["How do you deliver signals today?"],
  approvedAt: null,
  updatedAt: new Date().toISOString(),
} as unknown as ProductTruth;

/** No generated writer output may carry a sign-off or the saved signature: Growth adds identity at send. */
function expectBodyOnly(body: string) {
  expect(body).not.toContain(signature);
  expect(body).not.toMatch(/(?:Best(?: regards| wishes)?|Kind regards|Warm regards|Regards|Sincerely|Thanks|Thank you|Cheers)[,.!]?\s*$/im);
  expect(body.trim().length).toBeGreaterThan(0);
}

/** No writer path may reach the network without an assigned provider: a call here is a real failure. */
function refuseNetwork() {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("No writer path may call the network without an assigned provider.");
  }));
}

describe("writer outputs stay body-only", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("deterministicFirstContact returns body-only text", () => {
    expectBodyOnly(deterministicFirstContact(prospect, settings).body);
  });

  it.each([1, 2, 3])("buildFollowUp sequence %i returns body-only text", sequence => {
    expectBodyOnly(buildFollowUp({ prospect, originalSubject: "Hello", previousBody: "x", sequence, settings }).body);
  });

  it("generateFollowUp falls back to body-only text without a provider", async () => {
    refuseNetwork();
    const generated = await generateFollowUp({ prospect, originalSubject: "Hello", previousBody: "x", sequence: 2, settings });
    expect(generated.usedAi).toBe(false);
    expectBodyOnly(generated.body);
  });

  it("generateFirstContact returns body-only text without a provider", async () => {
    refuseNetwork();
    const generated = await generateFirstContact(prospect, truth, settings);
    expect(generated.usedAi).toBe(false);
    expectBodyOnly(generated.body);
  });

  it("generateFirstContact strips a signature a disobedient model added anyway", async () => {
    const db = await getDb();
    const providerId = await createResearchProvider({
      name: "Body-only gateway", provider: "custom", kinds: "chat", model: "body-only-model",
      apiKey: randomUUID(), baseUrl: "https://body-only.example.test/v1",
    });
    await db.query(`UPDATE research_providers SET last_test_ok = true WHERE id = $1`, [providerId]);
    await saveTaskSetting("first_email", { providerId });
    try {
      // The model disobeys the body-only rule and signs anyway; the writer must strip it.
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          subject: "Quick question",
          body: "I noticed your public signal service and how your team delivers updates to subscribers today. Could you walk me through that workflow?\n\nBest regards,\nJohn Smith\nFounder, Signal Works\nhttps://signalworks.example",
        }) } }],
      }))));
      const generated = await generateFirstContact(prospect, truth, settings);
      expect(generated.usedAi).toBe(true);
      expectBodyOnly(generated.body);
      expect(generated.body).not.toContain("John Smith");
    } finally {
      await clearAiSettings();
      await db.query(`DELETE FROM research_providers WHERE id = $1`, [providerId]);
    }
  });
});

describe("first contact opens with a greeting", () => {

  /** A first-contact draft must open with a greeting even when the model omits one. */
  it("adds the greeting line when the model starts straight with the observation", async () => {
    const body = "I noticed your public gold signal service and how your team delivers updates after a signal is posted. How does access work when a plan renews?";
    const generated = await generateWithModelBody(body);
    expect(generated.usedAi).toBe(true);
    expect(generated.body.startsWith("Hi Ana,")).toBe(true);
    expectBodyOnly(generated.body);
  });

    it("keeps a greeting the model wrote as its own line, without doubling it", async () => {
      const body = "Hi Ana,\n\nI noticed your public gold signal service and how your team delivers updates after a signal is posted. How does access work when a plan renews?";
      const generated = await generateWithModelBody(body);
      expect(generated.body.startsWith("Hi Ana,")).toBe(true);
      expect((generated.body.match(/^Hi /gm) ?? []).length).toBe(1);
    });

    it("adds a greeting line when the model fused the greeting into the first sentence", async () => {
      // "Hi Ana, I noticed ..." on one line reads as a wall of text, not as a greeting, so the guaranteed
      // line goes above it and the model's own words are preserved underneath.
      const body = "Hi Ana, I noticed your public gold signal service and how your team delivers updates after a signal is posted. How does access work when a plan renews?";
      const generated = await generateWithModelBody(body);
      expect(generated.body.split("\n")[0]).toBe("Hi Ana,");
      expect((generated.body.match(/^Hi /gm) ?? []).length).toBe(2);
      expect(generated.body).toContain("I noticed your public gold signal service");
    });

    it("does not mistake a short sentence for a greeting", async () => {
      // The reviewer's example: "Hi I noticed" is a sentence, not a salutation.
      const body = "Hi I noticed your VIP plans and wanted to reach out about how your team delivers signals to subscribers after a plan renews or expires.";
      const generated = await generateWithModelBody(body);
      expect(generated.body.split("\n")[0]).toBe("Hi Ana,");
      expect((generated.body.match(/^Hi /gm) ?? []).length).toBe(2);
    });

    it("does not accept a sentence that merely ends with a comma", async () => {
      // The later example: "Hi I noticed your services," ends with a comma but is not an address. The line is
      // 27 characters, so only the address rule can reject it.
      const body = "Hi I noticed your services,\n\nI wanted to ask how your team delivers signals to subscribers after a plan renews or expires.";
      const generated = await generateWithModelBody(body);
      expect(generated.body.split("\n")[0]).toBe("Hi Ana,");
      expect((generated.body.match(/^Hi /gm) ?? []).length).toBe(2);
    });

    it("keeps a real addressed greeting as its own line, unchanged", async () => {
      const body = "Hi Ana,\n\nI noticed your VIP plans and wanted to reach out about how your team delivers signals to subscribers after a plan renews or expires.";
      const generated = await generateWithModelBody(body);
      expect(generated.body.split("\n")[0]).toBe("Hi Ana,");
      expect((generated.body.match(/^Hi /gm) ?? []).length).toBe(1);
    });

    it("keeps a greeting addressed to a small team", async () => {
      // "Ana and team" is an address, not a sentence, so no second greeting is added.
      const body = "Hi Ana and team,\n\nI noticed your VIP plans and wanted to reach out about how your team delivers signals to subscribers after a plan renews or expires.";
      const generated = await generateWithModelBody(body);
      expect(generated.body.split("\n")[0]).toBe("Hi Ana and team,");
      expect((generated.body.match(/^Hi /gm) ?? []).length).toBe(1);
    });

    it("accepts a bare salutation on its own line", async () => {
      const body = "Hi there\n\nI noticed your VIP plans and wanted to reach out about how your team delivers signals to subscribers after a plan renews or expires.";
      const generated = await generateWithModelBody(body);
      expect(generated.body.split("\n")[0]).toBe("Hi there");
      expect((generated.body.match(/^Hi /gm) ?? []).length).toBe(1);
    });

  it("the deterministic first-contact body also opens with the greeting", () => {
    expect(deterministicFirstContact(prospect, settings).body.startsWith("Hi Ana,")).toBe(true);
  });

  /** Runs the AI path with a stubbed provider that returns exactly `body`. */
  async function generateWithModelBody(body: string) {
    const db = await getDb();
    const providerId = await createResearchProvider({
      name: `Greeting gateway ${randomUUID()}`, provider: "custom", kinds: "chat", model: "greeting-model",
      apiKey: "fixture-key", baseUrl: "https://greeting.example.test/v1",
    });
    await db.query(`UPDATE research_providers SET last_test_ok = true WHERE id = $1`, [providerId]);
    await saveTaskSetting("first_email", { providerId });
    try {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ subject: "Quick question", body }) } }],
      }))));
      return await generateFirstContact(prospect, truth, settings);
    } finally {
      await clearAiSettings();
      await db.query(`DELETE FROM research_providers WHERE id = $1`, [providerId]);
    }
  }
});

async function clearAiSettings() {
  const db = await getDb();
  await db.query(`DELETE FROM ai_task_settings`);
  await db.query(`DELETE FROM ai_task_fallbacks`);
}
