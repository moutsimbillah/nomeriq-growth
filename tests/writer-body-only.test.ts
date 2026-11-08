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

async function clearAiSettings() {
  const db = await getDb();
  await db.query(`DELETE FROM ai_task_settings`);
  await db.query(`DELETE FROM ai_task_fallbacks`);
}
