import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { getDb, closeDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { createResearchProvider, testResearchProvider } from "@/lib/services/research-provider-admin";
import { saveTaskSetting } from "@/lib/services/ai-task-settings";
import { resolveAiTask } from "@/lib/ai/registry";
import { translateToEnglish } from "@/lib/ai/translation";
import { translateMessage } from "@/lib/services/message-translations";
import { suggestReply } from "@/lib/ai/reply";
import { suggestionSignature } from "@/lib/ai/reply-status";
import type { ProspectDetail, ProductTruth } from "@/lib/types";
import type { WorkspaceSettings } from "@/lib/services/settings";

vi.mock("@/lib/email/profiles", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/email/profiles")>();
  return { ...original, resolveSendingProfile: vi.fn(async () => ({ signature: "", fromName: "Moutsim · Nomeriq" })) };
});
const key = randomBytes(24).toString("hex");
const model = "fixture-model";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const makeId = async (provider: string) => createResearchProvider({ name: `${provider}-${crypto.randomUUID()}`, provider, kinds: "chat", model, apiKey: key, baseUrl: "https://gateway.example.test/v1" });
beforeAll(async () => { await ensureWorkspaceDefaults(); });
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await closeDb(); });

it.each(["openai", "anthropic", "gemini", "openrouter", "deepseek", "custom"])("the %s administration Test records a genuine chat outcome", async provider => {
  const id = await makeId(provider);
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    urls.push(url);
    if (url.includes("/tools/search")) return json({ results: [{ url: "https://example.test", title: "fixture" }] });
    if (url.includes("/tools/fetch")) return json({ content: "Synthetic page" });
    if (!init.body) return provider === "gemini" ? json({ models: [{ name: `models/${model}` }] }) : json({ data: [{ id: model }] });
    if (provider === "anthropic") return json({ content: [{ type: "text", text: '{"ok":true}' }] });
    if (provider === "gemini") return json({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] });
    return json({ choices: [{ message: { content: '{"ok":true}' } }] });
  }));
  const outcome = await testResearchProvider(id);
  expect(outcome.ok).toBe(true);
  expect(outcome.message).toContain("Chat working");
  expect(urls.some(url => /chat\/completions|\/messages$|:generateContent/.test(url))).toBe(true);
  const db = await getDb();
  const stored = await db.query<{ last_test_ok: boolean }>("SELECT last_test_ok FROM research_providers WHERE id=$1", [id]);
  expect(stored.rows[0].last_test_ok).toBe(true);
});

it("records failure rather than Test OK when only the model list works", async () => {
  const id = await makeId("custom");
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit = {}) => init.body
    ? json({ error: { code: "invalid_request", message: "Private synthetic message" } }, 400)
    : json({ data: [{ id: model }] })));
  const outcome = await testResearchProvider(id);
  expect(outcome.ok).toBe(false);
  expect(outcome.message).not.toContain("Private synthetic message");
  const db = await getDb();
  expect((await db.query<{ last_test_ok: boolean }>("SELECT last_test_ok FROM research_providers WHERE id=$1", [id])).rows[0].last_test_ok).toBe(false);
});

const replyInput = {
  truth: { oneLiner: "Synthetic product", approvedClaims: [], status: "needs_review" } as unknown as ProductTruth,
  prospect: { id: "synthetic", businessName: "Fixture", contactEmail: "hello@example.test" } as unknown as ProspectDetail,
  classification: "other" as const,
  turns: [],
  settings: { senderSignature: "Founder\nNomeriq" } as WorkspaceSettings,
};

it("translation and suggestion use the shared streaming transport and the configured model", async () => {
  const id = await makeId("custom");
  await saveTaskSetting("translation", { providerId: id, model });
  await saveTaskSetting("suggest_reply", { providerId: id, model });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(model);
    expect(body.stream).toBe(true);
    const isTranslation = String(body.messages[0].content).includes("translation engine");
    const text = JSON.stringify(isTranslation
      ? { sourceLanguage: "fr", translatedText: "Hello" }
      : { subject: "Reply", body: "A synthetic AI-written answer.", needsFounderInput: false });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n`, { headers: { "Content-Type": "text/event-stream" } });
  }));
  expect(await translateToEnglish("Bonjour")).toMatchObject({ ok: true, translatedText: "Hello" });
  const suggested = await suggestReply(replyInput);
  expect(suggested.usedAi).toBe(true);
  expect(suggested.body).toContain("A synthetic AI-written answer.");
  expect(suggested.body).not.toMatch(/Moutsim\nNomeriq|Best,|Regards,/); // Settings, not AI, own the signature.
  expect(suggested.body).not.toContain("Founder");
});

it("keeps cached translation and registry reads in one transaction without deadlocking", async () => {
  const providerId = await makeId("custom");
  await saveTaskSetting("translation", { providerId });
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.query("INSERT INTO messages (id,direction,source,from_email,body_text,subject) VALUES ($1,'inbound','seed','fixture@example.test','Bonjour','Synthetic')", [id]);
  const fetcher = vi.fn(async () => json({ choices: [{ message: { content: JSON.stringify({ sourceLanguage: "fr", translatedText: "Hello" }) } }] }));
  vi.stubGlobal("fetch", fetcher);
  const outcomes = await Promise.all([translateMessage(id), translateMessage(id)]);
  expect(outcomes.every(outcome => outcome.ok)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(outcomes.filter(outcome => outcome.ok && outcome.cached)).toHaveLength(1);
}, 5000);

it("uses the task model override rather than silently reverting to the provider default", async () => {
  const id = await makeId("custom");
  await saveTaskSetting("translation", { providerId: id, model: "exact-other-model" });
  expect((await resolveAiTask("translation")).chat?.model).toBe("exact-other-model");
});

it("labels an unavailable provider honestly", async () => {
  await saveTaskSetting("suggest_reply", { providerId: null });
  const suggestion = await suggestReply(replyInput);
  expect(suggestion.usedAi).toBe(false);
  expect(suggestion.failure?.code).toBe("provider_unavailable");
  expect(suggestion.body).toBe("");
});

it("labels a failed provider honestly, with no echoed content in logs", async () => {
  const id = await makeId("custom");
  await saveTaskSetting("suggest_reply", { providerId: id });
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: "invalid_request", message: "Private synthetic message" } }, 400)));
    const suggestion = await suggestReply(replyInput);
    expect(suggestion.usedAi).toBe(false);
    expect(suggestion.failure).toBeDefined();
    expect(suggestion.note).not.toContain("standard template");
    expect(suggestion.body).toBe("");
    expect(JSON.stringify(log.mock.calls)).not.toContain("Private synthetic message");
    expect(suggestion.body).not.toContain("Founder");
  } finally { log.mockRestore(); }
});

it("keeps intentional signatures and never invents an identity", () => {
  expect(suggestionSignature("Profile signature", "Workspace", "Moutsim")).toBe("Profile signature");
  expect(suggestionSignature("", "Custom workspace signature", "Moutsim")).toBe("Custom workspace signature");
  expect(suggestionSignature("", "Founder\nNomeriq", "Moutsim · Nomeriq")).toBe("Moutsim\nNomeriq");
  expect(suggestionSignature("", "Founder\nNomeriq")).toBe("Nomeriq");
});
