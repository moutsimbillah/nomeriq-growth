import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults, getProductTruth, saveProductTruth, listProductTruthRevisions } from "@/lib/services/settings";
import { ensureBootstrapUser } from "@/lib/auth/session";
import { productTruthBlock, productTruthGaps, productTruthHeading } from "@/lib/ai/product-truth";
import { replyContext } from "@/lib/ai/reply";
import { generateFirstContact } from "@/lib/ai/writer";
import { createResearchProvider } from "@/lib/services/research-provider-admin";
import { saveTaskSetting } from "@/lib/services/ai-task-settings";
import type { ProductTruth, ProspectDetail } from "@/lib/types";
import type { WorkspaceSettings } from "@/lib/services/settings";

/**
 * Product Truth is part of every AI action's context, in full — what Nomeriq is and offers, what may
 * and may not be claimed, the questions to ask prospects — with its version and status in the
 * heading the founder sees under "Context used".
 */

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
let userId = "";

const full: ProductTruth = {
  id: "pt", version: 7, status: "approved",
  oneLiner: "Nomeriq is a white-label platform for signal businesses.",
  offerSummary: "Branded web app and member area.", howItWorks: "We set it up for you.",
  pricingNotes: "From 300 USD a month.", integrations: "Telegram.", limitations: "No performance claims.",
  approvedClaims: ["Nomeriq is a white-label platform for signal businesses.", "Setup takes two weeks."],
  prohibitedClaims: ["guaranteed results"],
  discoveryQuestions: ["How do subscribers receive signals today?"],
  approvedAt: null, updatedAt: new Date().toISOString(),
};

async function clearAiSettings() {
  const db = await getDb();
  await db.query(`DELETE FROM ai_task_fallbacks`);
  await db.query(`DELETE FROM ai_task_settings`);
  await db.query(`DELETE FROM research_providers`);
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  userId = (await ensureBootstrapUser({ email: "truth@example.test", password: crypto.randomUUID(), name: "Truth" })).id;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await clearAiSettings(); await closeDb(); });

describe("the Product Truth block", () => {
  it("carries every part, with version and status in the heading", () => {
    const block = productTruthBlock(full);
    expect(block.split("\n")[0]).toBe(productTruthHeading(full));
    expect(block).toContain("PRODUCT TRUTH · version 7 · APPROVED");
    for (const part of [
      "What Nomeriq is (one-liner): Nomeriq is a white-label platform",
      "What Nomeriq offers: Branded web app", "How it works: We set it up", "Pricing and commercial terms: From 300 USD",
      "Integrations: Telegram.", "Limitations: No performance claims.",
      "May be claimed (approved claims):\n- Nomeriq is a white-label platform for signal businesses.\n- Setup takes two weeks.",
      "Must never be claimed:\n- guaranteed results",
      "Questions to ask prospects (discovery):\n- How do subscribers receive signals today?",
    ]) expect(block, part).toContain(part);
  });

  it("an unapproved version is still given in full, with the rule that only approved claims are facts", () => {
    const block = productTruthBlock({ ...full, status: "needs_review", version: 1 });
    expect(block).toContain("version 1 · NEEDS REVIEW (not approved by the founder)");
    expect(block).toContain("What Nomeriq offers: Branded web app");
    expect(block).toMatch(/NOT approved\. Only the one-liner and the approved claims may be stated as fact/);
  });

  it("names what is missing in the starting record (live Product Truth is still this seed)", async () => {
    const gaps = productTruthGaps(await getProductTruth()).map((gap) => gap.field);
    expect(gaps).toEqual([
      "Approval", "What Nomeriq offers", "How it works", "Approved integrations",
      "Approved claims", "Questions to ask prospects",
    ]);
    expect(productTruthGaps(full)).toEqual([]);
  });
});

