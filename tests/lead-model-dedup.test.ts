import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { getDb, closeDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { saveProspect, checkDuplicate, type SaveProspectInput } from "@/lib/services/prospects";
import { saveAudienceObservation } from "@/lib/services/lead-model";
import { businessDomain } from "@/lib/leads/identity";
import { normalizeName } from "@/lib/utils";
const ids:string[]=[];
beforeAll(ensureWorkspaceDefaults);
afterAll(async()=>{vi.restoreAllMocks();const db=await getDb();for(const table of ["prospect_audience_observations","prospect_emails","prospect_sources","prospect_aliases"])await db.query(`DELETE FROM ${table} WHERE prospect_id=ANY($1::uuid[])`,[ids]);await db.query("DELETE FROM prospects WHERE id=ANY($1::uuid[])",[ids]);await closeDb();});
function candidate(extra:Partial<SaveProspectInput>={}):SaveProspectInput{return{businessName:`Dedup ${crypto.randomUUID()}`,categories:["forex"],qualificationStatus:"candidate",actorType:"seed",...extra};}
async function seed(extra:Partial<SaveProspectInput>={}){const saved=await saveProspect(candidate(extra));if(saved.created)ids.push(saved.prospect.id);return saved;}
it("archived and excluded identities remain duplicates; direct names work without aliases",async()=>{
 const key=crypto.randomUUID();const f=await seed({websiteUrl:`https://${key}.example.test`,instagramUrl:`https://instagram.com/${key}`,email:`owner@${key}.example.test`,emailSourceUrl:`https://${key}.example.test/contact`});const db=await getDb();
 await db.query("UPDATE prospects SET archived_at=now(),qualification_status='rejected',rejection_reason='Fixture exclusion' WHERE id=$1",[f.prospect.id]);
 await db.query("DELETE FROM prospect_aliases WHERE prospect_id=$1",[f.prospect.id]);
 for(const input of [{businessName:f.prospect.businessName},{websiteUrl:`https://${key}.example.test`},{instagramUrl:`https://instagram.com/${key}`},{emails:[`owner@${key}.example.test`]}])expect((await checkDuplicate(input)).some(m=>m.prospect.id===f.prospect.id)).toBe(true);
 const repeat=await saveProspect(candidate({businessName:f.prospect.businessName}));expect(repeat).toMatchObject({created:false,duplicate:true});expect(repeat.prospect.id).toBe(f.prospect.id);
});
it("Instagram and Linktree domains never collapse unrelated businesses, while the same linked profile is a duplicate",async()=>{
 const a=crypto.randomUUID(),b=crypto.randomUUID();expect(businessDomain(`https://instagram.com/${a}`)).toBeNull();
 const first=await seed({websiteUrl:`https://instagram.com/${a}`});const second=await seed({websiteUrl:`https://instagram.com/${b}`});expect(first.created&&second.created).toBe(true);
 expect((await checkDuplicate({instagramUrl:`https://instagram.com/${a}`})).some(m=>m.prospect.id===first.prospect.id)).toBe(true);
 // A URL misplaced in the legacy website field still has an exact shared-profile identity.
 expect((await checkDuplicate({websiteUrl:`https://instagram.com/${a}/?utm_source=fixture`})).some(m=>m.prospect.id===first.prospect.id)).toBe(true);
 const link=await seed({websiteUrl:`https://linktr.ee/${a}`});expect((await checkDuplicate({websiteUrl:`https://linktr.ee/${a}/?source=fixture`})).some(m=>m.prospect.id===link.prospect.id)).toBe(true);
 expect((await seed({websiteUrl:`https://linktr.ee/${b}`})).created).toBe(true);
});
it("a shared generic address alone does not merge businesses; a non-generic address does",async()=>{
 const key=crypto.randomUUID();const generic=`info@${key}.example.test`,source=`https://${key}.example.test/contact`;
 await seed({email:generic,emailSourceUrl:source});expect(await checkDuplicate({emails:[generic]})).toHaveLength(0);expect((await seed({email:generic,emailSourceUrl:source})).created).toBe(true);
 const specific=`trader@${key}.example.test`;const f=await seed({email:specific,emailSourceUrl:source});expect((await checkDuplicate({emails:[specific]})).some(m=>m.prospect.id===f.prospect.id)).toBe(true);
});
it("multiple official accounts participate in duplicate checks and cannot be claimed by another business",async()=>{
 const key=crypto.randomUUID();const f=await seed({websiteUrl:`https://${key}.example.test`});const url=`https://instagram.com/secondary_${key}`;
 await saveAudienceObservation(f.prospect.id,{platform:"instagram",accountKey:key,accountUrl:url,countValue:null,countState:"unknown",checkedAt:new Date().toISOString(),sourceUrl:`https://${key}.example.test/social`,officialLinkSourceUrl:`https://${key}.example.test/social`,provenanceKey:crypto.randomUUID()});
 expect((await checkDuplicate({socialAccounts:[{platform:"youtube",url:"https://youtube.com/@unrelated_fixture"},{platform:"instagram",url}]})).some(m=>m.prospect.id===f.prospect.id)).toBe(true);
 const otherKey=crypto.randomUUID();const other=await seed({websiteUrl:`https://${otherKey}.example.test`});
 await expect(saveAudienceObservation(other.prospect.id,{platform:"instagram",accountKey:key,accountUrl:url,countValue:100,countState:"verified",checkedAt:new Date().toISOString(),sourceUrl:`https://${otherKey}.example.test/social`,officialLinkSourceUrl:`https://${otherKey}.example.test/social`,provenanceKey:crypto.randomUUID()})).rejects.toMatchObject({code:"duplicate_social_account"});
});
it("the save transaction rechecks after discovery, before INSERT, without calling the root client inside a transaction",async()=>{
 const db=await getDb();const input=candidate();const contender=crypto.randomUUID();ids.push(contender);const original=db.transaction.bind(db);
 const spy=vi.spyOn(db,"transaction").mockImplementationOnce(async fn=>{
  // Simulate the other writer's committed row AFTER discovery but BEFORE this transaction starts.
  await db.query("INSERT INTO prospects (id,business_name,name_key,categories) VALUES ($1,$2,$3,'[\"forex\"]')",[contender,input.businessName,normalizeName(input.businessName)]);
  return original(fn);
 });
 try{const saved=await saveProspect(input);expect(saved).toMatchObject({created:false,duplicate:true});expect(saved.prospect.id).toBe(contender);}finally{spy.mockRestore();}
 expect((await db.query("SELECT id FROM prospects WHERE name_key=$1",[normalizeName(input.businessName)])).rows).toHaveLength(1);
});
it("simultaneous saves create one business, not two",async()=>{
 const input=candidate();const result=await Promise.all([saveProspect(input),saveProspect(input)]);ids.push(...result.filter(r=>r.created).map(r=>r.prospect.id));expect(result.filter(r=>r.created)).toHaveLength(1);expect(new Set(result.map(r=>r.prospect.id)).size).toBe(1);
});
