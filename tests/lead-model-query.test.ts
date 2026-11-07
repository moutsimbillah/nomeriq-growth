import { afterAll, beforeAll, expect, it } from "vitest";
import { getDb, closeDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { saveProspect, listProspectsPage, countProspects, getProspectOriginFacets } from "@/lib/services/prospects";
import { saveLeadAssessment, getLeadModels, saveAudienceObservation } from "@/lib/services/lead-model";
import { compareLeadPriority, type LeadFinding } from "@/lib/leads/model";
import { ensureBootstrapUser } from "@/lib/auth/session";
const ids:string[]=[]; const marker=`ModelQuery${crypto.randomUUID().replaceAll('-','')}`;
const now=new Date().toISOString();
beforeAll(ensureWorkspaceDefaults);
afterAll(async()=>{const db=await getDb();for(const t of ["prospect_assessment_overrides","prospect_assessments","prospect_audience_observations","prospect_emails","prospect_sources","prospect_aliases"])await db.query(`DELETE FROM ${t} WHERE prospect_id=ANY($1::uuid[])`,[ids]);await db.query("DELETE FROM prospects WHERE id=ANY($1::uuid[])",[ids]);await closeDb();});
async function seed(index:number,excluded=false){
 const key=crypto.randomUUID().replaceAll('-',''),url=`https://${key}.example.test`,profile=`https://instagram.com/${key}`;
 const result=await saveProspect({businessName:`${marker} ${index}`,websiteUrl:url,instagramUrl:profile,categories:["forex"],email:`owner@${key}.example.test`,emailSourceUrl:`${url}/contact`,qualificationStatus:"candidate",actorType:"seed"});ids.push(result.prospect.id);
 const findings:LeadFinding[]=["paid_signals","markets","email","identity","activity"].map(a=>({area:a as LeadFinding["area"],summary:"Source-confirmed fact",sourceUrl:`${url}/signals`,observedAt:now,verdict:"present"}));
 if(excluded)await saveLeadAssessment(result.prospect.id,{assessedAt:now,sourceKind:"research",eligibility:"excluded",exclusionReason:"Education only; no commercial signals",provenanceKey:crypto.randomUUID(),findings});
 else await saveLeadAssessment(result.prospect.id,{assessedAt:now,sourceKind:"research",provenanceKey:crypto.randomUUID(),findings});
 return{id:result.prospect.id,url,profile};
}
it("tier, fit and priority filters and facets match the current model across the whole population",async()=>{
 const a=await seed(1),b=await seed(2); const db=await getDb();
 const before=await getLeadModels([a.id,b.id]);
 const score=before.get(a.id)!.priorityScore!;
 const all=await listProspectsPage({query:marker,tier:"other",productFit:"unknown",minPriority:score,sort:"priority"});
 expect(all.total).toBe(2);expect(new Set(all.rows.map(p=>p.id))).toEqual(new Set([a.id,b.id]));
 expect(await countProspects({query:marker,minPriority:score+1})).toBe(0);
 const facets=await getProspectOriginFacets({query:marker,tier:"other",productFit:"unknown",minPriority:score});
 expect(facets.hasEmail.yes).toBe(2);expect(Object.values(facets.agents).reduce((a,b)=>a+b,0)).toBe(2);
 // Snapshot stays immutable; a valid historical founder decision has priority over later research.
 const userId=(await ensureBootstrapUser({email:`query-${crypto.randomUUID()}@example.test`,name:"Fixture founder",password:crypto.randomUUID()})).id;
 try{
  await db.query("INSERT INTO prospect_assessment_overrides (id,prospect_id,field_name,decision,value,reason,decided_by,provenance_key) VALUES ($1,$2,'priority_score','set','99'::jsonb,'Historical founder decision',$3,$4)",[crypto.randomUUID(),b.id,userId,crypto.randomUUID()]);
  const page=await listProspectsPage({query:marker,sort:"priority"});const models=await getLeadModels(page.rows.map(p=>p.id));
  expect(page.rows.map(p=>p.id)).toEqual([...models.entries()].sort(([,a],[,b])=>compareLeadPriority(a,b)||a.assessedAt!.localeCompare(b.assessedAt!)).map(([id])=>id));
  expect(page.rows[0].id).toBe(b.id);expect((await listProspectsPage({query:marker,minPriority:99})).rows.map(p=>p.id)).toEqual([b.id]);
 }finally{await db.query("DELETE FROM prospect_assessment_overrides WHERE decided_by=$1",[userId]);await db.query("DELETE FROM users WHERE id=$1",[userId]);}
});
it("excluded records are hidden by default but available explicitly; no other record is removed",async()=>{
 const f=await seed(3,true);const all=await listProspectsPage({query:marker});expect(all.rows.some(p=>p.id===f.id)).toBe(false);
 const excluded=await listProspectsPage({query:marker,tier:"excluded"});expect(excluded.rows.map(p=>p.id)).toEqual([f.id]);expect(excluded.total).toBe(1);
});
it("audience filtering uses a maximum, never sums or Telegram to promote a website-email lead",async()=>{
 const f=await seed(4);
 const account=(platform:"instagram"|"youtube"|"telegram",url:string,count:number)=>({platform,accountKey:url,accountUrl:url,countValue:count,countState:"verified" as const,checkedAt:now,sourceUrl:`${f.url}/social`,officialLinkSourceUrl:`${f.url}/social`,provenanceKey:crypto.randomUUID()});
 await saveAudienceObservation(f.id,account("instagram",f.profile,500));await saveAudienceObservation(f.id,account("youtube",`https://youtube.com/@q${f.id}`,600));await saveAudienceObservation(f.id,account("telegram",`https://t.me/q${f.id}`,100000));
 expect((await listProspectsPage({query:marker,audience:1000})).rows.some(p=>p.id===f.id)).toBe(false);
 expect((await listProspectsPage({query:marker,audience:500})).rows.map(p=>p.id)).toEqual([f.id]);
 expect((await listProspectsPage({query:marker,audience:"unknown"})).rows.some(p=>p.id===f.id)).toBe(false);
});
it("stable pagination reaches beyond the former cap and counts and facets never become the window",async()=>{
 const db=await getDb();const batch=Array.from({length:205},(_,i)=>({id:crypto.randomUUID(),name:`${marker} Pagination ${i}`}));ids.push(...batch.map(r=>r.id));
 await db.query(`INSERT INTO prospects (id,business_name,name_key,categories,qualification_status) SELECT x.id::uuid,x.name,x.name,'["forex"]'::jsonb,'candidate' FROM jsonb_to_recordset($1::jsonb) AS x(id text,name text)`,[JSON.stringify(batch)]);
 const filters={query:`${marker} Pagination`,tier:"unassessed" as const,sort:"priority" as const};
 const seen:string[]=[];
 for(let offset=0;offset<205;offset+=50){const page=await listProspectsPage({...filters,offset,limit:50});expect(page.total).toBe(205);seen.push(...page.rows.map(p=>p.id));}
 expect(new Set(seen).size).toBe(205);expect(seen).toHaveLength(205);
 expect(await listProspectsPage({...filters,offset:205,limit:50})).toMatchObject({rows:[],total:205,hasMore:false});
 expect((await getProspectOriginFacets(filters)).hasEmail.no).toBe(205);
});
