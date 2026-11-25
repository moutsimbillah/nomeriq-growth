import { randomUUID } from "node:crypto";
import { closeDb, getDb, type DbClient } from "../src/lib/db/client";

export const UTILITY_VERSION = "normalize-draft-signoff/v2";
export const NORMALIZE_ACTION = "draft.signoff_normalized";
const UNDO_ACTION = "draft.signoff_undo";
type Draft = { id: string; subject: string; body: string; business_name: string };
type Summary = { mode: "dry-run" | "apply" | "undo"; selected: number; would_change: number; unchanged: number; refused_currency: Array<{ id: string; business_name: string }>; changed: Array<{ id: string; business_name: string }> };
const currency = /(?:[$€£₨₹]\s?\d|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|eur|gbp|pkr|inr|dollars?)\b|\b\d+(?:\.\d+)?\s?(?:%|percent\b))/i;
const isBest = (s: string) => s.trim().toLowerCase() === "best,";

/** Append only the required terminal sign-off; never infer or delete human-authored text. */
export function normalizeBody(body: string): string {
  const last = body.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim()).at(-1)?.trim() ?? "";
  if (isBest(last)) return body;
  const newline = body.includes("\r\n") ? "\r\n" : body.includes("\r") && !body.includes("\n") ? "\r" : "\n";
  const prefix = /(?:\r\n|\n|\r)$/.test(body) ? body : `${body}${newline}`;
  return `${prefix}Best,`;
}
async function select(tx: DbClient): Promise<Draft[]> {
  return (await tx.query<Draft>(`SELECT d.id::text AS id,d.subject,d.body,p.business_name FROM drafts d JOIN prospects p ON p.id=d.prospect_id WHERE d.status='draft' AND d.approved_at IS NULL AND d.approved_by IS NULL AND d.kind='first_contact' ORDER BY d.id`)).rows;
}
function audit(tx: DbClient, action: string, id: string, metadata: object) {
  return tx.query(`INSERT INTO audit_log (id,actor_type,actor_id,action,entity_type,entity_id,metadata) VALUES ($1,'system',NULL,$2,'draft',$3,$4::jsonb)`, [randomUUID(),action,id,JSON.stringify(metadata)]);
}
export async function runNormalizer(db: DbClient, mode: Summary["mode"]): Promise<Summary> {
  const summary: Summary={mode,selected:0,would_change:0,unchanged:0,refused_currency:[],changed:[]};
  if (mode === "undo") {
    const rows=(await db.query<{audit_id:string; id:string; metadata:Record<string,unknown>; body:string; business_name:string}>(`SELECT a.id::text AS audit_id,a.entity_id AS id,a.metadata,d.body,p.business_name FROM audit_log a JOIN drafts d ON d.id::text=a.entity_id JOIN prospects p ON p.id=d.prospect_id WHERE a.action=$1 AND a.entity_type='draft' AND NOT EXISTS (SELECT 1 FROM audit_log u WHERE u.action=$2 AND u.entity_type='draft' AND u.entity_id=a.entity_id AND u.metadata->>'normalizationAuditId'=a.id::text) ORDER BY a.created_at DESC,a.id`,[NORMALIZE_ACTION,UNDO_ACTION])).rows;
    summary.selected=rows.length;
    for (const r of rows) {
      const previous=r.metadata.previousBody,written=r.metadata.newBody;
      if(typeof previous!=="string"||typeof written!=="string"||r.body!==written){console.error(`REFUSED undo draft ${r.id}: current body differs from utility-written body`);continue;}
      await db.transaction(async tx=>{await audit(tx,UNDO_ACTION,r.id,{previousBody:written,restoredBody:previous,normalizationAuditId:r.audit_id,utilityVersion:UTILITY_VERSION});const result=await tx.query(`UPDATE drafts SET body=$1,updated_at=now() WHERE id=$2 AND body=$3 AND status='draft' AND approved_at IS NULL AND approved_by IS NULL`,[previous,r.id,written]);if(result.rowCount!==1)throw new Error(`Concurrent edit prevented undo for ${r.id}`);});
      summary.changed.push({id:r.id,business_name:r.business_name});
    }
    summary.would_change=summary.changed.length;return summary;
  }
  const rows=await select(db);summary.selected=rows.length;
  for(const row of rows){
    const last=row.body.replace(/\r\n/g,"\n").split("\n").filter(x=>x.trim()).at(-1)?.trim()??"";
    if(isBest(last)){summary.unchanged++;continue;}
    if(currency.test(row.body)){summary.refused_currency.push({id:row.id,business_name:row.business_name});continue;}
    const body=normalizeBody(row.body);if(body===row.body){summary.unchanged++;continue;}
    summary.would_change++;summary.changed.push({id:row.id,business_name:row.business_name});
    if(mode==="apply")await db.transaction(async tx=>{await audit(tx,NORMALIZE_ACTION,row.id,{previousSubject:row.subject,previousBody:row.body,newBody:body,utilityVersion:UTILITY_VERSION});const result=await tx.query(`UPDATE drafts SET body=$1,updated_at=now() WHERE id=$2 AND body=$3 AND status='draft' AND approved_at IS NULL AND approved_by IS NULL AND kind='first_contact'`,[body,row.id,row.body]);if(result.rowCount!==1)throw new Error(`Concurrent change prevented normalization for ${row.id}`);});
  }
  if(mode==="dry-run")summary.changed=[];
  return summary;
}
async function main(){
  const args=process.argv.slice(2);if(args.some(x=>!['--dry-run','--apply','--undo'].includes(x))||args.length>1)throw new Error("Use exactly one of --dry-run, --apply, or --undo.");
  const mode:Summary["mode"]=args[0]==="--apply"?"apply":args[0]==="--undo"?"undo":"dry-run";
  if(!process.env.DATABASE_URL?.trim()&&!process.env.PGLITE_DIR?.trim())throw new Error("Specify the intended database explicitly; refusing the default local database.");
  process.env.AUTO_MIGRATE="false";const db=await getDb();try{const summary=await runNormalizer(db,mode);console.log(JSON.stringify(summary,null,2));}finally{await closeDb();}
}
if(require.main===module)main().catch(error=>{console.error(error instanceof Error?error.message:"Normalization failed.");process.exitCode=1;});
