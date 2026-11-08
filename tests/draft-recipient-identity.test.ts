import {afterAll,afterEach,beforeAll,expect,it,vi} from "vitest";
import {getDb,closeDb,type DbClient} from "@/lib/db/client";
import {ensureWorkspaceDefaults} from "@/lib/services/settings";
import {saveProspect} from "@/lib/services/prospects";
import {saveDraft,approveDraft} from "@/lib/services/drafts";
import {hashPassword} from "@/lib/auth/password";

const ids:string[]=[];
let db:DbClient,userId:string;
beforeAll(async()=>{
  await ensureWorkspaceDefaults();db=await getDb();userId=crypto.randomUUID();
  await db.query("INSERT INTO users(id,email,normalized_email,name,password_hash,role) VALUES($1,$2,$2,'Draft identity',$3,'founder')",[userId,`${userId}@draft-identity.test`,hashPassword(crypto.randomUUID())]);
});
afterEach(()=>vi.restoreAllMocks());
afterAll(async()=>{
  for(const table of ["messages","conversations","drafts","prospect_emails","prospect_sources","prospect_aliases"])await db.query(`DELETE FROM ${table} WHERE prospect_id=ANY($1::uuid[])`,[ids]);
  await db.query("DELETE FROM prospects WHERE id=ANY($1::uuid[])",[ids]);
  await db.query("DELETE FROM users WHERE id=$1",[userId]);await closeDb();
});
async function fixture(){
  const key=crypto.randomUUID(),domain=`${key}.draft-identity.test`;
  const saved=await saveProspect({businessName:`Draft identity ${key}`,websiteUrl:`https://${domain}`,email:`info@${domain}`,emailSourceUrl:`https://${domain}/contact`,categories:["forex"],signalDescription:"Paid Forex signal subscription.",sources:[{url:`https://${domain}/pricing`,label:"Synthetic pricing"}],qualificationStatus:"verified",actorType:"seed"});
  expect(saved.created).toBe(true);ids.push(saved.prospect.id);
  const draftId=crypto.randomUUID();
  await db.query(`INSERT INTO drafts(id,prospect_id,kind,sequence,status,subject,body,recipient_email,created_by_type)
    VALUES($1,$2,'first_contact',0,'draft','A short question','An original synthetic question for your signal business.',$3,'founder')`,[draftId,saved.prospect.id,`info@${domain}`]);
  return {id:saved.prospect.id,draftId,domain,email:`info@${domain}`};
}
async function contactedMailbox(){
  const owner=await fixture(),email=`private-${crypto.randomUUID()}@gmail.com`;
  await db.query(`INSERT INTO messages(id,prospect_id,direction,source,from_email,to_emails,sent_at,delivery_status)
    VALUES(gen_random_uuid(),$1,'outbound','seed','founder@sender.test',$2::jsonb,now(),'accepted')`,[owner.id,JSON.stringify([email])]);
  return email;
}
function edit(f:{draftId:string},email:string){return saveDraft({id:f.draftId,subject:"A revised question",body:"A revised synthetic question for your signal business.",recipientEmail:email,actorType:"founder",actorUserId:userId});}
async function addressCount(id:string,email:string){return (await db.query("SELECT id FROM prospect_emails WHERE prospect_id=$1 AND normalized_email=$2",[id,email])).rows.length;}

it.each(["edit","approve"])("%s refuses another lead's contacted free-mail address without attaching it",async operation=>{
  const held=await contactedMailbox(),f=await fixture();
  if(operation==="approve")await db.query("UPDATE drafts SET recipient_email=$2 WHERE id=$1",[f.draftId,held]);
  const before=(await db.query("SELECT * FROM drafts WHERE id=$1",[f.draftId])).rows;
  await expect(operation==="edit"?edit(f,held):approveDraft(f.draftId,userId)).rejects.toMatchObject({code:"duplicate_contact",status:409});
  expect(await addressCount(f.id,held)).toBe(0);
  expect((await db.query("SELECT * FROM drafts WHERE id=$1",[f.draftId])).rows).toEqual(before);
  expect((await db.query("SELECT id FROM outbound_sends WHERE prospect_id=$1",[f.id])).rows).toHaveLength(0);
});

it("a valid new founder recipient is recorded with the draft edit, without sending",async()=>{
  const f=await fixture(),email=`owner@${f.domain}`;
  expect((await edit(f,email)).recipientEmail).toBe(email);
  expect(await addressCount(f.id,email)).toBe(1);
  expect((await approveDraft(f.draftId,userId)).status).toBe("approved");
  expect((await db.query("SELECT id FROM outbound_sends WHERE prospect_id=$1",[f.id])).rows).toHaveLength(0);
});

it("an edit failure rolls back a new address and its draft revision together",async()=>{
  const f=await fixture(),email=`owner@${f.domain}`,original=db.transaction.bind(db);
  vi.spyOn(db,"transaction").mockImplementationOnce(fn=>original(async tx=>{
    const query=tx.query.bind(tx);
    tx.query=async<T>(sql:string,params?:unknown[])=>{
      if(sql.includes("INSERT INTO draft_revisions"))throw new Error("Synthetic revision failure");
      return query<T>(sql,params);
    };
    return fn(tx);
  }));
  await expect(edit(f,email)).rejects.toThrow("Synthetic revision failure");
  expect(await addressCount(f.id,email)).toBe(0);
  expect((await db.query("SELECT recipient_email FROM drafts WHERE id=$1",[f.draftId])).rows[0].recipient_email).toBe(f.email);
});