describe("Questions to ask prospects", () => {
  it("migration 029 adds the column and is safe to re-run", async () => {
    const db = await getDb();
    const sql = read("src/db/migrations/029_product_truth_discovery_questions.sql");
    await db.exec(sql);
    await db.exec(sql);
    const column = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'product_truth' AND column_name = 'discovery_questions'`);
    expect(column.rows).toHaveLength(1);
  });

  it("are saved with a new version, kept in the revision snapshot, and kept when a client omits them", async () => {
    const base = await getProductTruth();
    const input = {
      oneLiner: base.oneLiner, offerSummary: base.offerSummary, howItWorks: base.howItWorks,
      pricingNotes: base.pricingNotes, integrations: base.integrations, limitations: base.limitations,
      approvedClaims: base.approvedClaims, prohibitedClaims: base.prohibitedClaims, approve: false,
    };
    const saved = await saveProductTruth({ ...input, discoveryQuestions: ["  Who runs your VIP access? ", ""] }, userId);
    expect(saved.discoveryQuestions).toEqual(["Who runs your VIP access?"]);
    expect(saved.version).toBe(base.version + 1);
    expect((await listProductTruthRevisions())[0]!.snapshot.discoveryQuestions).toEqual(["Who runs your VIP access?"]);
    const again = await saveProductTruth(input, userId);
    expect(again.discoveryQuestions).toEqual(["Who runs your VIP access?"]);
  });

  it("appear on the Product Truth page, which also lists what is missing", () => {
    expect(read("src/components/product-truth-form.tsx")).toContain("Questions to ask prospects (one per line)");
    const page = read("src/app/(app)/product-truth/page.tsx");
    expect(page).toContain("productTruthGaps(truth)");
    expect(page).toContain("What's missing");
  });

  it("are readable by connected assistants through read_product_truth", () => {
    expect(read("src/lib/agent/service.ts")).toContain("discoveryQuestions: truth.discoveryQuestions");
  });
});

describe("every AI action receives the full block", () => {
  it("the shared lead context, used by Suggest, Simulate, first emails and follow-ups, is built from it", () => {
    const context = read("src/lib/ai/lead-context.ts");
    expect(context).toContain("productTruthBlock(truth)");
    for (const writer of ["src/lib/ai/reply.ts", "src/lib/ai/simulate.ts", "src/lib/ai/writer.ts"]) {
      expect(read(writer), writer).toContain("buildLeadContext(");
    }
  });

  it("the older environment-provider paths use the same block", () => {
    const prospect = { businessName: "Lead", websiteUrl: null, signalDescription: null } as unknown as ProspectDetail;
    expect(replyContext(full, prospect, [])).toContain(productTruthBlock(full));
    expect(read("src/lib/ai/writer.ts")).toMatch(/function approvedContext\(truth: ProductTruth\): string \{\s*return productTruthBlock\(truth\);/);
  });

  it("a first email through Settings sends the block with its version and status", async () => {
    await clearAiSettings();
    const id = await createResearchProvider({ name: "Truth gateway", provider: "custom", kinds: "chat", model: "truth-model", apiKey: "fixture-truth", baseUrl: "https://truth.example.test/v1" });
    const db = await getDb();
    await db.query(`UPDATE research_providers SET last_test_ok = true WHERE id = $1`, [id]);
    // Only first-email drafting: other suites on the shared database expect translation unassigned.
    await saveTaskSetting("first_email", { providerId: id });
    try {
    const prospectId = crypto.randomUUID();
    await db.query(`INSERT INTO prospects (id, business_name, name_key, qualification_status, status) VALUES ($1, 'Truth Lead', 'truth-lead', 'verified', 'new')`, [prospectId]);
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit = {}) => {
      seen.push(JSON.parse(String(init.body)).messages[1].content);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ subject: "Hello", body: "A first email long enough to pass the word floor for a draft in this test case here." }) } }] }));
    }));
    const truth = await getProductTruth();
    const { getProspect } = await import("@/lib/services/prospects");
    await generateFirstContact((await getProspect(prospectId))!, truth, { senderSignature: "M", timezone: "UTC" } as unknown as WorkspaceSettings);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(productTruthHeading(truth));
    expect(seen[0]).toContain("Questions to ask prospects (discovery):");
    expect(seen[0]).toContain("Must never be claimed:");
    } finally {
      await clearAiSettings();
    }
  });

  it("classification makes no AI call today, so it has no context to carry", () => {
    // Replies are classified by fixed rules (src/lib/email/classify.ts). If an AI classifier is added,
    // it must use productTruthBlock like every other AI action.
    const classify = read("src/lib/email/classify.ts");
    expect(classify).not.toMatch(/runChatTask|fetch\(/);
    const callers = ["src/lib/ai/reply.ts", "src/lib/ai/simulate.ts", "src/lib/ai/writer.ts"].map(read).join("\n");
    expect(callers).not.toContain('runChatTask("classification"');
  });
});
