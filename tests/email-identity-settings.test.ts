import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ensureBootstrapUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults, getWorkspaceSettings, updateWorkspaceSettings } from "@/lib/services/settings";
import { buildComplianceFooter } from "@/lib/services/email-sending";
import { createResearchProvider, updateResearchProvider } from "@/lib/services/research-provider-admin";
import { resolveLeadResearch } from "@/lib/services/research-routing";

let original: Awaited<ReturnType<typeof getWorkspaceSettings>>;
const providers: string[] = [];
const prospects: string[] = [];
let userId: string;
beforeAll(async () => {
  await ensureWorkspaceDefaults(); original = await getWorkspaceSettings();
  userId = (await ensureBootstrapUser({ email: `identity-${crypto.randomUUID()}@example.test`, password: crypto.randomUUID(), name: "Identity Fixture" })).id;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  const db = await getDb();
  for (const id of providers) {
    await db.query("DELETE FROM ai_task_settings WHERE provider_id=$1", [id]);
    await db.query("DELETE FROM research_providers WHERE id=$1", [id]);
  }
  for (const id of prospects) await db.query("DELETE FROM prospects WHERE id=$1", [id]);
  await updateWorkspaceSettings(original, userId);
  await db.query("DELETE FROM users WHERE id=$1", [userId]);
});

it("independent identity switches persist without erasing saved text or changing draft rows", async () => {
  const db = await getDb();
  const before = (await db.query("SELECT id,body,status,updated_at::text FROM drafts ORDER BY id")).rows;
  const first = await updateWorkspaceSettings({ senderSignature: "Regards,\nFixture Founder", postalAddress: "1 Fixture Road",
    senderSignatureEnabled: true, postalAddressEnabled: true }, userId);
  const off = await updateWorkspaceSettings({ senderSignatureEnabled: false, postalAddressEnabled: false }, userId);
  expect(off.senderSignature).toBe(first.senderSignature);
  expect(off.postalAddress).toBe(first.postalAddress);
  expect(off.senderSignatureEnabled).toBe(false);
  expect(off.postalAddressEnabled).toBe(false);
  expect((await getWorkspaceSettings()).postalAddressEnabled).toBe(false);
  expect((await db.query("SELECT id,body,status,updated_at::text FROM drafts ORDER BY id")).rows).toEqual(before);
  await updateWorkspaceSettings(original, userId);
});

it("disabled/missing postal address refuses real commercial transport before writing an unsubscribe token", async () => {
  const db = await getDb();
  const prospectId = crypto.randomUUID(); prospects.push(prospectId);
  await db.query("INSERT INTO prospects(id,business_name,name_key,created_by_type) VALUES($1,'Identity fixture',$2,'founder')", [prospectId, prospectId]);
  const input = { accountProvider: "smtp", prospectId, email: "fixture@example.test" };
  const count = async () => Number((await db.query<{n:number}>("SELECT count(*)::int n FROM unsubscribe_tokens WHERE prospect_id=$1", [prospectId])).rows[0].n);
  const before = await count();
  for (const value of [{ postalAddress: "1 Fixture Road", postalAddressEnabled: false }, { postalAddress: "", postalAddressEnabled: true }]) {
    await updateWorkspaceSettings(value, userId);
    await expect(buildComplianceFooter(input)).rejects.toMatchObject({ code: "postal_address_missing" });
    expect(await count()).toBe(before);
  }
  await updateWorkspaceSettings({ postalAddress: "1 Fixture Road", postalAddressEnabled: true }, userId);
  const footer = await buildComplianceFooter(input);
  expect(footer.text).toContain("1 Fixture Road");
  expect(footer.headers["List-Unsubscribe"]).toMatch(/^<http:\/\/localhost:3100\/unsubscribe\//);
  expect(footer.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  await updateWorkspaceSettings({ postalAddressEnabled: false }, userId);
  const sandbox = await buildComplianceFooter({ ...input, accountProvider: "sandbox" });
  expect(sandbox.text).not.toContain("1 Fixture Road");
  expect(sandbox.text).toContain("Unsubscribe:");
  await updateWorkspaceSettings(original, userId);
});

it("Z.ai creation is disabled/unassigned by default and search capability is refused on create and update", async () => {
  const network = vi.fn(() => { throw new Error("No external calls allowed"); }); vi.stubGlobal("fetch", network);
  const name = `GLM fixture ${crypto.randomUUID()}`;
  const id = await createResearchProvider({ name, provider: "zai", apiKey: crypto.randomUUID() }); providers.push(id);
  const db = await getDb();
  expect((await db.query("SELECT provider,kinds,model,base_url,is_enabled,last_test_ok FROM research_providers WHERE id=$1", [id])).rows).toEqual([{
    provider: "zai", kinds: "chat", model: "glm-5.3-flash", base_url: "https://api.z.ai/api/paas/v4", is_enabled: false, last_test_ok: null,
  }]);
  expect((await db.query("SELECT 1 FROM ai_task_settings WHERE provider_id=$1", [id])).rows).toHaveLength(0);
  await expect(updateResearchProvider(id, { kinds: "both" })).rejects.toMatchObject({ code: "invalid_provider_kind" });
  await expect(createResearchProvider({ name: `${name} invalid`, provider: "zai", kinds: "search", apiKey: crypto.randomUUID() })).rejects.toMatchObject({ code: "invalid_provider_kind" });
  expect(network).not.toHaveBeenCalled();
});

it("Z.ai cannot widen the DeepSeek research adapter or its known-priced usage path", async () => {
  const db = await getDb();
  const old = (await db.query("SELECT * FROM ai_task_settings WHERE task='lead_research'")).rows;
  const id = await createResearchProvider({ name: `GLM research refusal ${crypto.randomUUID()}`, provider: "zai", isEnabled: true, apiKey: crypto.randomUUID() }); providers.push(id);
  try {
    await db.query("UPDATE research_providers SET last_test_ok=true WHERE id=$1", [id]);
    await db.query("DELETE FROM ai_task_settings WHERE task='lead_research'");
    await db.query("INSERT INTO ai_task_settings(task,provider_id) VALUES('lead_research',$1)", [id]);
    const network = vi.fn(() => { throw new Error("Unsupported research must not reach network"); }); vi.stubGlobal("fetch", network);
    const result = await resolveLeadResearch();
    expect(result.configuration.configured).toBe(false);
    expect(result.configuration.warnings.join(" ")).toContain("official DeepSeek");
    expect(network).not.toHaveBeenCalled();
  } finally {
    await db.query("DELETE FROM ai_task_settings WHERE task='lead_research'");
    for (const row of old as {provider_id:string;model:string|null;search_provider_id:string|null;updated_by:string|null}[]) {
      await db.query("INSERT INTO ai_task_settings(task,provider_id,model,search_provider_id,updated_by) VALUES('lead_research',$1,$2,$3,$4)", [row.provider_id,row.model,row.search_provider_id,row.updated_by]);
    }
  }
});
