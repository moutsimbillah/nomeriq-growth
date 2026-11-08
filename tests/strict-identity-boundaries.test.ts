import { afterAll, beforeAll, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { hashPassword } from "@/lib/auth/password";
import { createApiKey } from "@/lib/agent/apiKeys";
import { saveProspect } from "@/lib/services/prospects";
import { POST as restPost } from "@/app/api/agent/v1/[action]/route";
import { POST as mcpPost } from "@/app/api/mcp/route";

const marker = crypto.randomUUID();
let bearer = "", userId = "", keyId = "", parentId = "";
const parentDomain = `parent-boundary-${marker}.test`;
function request(path: string, body: unknown) {
  return new Request(`http://localhost:3100${path}`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}
const payload = { businessName: `Sub brand ${marker}`, websiteUrl: `https://sub-brand-${marker}.test`, email: `support@${parentDomain}`,
  emailSourceUrl: `https://sub-brand-${marker}.test/contact`, categories: ["forex"], signalDescription: "Paid trading signals on a monthly subscription.",
  sources: [{ url: `https://sub-brand-${marker}.test/pricing`, label: "Published subscription" }], qualificationStatus: "verified" };
beforeAll(async () => {
  await ensureWorkspaceDefaults();
  const db = await getDb(); userId = crypto.randomUUID();
  await db.query("INSERT INTO users (id,email,normalized_email,name,password_hash,role) VALUES ($1,$2,$2,'Identity boundary',$3,'founder')", [userId,`${marker}@boundary.test`,hashPassword(crypto.randomUUID())]);
  const key = await createApiKey({ name: `Identity ${marker}`, assistant: "hermes", scopes: ["research:read","research:write"], userId });
  bearer = key.key; keyId = key.id;
  const parent = await saveProspect({ businessName: `Parent boundary ${marker}`, websiteUrl: `https://${parentDomain}`, categories: ["forex"], qualificationStatus: "candidate", actorType: "seed" });
  parentId = parent.prospect.id;
});
afterAll(async () => {
  const db = await getDb();
  await db.query("DELETE FROM audit_log WHERE actor_id=ANY($1::text[])", [[keyId,userId]]);
  await db.query("DELETE FROM prospect_aliases WHERE prospect_id=$1",[parentId]);
  await db.query("DELETE FROM prospects WHERE id=$1",[parentId]);
  await db.query("DELETE FROM api_keys WHERE created_by=$1",[userId]);
  await db.query("DELETE FROM users WHERE id=$1",[userId]);
  await closeDb();
});
it("actual MCP and REST saves catch an email-domain overlap without an explicit precheck", async () => {
  const db = await getDb();
  const before = (await db.query("SELECT (SELECT count(*) FROM prospects) p,(SELECT count(*) FROM drafts) d,(SELECT count(*) FROM outbound_sends) s,(SELECT count(*) FROM research_jobs) j")).rows;
  const rest = await restPost(request("/api/agent/v1/save_prospect",payload), { params: Promise.resolve({action:"save_prospect"}) });
  expect(rest.status).toBe(200);
  const restBody = await rest.json();
  const mcp = await mcpPost(request("/api/mcp",{ jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"save_prospect",arguments:payload} }));
  const rpc = await mcp.json();
  expect(rpc.result.isError).toBe(false);
  expect(rpc.result.structuredContent).toEqual(restBody.data);
  expect(restBody.data).toMatchObject({ created:false,duplicate:true,resolution:"review_required",matches:[{prospectId:parentId,matchedOn:["business email domain"]}] });
  expect(restBody.data.message).toContain("No record was created or merged");
  expect((await db.query("SELECT (SELECT count(*) FROM prospects) p,(SELECT count(*) FROM drafts) d,(SELECT count(*) FROM outbound_sends) s,(SELECT count(*) FROM research_jobs) j")).rows).toEqual(before);
});
