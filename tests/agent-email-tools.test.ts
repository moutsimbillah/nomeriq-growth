import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { getDb, closeDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { hashPassword } from "@/lib/auth/password";
import { createApiKey, type ApiKeyIdentity } from "@/lib/agent/apiKeys";
import { DEFAULT_SCOPES } from "@/lib/agent/scopes";
import { runAgentAction, runMcpTool } from "@/lib/agent/service";
import { getFolderInbox } from "@/lib/services/inbox";
import { FOLDERS } from "@/lib/services/folders";
import { POST as restPost } from "@/app/api/agent/v1/[action]/route";
import { POST as mcpPost } from "@/app/api/mcp/route";
import { GET as openapiGet } from "@/app/api/agent/openapi/route";

const PREFIX = `agent-email-${crypto.randomUUID().slice(0, 8)}`;
const actorIds: string[] = [];
const ids: string[] = [];
const key: ApiKeyIdentity = { id: `oauth:${PREFIX}`, name: "Hermes", assistant: "custom",
  scopes: ["folders:read", "followups:read", "followups:write", "conversations:read"] };
actorIds.push(key.id);
let userId = "", dueId = "", candidateId = "";
let bearer = "";
const before = new Map<string, number>();

async function count(table: string) {
  const db = await getDb();
  // Only internal allowlisted names, never input data.
  if (!["outbound_sends", "campaigns", "research_jobs"].includes(table)) throw new Error("bad table");
  return Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n);
}
function request(url: string, body: unknown, credential = bearer) {
  return new Request(`http://localhost:3100${url}`, { method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function rest(action: string, args: unknown, credential = bearer) {
  return restPost(request(`/api/agent/v1/${action}`, args, credential), { params: Promise.resolve({ action }) });
}
async function mcp(action: string, args: unknown, credential = bearer) {
  return mcpPost(request("/api/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: action, arguments: args } }, credential));
}

beforeAll(async () => {
  const db = await getDb();
  await ensureWorkspaceDefaults();
  userId = crypto.randomUUID();
  await db.query(`INSERT INTO users(id,email,normalized_email,name,password_hash,role) VALUES($1,$2,$2,'Email test',$3,'founder')`,
    [userId, `${PREFIX}@example.test`, hashPassword(crypto.randomUUID())]);
  const created = await createApiKey({ name: PREFIX, assistant: "hermes", scopes: key.scopes, userId });
  bearer = created.key; actorIds.push(created.id, userId);
  const population = await db.query<{ id: string }>(`INSERT INTO prospects(id,business_name,name_key,domain_key,status,qualification_status,created_by_type,source_agent)
    SELECT gen_random_uuid(),$1||'-'||g,$1||'-'||g,$1||'-'||g||'.example.test','verified','verified','founder','unknown'
    FROM generate_series(1,507) g RETURNING id`, [PREFIX]);
  ids.push(...population.rows.map(row => row.id));
  candidateId = crypto.randomUUID(); dueId = crypto.randomUUID(); const archived = crypto.randomUUID(); ids.push(candidateId, dueId, archived);
  await db.query(`INSERT INTO prospects(id,business_name,name_key,domain_key,status,qualification_status,created_by_type,archived_at)
    VALUES($1,$4||'-candidate',$4||'-candidate',$4||'-candidate.example.test','new','candidate','founder',NULL),
    ($2,$4||'-due',$4||'-due',$4||'-due.example.test','contacted','verified','founder',NULL),
    ($3,$4||'-archived',$4||'-archived',$4||'-archived.example.test','verified','verified','founder',now())`, [candidateId, dueId, archived, PREFIX]);
  await db.query(`INSERT INTO prospect_emails(id,prospect_id,email,normalized_email,source_url,source_type,is_primary)
    VALUES(gen_random_uuid(),$1,$2,$2,'https://example.test/contact','official_website',true)`, [dueId, `${PREFIX}-due@example.test`]);
  const convo = crypto.randomUUID();
  await db.query(`INSERT INTO conversations(id,prospect_id,subject,last_inbound_at,last_message_at)
    VALUES($1,$2,'Private synthetic subject',NULL,NULL)`, [convo, candidateId]);
  await db.query(`INSERT INTO messages(id,conversation_id,prospect_id,direction,source,from_email,subject,body_text,snippet,received_at)
    VALUES(gen_random_uuid(),$1,NULL,'inbound','seed','sender@example.test','Private synthetic subject','PRIVATE SYNTHETIC MESSAGE','PRIVATE SYNTHETIC MESSAGE',now())`, [convo]);
  const dueConvo = crypto.randomUUID();
  await db.query(`INSERT INTO conversations(id,prospect_id,subject,last_outbound_at,last_message_at)
    VALUES($1,$2,'Earlier contact',now()-interval '10 days',now()-interval '10 days')`, [dueConvo, dueId]);
  await db.query(`INSERT INTO drafts(id,prospect_id,kind,sequence,status,subject,body,recipient_email,ai_generated,created_by_type,sent_at)
    VALUES(gen_random_uuid(),$1,'first_contact',0,'sent','Earlier contact','Earlier recorded contact',$2,false,'founder',now()-interval '10 days')`, [dueId, `${PREFIX}-due@example.test`]);
  await db.query(`INSERT INTO messages(id,conversation_id,prospect_id,direction,source,from_email,sent_at,subject,body_text,delivery_status)
    VALUES(gen_random_uuid(),$1,$2,'outbound','seed','owner@example.test',now()-interval '10 days','Earlier contact','Earlier recorded contact','accepted')`, [dueConvo, dueId]);
  for (const table of ["outbound_sends", "campaigns", "research_jobs"]) before.set(table, await count(table));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  const db = await getDb();
  await db.query(`DELETE FROM audit_log WHERE actor_id=ANY($1::text[]) OR entity_id=ANY($2::text[])`, [actorIds, ids]);
  await db.query(`DELETE FROM messages WHERE prospect_id=ANY($1::uuid[]) OR conversation_id IN (SELECT id FROM conversations WHERE prospect_id=ANY($1::uuid[]))`, [ids]);
  await db.query(`DELETE FROM conversations WHERE prospect_id=ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM drafts WHERE prospect_id=ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM prospect_emails WHERE prospect_id=ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM prospects WHERE id=ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM api_keys WHERE created_by=$1`, [userId]);
  await db.query(`DELETE FROM users WHERE id=$1`, [userId]);
  await closeDb();
});

describe("explicit email scopes and strict execution inputs", () => {
  const actions = ["get_folder_counts", "list_folder", "list_follow_ups_due", "save_follow_up_drafts"];
  it("default keys cannot use any new email tool, on either shared dispatch entry", async () => {
    const minimal = { ...key, scopes: [...DEFAULT_SCOPES] };
    for (const run of [runAgentAction, runMcpTool]) for (const action of actions) {
      await expect(run(minimal, action, {})).rejects.toMatchObject({ status: 403, code: "insufficient_scope" });
    }
  });
  it("each content-bearing tool needs both its narrow permission and explicit conversation permission", async () => {
    for (const [action, scope] of [["list_folder", "folders:read"], ["list_follow_ups_due", "followups:read"], ["save_follow_up_drafts", "followups:write"]]) {
      for (const scopes of [[scope], ["conversations:read"]]) await expect(runMcpTool({ ...key, scopes }, action, {})).rejects.toMatchObject({ status: 403 });
    }
  });
  it("counts-only access returns definitions and exact counts, never snippets or lead content", async () => {
    const result = await runAgentAction({ ...key, scopes: ["folders:read"] }, "get_folder_counts", { query: PREFIX });
    const inbox = await getFolderInbox({ query: PREFIX, countsOnly: true });
    const folders = result.data.folders as { key: string; count: number }[];
    expect(folders.map(row => row.key)).toEqual(FOLDERS.map(row => row.key));
    expect(result.data.archivedCount).toBe(1);
    expect(result.data.totalActive).toBe(509);
    expect(folders.reduce((n, row) => n + row.count, 0)).toBe(509);
    expect(inbox.rows).toEqual([]); expect(inbox.focused).toBeNull();
    expect(JSON.stringify(result.data)).not.toMatch(/PRIVATE SYNTHETIC|Private synthetic|prospectId|contactEmail|snippet/);
  });
  it("rejects unknown fields, invalid filters, invalid folder, and unbounded/noninteger pagination", async () => {
    for (const [action, args] of [
      ["get_folder_counts", { status: "send" }], ["get_folder_counts", { query: " " }],
      ["get_folder_counts", { sender: "arbitrary" }], ["get_folder_counts", { agent: "invented" }],
      ["list_folder", {}], ["list_folder", { folder: "made_up" }],
      ["list_folder", { folder: "waiting", limit: 101 }], ["list_folder", { folder: "waiting", offset: -1 }],
      ["list_follow_ups_due", { offset: 1.5 }], ["list_follow_ups_due", { limit: Infinity }],
      ["save_follow_up_drafts", { drafts: [] }],
      ["save_follow_up_drafts", { drafts: Array.from({ length: 51 }, () => ({ prospectId: dueId, expectedSequence: 1, subject: "Hi", body: "A valid long message to review." })) }],
    ] as [string, Record<string, unknown>][]) await expect(runAgentAction(key, action, args)).rejects.toMatchObject({ status: 400, code: "invalid_arguments" });
    const valid = { prospectId: dueId, expectedSequence: 1, subject: "Hello", body: "A complete message for founder review." };
    for (const drafts of [[valid, valid], [{ ...valid, recipient: "not-stored@example.test" }], [{ ...valid, status: "approved" }], [{ ...valid, expectedSequence: 0 }]]) {
      await expect(runMcpTool(key, "save_follow_up_drafts", { drafts })).rejects.toMatchObject({ status: 400, code: "invalid_arguments" });
    }
  });
});

describe("actual folder traversal and due list", () => {
  it("includes conversation-backed candidates and exposes an actionable final page beyond 500", async () => {
    const candidate = await runMcpTool(key, "list_folder", { query: PREFIX, folder: "needs_reply" });
    expect((candidate.data.rows as { prospectId: string }[]).map(row => row.prospectId)).toContain(candidateId);
    const first = await runMcpTool(key, "list_folder", { query: PREFIX, folder: "new_leads", limit: 100, agent: "unknown" });
    const end = await runMcpTool(key, "list_folder", { query: PREFIX, folder: "new_leads", limit: 100, offset: 500, agent: "unknown" });
    expect(first.data).toMatchObject({ total: 507, hasMore: true, nextOffset: 100 });
    expect(end.data).toMatchObject({ total: 507, hasMore: false, nextOffset: null });
    expect(end.data.rows).toHaveLength(7);
    const firstIds = (first.data.rows as { prospectId: string }[]).map(row => row.prospectId);
    expect((end.data.rows as { prospectId: string }[]).every(row => !firstIds.includes(row.prospectId))).toBe(true);
    const empty = await runAgentAction(key, "list_folder", { query: PREFIX, folder: "new_leads", offset: 507 });
    expect(empty.data).toMatchObject({ total: 507, rows: [], hasMore: false, nextOffset: null });
  });
  it("due list uses a true total and excludes already prepared drafts", async () => {
    const due = await runAgentAction(key, "list_follow_ups_due", { limit: 100 });
    expect((due.data.rows as { prospectId: string }[]).some(row => row.prospectId === dueId)).toBe(true);
    const empty = await runMcpTool(key, "list_follow_ups_due", { offset: Number(due.data.total) });
    expect(empty.data).toMatchObject({ rows: [], hasMore: false, nextOffset: null });
  });
});

it("REST and MCP execute the same real scoped logic and reject nonobject arguments", async () => {
  const args = { query: PREFIX };
  const response = await rest("get_folder_counts", args);
  const rpc = await (await mcp("get_folder_counts", args)).json();
  expect(response.status).toBe(200); expect(rpc.result.isError).toBe(false);
  expect((await response.json()).data).toEqual(rpc.result.structuredContent);
  for (const bad of [[], null, 17, "not an object"]) {
    expect((await rest("get_folder_counts", bad)).status).toBe(400);
    expect((await (await mcp("get_folder_counts", bad)).json()).error.code).toBe(-32602);
  }
});
it("bulk save creates only a draft, repeat MCP save preserves it, and audit has counts not content", async () => {
  const payload = { drafts: [{ prospectId: dueId, expectedSequence: 1, subject: "A synthetic follow-up question", body: "Hi team, would a short discovery call help clarify your workflow?\n\nBest," }] };
  const response = await rest("save_follow_up_drafts", payload);
  expect(response.status).toBe(200); const result = await response.json(); expect(result.data.saved).toBe(1);
  const preserved = await (await mcp("save_follow_up_drafts", payload)).json();
  expect(preserved.result.isError).toBe(false); expect(preserved.result.structuredContent.preserved).toBe(1);
  const db = await getDb();
  const rows = await db.query<{ status: string; founder_edited: boolean; subject: string }>(`SELECT status,founder_edited,subject FROM drafts WHERE prospect_id=$1 AND kind='follow_up'`, [dueId]);
  expect(rows.rows).toEqual([{ status: "draft", founder_edited: false, subject: payload.drafts[0].subject }]);
  for (const table of ["outbound_sends", "campaigns", "research_jobs"]) expect(await count(table), table).toBe(before.get(table));
  const audit = await db.query<{ metadata: Record<string, unknown> }>(`SELECT metadata FROM audit_log WHERE actor_id=ANY($1::text[]) AND action='save_follow_up_drafts'`, [actorIds]);
  expect(audit.rows.length).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(audit.rows)).not.toContain(payload.drafts[0].subject);
  expect(JSON.stringify(audit.rows)).not.toContain(payload.drafts[0].body);
  expect(audit.rows.some(row => Number((row.metadata.batch as { saved: number })?.saved) === 1)).toBe(true);
  const due = await runAgentAction(key, "list_follow_ups_due", {});
  expect((due.data.rows as { prospectId: string }[]).some(row => row.prospectId === dueId)).toBe(false);
});
it("OpenAPI marks only the draft-save extension consequential and publishes bounded input", async () => {
  const schema = await (await openapiGet(new Request("http://localhost:3100/api/agent/openapi"))).json();
  expect(schema.paths["/api/agent/v1/save_follow_up_drafts"].post["x-openai-isConsequential"]).toBe(true);
  for (const action of ["get_folder_counts", "list_folder", "list_follow_ups_due"]) expect(schema.paths[`/api/agent/v1/${action}`].post["x-openai-isConsequential"]).toBe(false);
  expect(schema.paths["/api/agent/v1/save_follow_up_drafts"].post.requestBody.content["application/json"].schema.properties.drafts.maxItems).toBe(50);
});

it("Settings offers both downloads per platform, with independent opt-in email checkboxes", () => {
  const ui = readFileSync("src/components/settings/integrations.tsx", "utf8");
  for (const platform of ["claude", "chatgpt", "gemini", "hermes"]) expect(ui).toContain(`<SkillDownloads platform="${platform}" />`);
  expect(ui).toContain("platform=${platform}&format=loader");
  expect(ui).toContain("platform=${platform}&format=full");
  for (const scope of ["folders:read", "followups:read", "followups:write"]) expect(ui).toContain(`["${scope}",`);
  expect(ui).toContain("data-api-scope={scope}");
  expect(ui).toContain("It is not granted automatically.");
  expect(ui).toContain("useState<string[]>([...DEFAULT_SCOPES])");
});
