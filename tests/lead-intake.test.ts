import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
const auth=vi.hoisted(()=>({id:""}));
vi.mock("@/lib/auth/session",async original=>({...await original<typeof import("@/lib/auth/session")>(),requireEditor:async()=>({id:auth.id,role:"founder"})}));
import { getDb,closeDb } from "@/lib/db/client";
import { ensureBootstrapUser } from "@/lib/auth/session";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { createApiKey } from "@/lib/agent/apiKeys";
import { saveProspect,updateProspect,recordFounderEnteredEmail,type SaveProspectInput } from "@/lib/services/prospects";
import { getLeadModel,setAssessmentOverride } from "@/lib/services/lead-model";
import { assertLeadOutreachAllowed } from "@/lib/services/lead-outreach-guard";
import { POST as portalPost } from "@/app/api/leads/route";
import { POST as restPost } from "@/app/api/agent/v1/[action]/route";
import { POST as mcpPost } from "@/app/api/mcp/route";
import type { LeadFinding } from "@/lib/leads/model";
const ids:string[]=[],names:string[]=[];
let bearer="",reader="";
const baseline=new Map<string,number>();
const sideEffectTables=["outbound_sends","drafts","research_jobs","campaigns","research_providers","provider_credentials","suppressions"];
const checkedAt=new Date().toISOString();
function payload(kind:"website"|"email_only"|"category_b"|"excluded"="website"):SaveProspectInput{
 const key=crypto.randomUUID().replaceAll("-",""); const website=`https://${key}.example.test`,profile=`https://instagram.com/${key}`,url=kind==="email_only"?profile:website;
 const businessName=`Intake ${key}`;names.push(businessName);
 const fact=(area:LeadFinding["area"]):LeadFinding=>({area,summary:`Synthetic official ${area} evidence`,sourceUrl:`${url}/${area}`,observedAt:checkedAt,verdict:"present"});
 return{businessName,websiteUrl:kind==="email_only"?null:website,instagramUrl:profile,categories:kind==="excluded"?[]:["forex"],signalDescription:"Synthetic official paid Forex VIP signals service",sources:[{url:`${url}/signals`,label:"Official paid signals"}],email:kind==="category_b"||kind==="excluded"?null:`owner@${key}.example.test`,emailSourceUrl:kind==="email_only"?profile:`${website}/contact`,emailSourceType:kind==="email_only"?"official_social":"official_website",actorType:"api",leadAssessment:{assessedAt:checkedAt,eligibility:kind==="excluded"?"excluded":"eligible",exclusionReason:kind==="excluded"?"Stocks and options only; no eligible signal market":null,findings:[fact("paid_signals"),fact("markets"),fact("identity"),fact("activity"),...(kind==="category_b"||kind==="excluded"?[]:[fact("email")])]},contactRoutes:kind==="category_b"?[{platform:"telegram",routeKind:"bot",routeUrl:`https://t.me/${key}_bot`,officialStatus:"verified",checkedAt,sourceUrl:`${website}/contact`},{platform:"website",routeKind:"form",routeUrl:`${website}/contact`,officialStatus:"verified",checkedAt,sourceUrl:`${website}/contact`}]:[]};
}
async function count(table:string){const db=await getDb();return Number((await db.query<{n:string}>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);}
beforeAll(async()=>{
 await ensureWorkspaceDefaults();auth.id=(await ensureBootstrapUser({email:`intake-${crypto.randomUUID()}@example.test`,name:"Intake founder",password:crypto.randomUUID()})).id;
 bearer=(await createApiKey({name:"Synthetic intake writer",assistant:"custom",scopes:["research:read","research:write"],userId:auth.id})).key;
 reader=(await createApiKey({name:"Synthetic intake reader",assistant:"custom",scopes:["research:read"],userId:auth.id})).key;
 for(const table of sideEffectTables)baseline.set(table,await count(table));
});
beforeEach(()=>vi.stubGlobal("fetch",vi.fn(()=>{throw Error("Intake must not call any external model or service");})));
afterEach(async()=>{for(const table of sideEffectTables)expect(await count(table)).toBe(baseline.get(table));vi.unstubAllGlobals();});
afterAll(async()=>{
 const db=await getDb();const rows=(await db.query<{id:string}>("SELECT id FROM prospects WHERE business_name=ANY($1::text[])",[names])).rows;ids.push(...rows.map(r=>r.id));
 for(const table of ["prospect_assessment_overrides","prospect_assessments","prospect_audience_observations","prospect_contact_route_observations","prospect_sources","prospect_emails","prospect_aliases"])await db.query(`DELETE FROM ${table} WHERE prospect_id=ANY($1::uuid[])`,[ids]);
 await db.query("DELETE FROM prospects WHERE id=ANY($1::uuid[])",[ids]);await db.query("DELETE FROM api_keys WHERE created_by=$1",[auth.id]);await db.query("DELETE FROM users WHERE id=$1",[auth.id]);await closeDb();
});
async function transport(kind:"rest"|"mcp",data:unknown,credential=bearer){
 const path=kind==="rest"?"/api/agent/v1/save_prospect":"/api/mcp";
 const body=kind==="rest"?data:{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"save_prospect",arguments:data}};
 const request=new Request(`http://localhost:3100${path}`,{method:"POST",headers:{authorization:`Bearer ${credential}`,"content-type":"application/json"},body:JSON.stringify(body)});
 const response=kind==="rest"?await restPost(request,{params:Promise.resolve({action:"save_prospect"})}):await mcpPost(request);
 const json=await response.json();return{status:response.status,ok:kind==="rest"?json.ok:json.result?.isError===false,data:kind==="rest"?json.data:json.result?.structuredContent,json};
}
function publicPayload(value:SaveProspectInput){const {actorType,...data}=value;void actorType;return data;}
it("saves a website/email lead, its per-account audience and derived tier atomically",async()=>{
 const input=payload();const profile=input.instagramUrl!;
 input.audiences=[{platform:"instagram",accountKey:"ignored-claim",accountUrl:profile,countValue:1200,countState:"verified",checkedAt,sourceUrl:profile}];
 const saved=await saveProspect(input);ids.push(saved.prospect.id);
 expect(saved).toMatchObject({created:true,leadModel:{tier:"tier_1",eligibility:"eligible",productFit:"unknown"}});
 expect(saved.prospect.qualificationStatus).toBe("verified");expect(saved.leadModel!.audiences).toHaveLength(1);
 expect((await getLeadModel(saved.prospect.id)).assessmentId).toBe(saved.leadModel!.assessmentId);
 const db=await getDb();
 const audit=(await db.query<{metadata:Record<string,unknown>}>("SELECT metadata FROM audit_log WHERE action='lead.assessment_applied' AND entity_id=$1",[saved.prospect.id])).rows[0].metadata;
 expect(audit).toMatchObject({previousVerifiedAt:null,newQualificationStatus:"verified",newStatus:"verified"});
 expect(audit.newVerifiedAt).toEqual(expect.any(String));
 expect(audit).toHaveProperty("previousQualificationStatus");
 expect(audit).toHaveProperty("previousRejectionReason");
 expect((await db.query("SELECT verified_at=($2::timestamptz) AS exact FROM prospects WHERE id=$1",[saved.prospect.id,audit.newVerifiedAt])).rows[0].exact).toBe(true);
});
it("a published official-profile email without a website remains outreach-eligible under its own non-counted tier",async()=>{
 const input=payload("email_only"),saved=await saveProspect(input);ids.push(saved.prospect.id);
 expect(saved.leadModel?.tier).toBe("email_no_website");expect(saved.prospect.qualificationStatus).toBe("verified");await expect(assertLeadOutreachAllowed(saved.prospect.id)).resolves.toBeUndefined();
});
it.each(["rest","mcp"] as const)("%s saves Category B without a guessed email and never prompts an email draft",async kind=>{
 const data=publicPayload(payload("category_b"));const response=await transport(kind,data);
 expect(response.ok).toBe(true);ids.push(response.data.prospect.id);
 expect(response.data.leadModel).toMatchObject({tier:"category_b",eligibility:"eligible"});expect(response.data.leadModel.contactRoutes).toHaveLength(2);
 expect(response.data.message).toContain("Never prepare or send email");
 await expect(assertLeadOutreachAllowed(response.data.prospect.id)).rejects.toMatchObject({code:"alternative_contact_only"});
});
it("the portal saves an excluded stocks-only record with no eligible-market placeholder or email",async()=>{
 const data=publicPayload(payload("excluded"));
 const response=await portalPost(new Request("http://localhost:3100/api/leads",{method:"POST",headers:{origin:"http://localhost:3100","content-type":"application/json"},body:JSON.stringify(data)}));
 expect(response.status).toBe(200);const saved=(await response.json()).data;ids.push(saved.prospect.id);
 expect(saved.leadModel).toMatchObject({tier:"excluded",eligibility:"excluded",exclusionReason:"Stocks and options only; no eligible signal market"});expect(saved.prospect.categories).toEqual([]);expect(saved.prospect.qualificationStatus).toBe("rejected");
});
it("invalid model evidence rolls back the prospect, addresses, sources and observations together",async()=>{
 const input=payload();input.leadAssessment!.findings=[{area:"paid_signals",summary:"Not this business's evidence",sourceUrl:"https://unrelated.example.test/signals",observedAt:checkedAt,verdict:"present"}];
 await expect(saveProspect(input)).rejects.toMatchObject({code:"unlinked_assessment_source"});const db=await getDb();
 expect((await db.query("SELECT id FROM prospects WHERE business_name=$1",[input.businessName])).rows).toHaveLength(0);
 expect((await db.query("SELECT id FROM prospect_emails WHERE normalized_email=$1",[input.email])).rows).toHaveLength(0);
});
it("duplicate retries cannot replace original assessments or a founder override",async()=>{
 const input=payload(),saved=await saveProspect(input);ids.push(saved.prospect.id);
 await setAssessmentOverride(saved.prospect.id,{field:"product_fit",decision:"set",value:"high",reason:"Founder reviewed the opportunity",provenanceKey:crypto.randomUUID(),actorUserId:auth.id});
 const before=await getLeadModel(saved.prospect.id);input.leadAssessment!.productFit="low";
 const retry=await saveProspect(input);expect(retry).toMatchObject({created:false,duplicate:true});expect(await getLeadModel(saved.prospect.id)).toEqual(before);
});
it.each(["rest","mcp"] as const)("%s derives verification from a modern assessment, not the caller's candidate label",async kind=>{
 const input=publicPayload(payload());
 const response=await transport(kind,{...input,qualificationStatus:"candidate"});
 expect(response.ok).toBe(true);ids.push(response.data.prospect.id);
 expect(response.data.prospect.qualificationStatus).toBe("verified");
 expect(response.data.leadModel).toMatchObject({eligibility:"eligible",tier:"other"});
});
it.each(["rest","mcp"] as const)("%s cannot create a verified lead by omitting the assessment or claiming verified",async kind=>{
 for(const label of [undefined,"verified"]){
  const input=publicPayload(payload());delete input.leadAssessment;
  const response=await transport(kind,{...input,qualificationStatus:label});
  expect(response.ok).toBe(true);ids.push(response.data.prospect.id);
  expect(response.data.prospect).toMatchObject({qualificationStatus:"candidate",verifiedAt:null});
  expect((await getLeadModel(response.data.prospect.id)).assessmentId).toBeNull();
  expect(response.data.message).toContain("assessment");
 }
});
it.each(["founder","deepseek","seed","api"] as const)("%s has no legacy verification exemption in the shared save service",async actorType=>{
 const input=payload();delete input.leadAssessment;
 const saved=await saveProspect({...input,actorType,qualificationStatus:"verified"});ids.push(saved.prospect.id);
 expect(saved.prospect).toMatchObject({qualificationStatus:"candidate",verifiedAt:null});
});
it("the portal cannot turn a legacy verified label into verification without assessment",async()=>{
 const input=publicPayload(payload());delete input.leadAssessment;
 const response=await portalPost(new Request("http://localhost:3100/api/leads",{method:"POST",headers:{origin:"http://localhost:3100","content-type":"application/json"},body:JSON.stringify({...input,qualificationStatus:"verified"})}));
 expect(response.status).toBe(200);const saved=(await response.json()).data;ids.push(saved.prospect.id);
 expect(saved.prospect).toMatchObject({qualificationStatus:"candidate",verifiedAt:null});
});
it("an incomplete modern assessment cannot be promoted through the generic edit path",async()=>{
 const input=payload();input.leadAssessment!.findings=input.leadAssessment!.findings!.filter(f=>f.area!=="activity");
 const saved=await saveProspect({...input,qualificationStatus:"verified"});ids.push(saved.prospect.id);
 expect(saved.prospect.qualificationStatus).toBe("candidate");
 await expect(updateProspect(saved.prospect.id,{qualificationStatus:"verified"},auth.id)).rejects.toMatchObject({code:"assessment_required"});
});
it("candidate creation followed by an edit cannot bypass modern qualification",async()=>{
 const input=payload();delete input.leadAssessment;
 const saved=await saveProspect(input);ids.push(saved.prospect.id);
 await expect(updateProspect(saved.prospect.id,{qualificationStatus:"verified"},auth.id)).rejects.toMatchObject({code:"assessment_required"});
 const row=(await (await getDb()).query("SELECT qualification_status,verified_at FROM prospects WHERE id=$1",[saved.prospect.id])).rows[0];
 expect(row).toEqual({qualification_status:"candidate",verified_at:null});
});
it("historical verified records and their evidence survive duplicate saves byte-for-byte",async()=>{
 const input=payload();delete input.leadAssessment;
 const saved=await saveProspect(input);ids.push(saved.prospect.id);const db=await getDb();
 // Explicit historical fixture: no production bypass or migration rewrites old records.
 await db.query("UPDATE prospects SET qualification_status='verified',verified_at='2026-01-01T00:00:00Z',status='verified' WHERE id=$1",[saved.prospect.id]);
 const snapshot=async()=>Promise.all([db.query("SELECT row_to_json(p)::text AS value FROM prospects p WHERE id=$1",[saved.prospect.id]),db.query("SELECT row_to_json(e)::text AS value FROM prospect_emails e WHERE prospect_id=$1 ORDER BY id",[saved.prospect.id]),db.query("SELECT row_to_json(s)::text AS value FROM prospect_sources s WHERE prospect_id=$1 ORDER BY id",[saved.prospect.id])]).then(results=>results.map(r=>r.rows));
 const before=await snapshot();
 const retry=await saveProspect({...input,qualificationStatus:"verified"});
 expect(retry).toMatchObject({created:false,duplicate:true,prospect:{qualificationStatus:"verified"}});
 expect(await snapshot()).toEqual(before);
 expect((await getLeadModel(saved.prospect.id)).assessmentId).toBeNull();
});
it.each(["email_only","category_b"] as const)("a %s record cannot be promoted to verified through the edit path without a fresh assessment",async kind=>{
 const input=payload(kind);const saved=await saveProspect(input);ids.push(saved.prospect.id);
 expect(saved.prospect.qualificationStatus).toBe("verified"); // the assessment's own eligible non-target tier
 expect(saved.leadModel?.tier).toBe(kind==="email_only"?"email_no_website":"category_b");
 // Put the row in the state the gate protects: not already carrying a verified decision.
 await (await getDb()).query("UPDATE prospects SET qualification_status='candidate',verified_at=null,status='new' WHERE id=$1",[saved.prospect.id]);
 const key=crypto.randomUUID().replaceAll("-","");
 await recordFounderEnteredEmail(saved.prospect.id,`owner@${key}.example.test`);
 await expect(updateProspect(saved.prospect.id,{websiteUrl:`https://${key}.example.test`,qualificationStatus:"verified"},auth.id)).rejects.toMatchObject({code:"assessment_required"});
 const row=(await (await getDb()).query("SELECT qualification_status,website_url FROM prospects WHERE id=$1",[saved.prospect.id])).rows[0];
 expect(row).toEqual({qualification_status:"candidate",website_url:saved.prospect.websiteUrl}); // refused edit wrote nothing
});
it("an already-qualified modern lead can still be marked verified through the edit path",async()=>{
 const saved=await saveProspect(payload());ids.push(saved.prospect.id);
 await (await getDb()).query("UPDATE prospects SET qualification_status='candidate',verified_at=null,status='new' WHERE id=$1",[saved.prospect.id]);
 const updated=await updateProspect(saved.prospect.id,{qualificationStatus:"verified"},auth.id);
 expect(updated.qualificationStatus).toBe("verified");
});
it.each(["rest","mcp"] as const)("%s refuses missing write scope and forged founder/history metadata",async kind=>{
 expect((await transport(kind,publicPayload(payload("category_b")),reader)).ok).not.toBe(true);
 const value=publicPayload(payload("category_b"));const forged={...value,leadAssessment:{...value.leadAssessment,sourceKind:"founder",legacySnapshot:{invented:true}}};
 expect((await transport(kind,forged)).ok).not.toBe(true);
 expect((await transport(kind,{...value,send:true})).ok).not.toBe(true);
});
