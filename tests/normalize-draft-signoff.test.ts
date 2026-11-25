import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { runNormalizer, NORMALIZE_ACTION } from "../scripts/normalize-draft-signoff";

const leadIds=Array.from({length:5},(_,i)=>`efefefef-0000-4000-8000-${String(i+1).padStart(12,"0")}`);
const draftIds=Array.from({length:5},(_,i)=>`fefefefe-0000-4000-8000-${String(i+1).padStart(12,"0")}`);
async function seed(index:number, body:string) {
 const db=await getDb(); const id=leadIds[index], did=draftIds[index];
 await db.query(`INSERT INTO prospects(id,business_name,name_key,created_by_type) VALUES($1,$2,$3,'api')`,[id,`Signoff Fixture ${index}`,`signoff fixture ${index}`]);
 await db.query(`INSERT INTO drafts(id,prospect_id,kind,status,subject,body,recipient_email,created_by_type) VALUES($1,$2,'first_contact','draft','subject',$3,'x@example.test','api')`,[did,id,body]);
 return did;
}
beforeAll(async()=>{await ensureWorkspaceDefaults();const db=await getDb(); await db.query(`DELETE FROM prospects WHERE id=ANY($1::uuid[])`,[leadIds]);});
afterAll(async()=>{const db=await getDb();await db.query(`DELETE FROM prospects WHERE id=ANY($1::uuid[])`,[leadIds]);await closeDb();});

describe("reversible first-contact signoff normalizer",()=>{
 it("leaves already-correct draft unchanged",async()=>{const id=await seed(0,"Text\nBest,");const db=await getDb();const result=await runNormalizer(db,"apply");expect(result.unchanged).toBeGreaterThanOrEqual(1);expect((await db.query<{body:string}>(`SELECT body FROM drafts WHERE id=$1`,[id])).rows[0].body).toBe("Text\nBest,");});
 it("preserves signature-like text, appends the signoff, and restores exact prior bytes",async()=>{const id=await seed(1,"Hello\r\n\r\nAlice Smith\r\nFounder, Nomeriq\r\nWebsite: https://nomeriq.com\r\n");const db=await getDb();await runNormalizer(db,"apply");const written=(await db.query<{body:string}>(`SELECT body FROM drafts WHERE id=$1`,[id])).rows[0].body;expect(written).toBe("Hello\r\n\r\nAlice Smith\r\nFounder, Nomeriq\r\nWebsite: https://nomeriq.com\r\nBest,");await runNormalizer(db,"undo");expect((await db.query<{body:string}>(`SELECT body FROM drafts WHERE id=$1`,[id])).rows[0].body).toBe("Hello\r\n\r\nAlice Smith\r\nFounder, Nomeriq\r\nWebsite: https://nomeriq.com\r\n");});
 it("appends when no signature, refuses currency unchanged, is idempotent per normalized row and dry-run writes nothing",async()=>{const a=await seed(2,"Hello");const b=await seed(3,"Quote $20 today");const db=await getDb();const before=(await db.query<{n:number}>(`SELECT count(*)::int n FROM audit_log WHERE action=$1`,[NORMALIZE_ACTION])).rows[0].n;const dry=await runNormalizer(db,"dry-run");expect(dry.refused_currency.map(x=>x.id)).toContain(b);expect((await db.query<{n:number}>(`SELECT count(*)::int n FROM audit_log WHERE action=$1`,[NORMALIZE_ACTION])).rows[0].n).toBe(before);await runNormalizer(db,"apply");expect((await db.query<{body:string}>(`SELECT body FROM drafts WHERE id=$1`,[a])).rows[0].body).toBe("Hello\nBest,");expect((await db.query<{body:string}>(`SELECT body FROM drafts WHERE id=$1`,[b])).rows[0].body).toBe("Quote $20 today");const auditBefore=(await db.query<{n:number}>(`SELECT count(*)::int n FROM audit_log WHERE action=$1 AND entity_id=$2`,[NORMALIZE_ACTION,a])).rows[0].n;await runNormalizer(db,"apply");expect((await db.query<{body:string}>(`SELECT body FROM drafts WHERE id=$1`,[a])).rows[0].body).toBe("Hello\nBest,");expect((await db.query<{n:number}>(`SELECT count(*)::int n FROM audit_log WHERE action=$1 AND entity_id=$2`,[NORMALIZE_ACTION,a])).rows[0].n).toBe(auditBefore);});
 it("refuses undo after a later human edit",async()=>{const id=await seed(4,"Original");const db=await getDb();await runNormalizer(db,"apply");await db.query(`UPDATE drafts SET body='human edit' WHERE id=$1`,[id]);const out=await runNormalizer(db,"undo");expect(out.changed.map(x=>x.id)).not.toContain(id);expect((await db.query<{body:string}>(`SELECT body FROM drafts WHERE id=$1`,[id])).rows[0].body).toBe("human edit");});
});
