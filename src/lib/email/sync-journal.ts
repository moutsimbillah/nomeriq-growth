import { withDbContext } from "@/lib/db/context";
import type { DbClient } from "@/lib/db/client";
import { assertVerifiedBackupReceipt } from "./verified-scheduled-backup";
export type RunMode = "scheduled" | "manual";
export type BackupReceipt = { kind:"pg_dump"; verified:true; path:string; sizeBytes:number; tableDataCount:number; verifiedAt:string; sha256?:string; fileMode?:number; mode?:"600" };
export type StartMailboxRunInput = { accountId:string; mode:RunMode; leaseOwner:string; leaseSeconds?:number; backupReceipt?:BackupReceipt; runId?:string };
export type MailboxRun = { id:string; accountId:string; mode:RunMode; fence:number; leaseOwner:string };
type JournalRow={table_name:string;capture_seq:string;pk:{id:string};operation:"INSERT"|"UPDATE"|"DELETE";before_data:Record<string,unknown>|null;after_data:Record<string,unknown>|null};
const RECOVERABLE_INSERTS=new Set(["messages","message_attachments","conversations","drafts","suppressions","email_bounces","mailbox_sync_state","prospect_rejection_recommendations"]);
const FIELDS:Record<string,string[]>={
 messages:["conversation_id","prospect_id","direction","source","folder","uidvalidity","uid","message_id","in_reply_to","references_json","from_email","from_name","to_emails","cc_emails","subject","body_text","body_html","snippet","sent_at","received_at","is_read","is_sandbox","delivery_status","error","attachments","draft_id","campaign_id","external","matched_by","raw_headers","sent_copy_saved_at","created_at"],
 message_attachments:["message_id","filename","content_type","size","content"],
 conversations:["subject","status","classification","classification_source","classification_confidence","last_message_at","last_inbound_at","last_outbound_at","unread_count","updated_at"],
 drafts:["research_job_id","kind","sequence","status","subject","body","recipient_email","ai_generated","ai_model","product_truth_version","warnings","founder_edited","approved_at","approved_by","sent_at","created_by_type","created_by_user_id","last_error","updated_at"],
 prospects:["business_name","name_key","website_url","domain_key","country","categories","signal_description","pricing_details","qualification_status","rejection_reason","evidence_summary","research_notes","instagram_key","instagram_url","youtube_key","youtube_url","x_key","x_url","telegram_key","telegram_url","linkedin_url","other_socials","follower_count","subscriber_count","verified_at","status","next_action","next_action_at","founder_notes","do_not_contact","research_job_id","created_by_type","created_by_user_id","created_by_key_id","last_contacted_at","last_reply_at","archived_at","metadata","founder_edited_at","updated_at"],
 email_accounts:["status","last_error","last_sync_at","last_checked_at","updated_at"], mailbox_sync_state:["uidvalidity","last_uid","last_synced_at","history_complete","error","updated_at"], suppressions:["normalized_email","email","reason","source","prospect_id","note","active","updated_at"], email_bounces:["account_id","message_id","normalized_email","kind","dsn_status","diagnostic","action","created_at"], prospect_rejection_recommendations:["prospect_id","message_id","reason","objection","suggested_outcome","recorded_at","provenance_key"], workspace_settings:["legal_business_name","postal_address","sender_signature","follow_up_max","follow_up_daily_limit","follow_up_delay_1_days","follow_up_delay_2_days","timezone","updated_at"]};
const TABLES=new Set(Object.keys(FIELDS));

async function setRunContext(tx:DbClient,run:MailboxRun){await tx.query("SELECT set_config($1,$2,true)",["nomeriq.mailbox_run_id",run.id]);await tx.query("SELECT set_config($1,$2,true)",["nomeriq.mailbox_account_id",run.accountId]);await tx.query("SELECT set_config($1,$2,true)",["nomeriq.mailbox_fence",String(run.fence)]);}
async function lockLiveRun(tx: DbClient, run: MailboxRun): Promise<void> {
  await tx.query("SELECT id FROM email_accounts WHERE id=$1 FOR UPDATE", [run.accountId]);
  const q = await tx.query<{ fence: string; active_run_id: string | null; lease_owner: string; live: boolean }>(
    "SELECT fence,active_run_id,lease_owner,lease_until > clock_timestamp() AS live FROM mailbox_sync_leases WHERE account_id=$1 FOR UPDATE", [run.accountId]);
  const lease = q.rows[0];
  if (!lease || Number(lease.fence) !== run.fence || lease.active_run_id !== run.id || lease.lease_owner !== run.leaseOwner || !lease.live) throw new Error("mailbox sync fence rejected");
}
export async function startMailboxRun(db:DbClient,input:StartMailboxRunInput):Promise<MailboxRun>{if(input.mode==="scheduled")assertVerifiedBackupReceipt(input.backupReceipt);const id=input.runId??crypto.randomUUID();const seconds=input.leaseSeconds??120;if(!Number.isSafeInteger(seconds)||seconds<5||seconds>900)throw new Error("leaseSeconds must be between 5 and 900");return db.transaction(async tx=>{const a=await tx.query<{status:string}>("SELECT status FROM email_accounts WHERE id=$1 FOR UPDATE",[input.accountId]);if(!a.rows[0])throw new Error("email account not found");if(["disabled","unverified"].includes(a.rows[0].status))throw new Error("email account is not eligible for mailbox sync");const e=await tx.query<{fence:string;active_run_id:string|null;live:boolean}>("SELECT fence,active_run_id,lease_until > clock_timestamp() AS live FROM mailbox_sync_leases WHERE account_id=$1 FOR UPDATE",[input.accountId]);let fence=1;if(e.rows[0]){const l=e.rows[0];fence=Number(l.fence)+1;if(l.active_run_id&&l.live)throw new Error("mailbox account lease is already held");if(l.active_run_id)await tx.query("UPDATE mailbox_sync_runs SET status='expired',finished_at=clock_timestamp(),error='lease expired' WHERE id=$1 AND status='running'",[l.active_run_id]);await tx.query("UPDATE mailbox_sync_leases SET lease_owner=$2,fence=$3,lease_until=clock_timestamp()+($4 * interval '1 second'),active_run_id=NULL,updated_at=clock_timestamp() WHERE account_id=$1",[input.accountId,input.leaseOwner,fence,seconds]);}else await tx.query("INSERT INTO mailbox_sync_leases(account_id,lease_owner,fence,lease_until) VALUES($1,$2,$3,clock_timestamp()+($4 * interval '1 second'))",[input.accountId,input.leaseOwner,fence,seconds]);await tx.query("INSERT INTO mailbox_sync_runs(id,account_id,mode,status,fence,lease_owner,backup_receipt) VALUES($1,$2,$3,'running',$4,$5,$6::jsonb)",[id,input.accountId,input.mode,fence,input.leaseOwner,input.backupReceipt?JSON.stringify(input.backupReceipt):null]);await tx.query("UPDATE mailbox_sync_leases SET active_run_id=$2 WHERE account_id=$1",[input.accountId,id]);const run={id,accountId:input.accountId,mode:input.mode,fence,leaseOwner:input.leaseOwner};await setRunContext(tx,run);return run;});}
export async function renewMailboxRun(db:DbClient,run:MailboxRun,leaseSeconds=120){if(!Number.isSafeInteger(leaseSeconds)||leaseSeconds<5||leaseSeconds>900)throw new Error("leaseSeconds must be between 5 and 900");await db.transaction(async tx=>{await lockLiveRun(tx,run);await tx.query("UPDATE mailbox_sync_leases SET lease_until=clock_timestamp()+($3 * interval '1 second'),updated_at=clock_timestamp() WHERE account_id=$1 AND fence=$2 AND active_run_id=$4",[run.accountId,run.fence,leaseSeconds,run.id]);});}
export async function withMailboxRun<T>(db: DbClient, run: MailboxRun, fn: (tx: DbClient) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await lockLiveRun(tx, run);
    await setRunContext(tx, run);
    const result = await withDbContext(tx, () => fn(tx));
    await lockLiveRun(tx, run);
    return result;
  });
}
export async function finishMailboxRun(db:DbClient,run:MailboxRun,status:"completed"|"failed"="completed",error?:string){await db.transaction(async tx=>{await lockLiveRun(tx,run);await tx.query("UPDATE mailbox_sync_runs SET status=$2,error=$3,finished_at=clock_timestamp() WHERE id=$1 AND status='running'",[run.id,status,error??null]);await tx.query("UPDATE mailbox_sync_leases SET active_run_id=NULL,lease_until=clock_timestamp(),updated_at=clock_timestamp() WHERE account_id=$1 AND fence=$2 AND active_run_id=$3",[run.accountId,run.fence,run.id]);});}
async function preflight(tx: DbClient, row: JournalRow): Promise<boolean> {
  if (!TABLES.has(row.table_name) || (row.operation === "UPDATE" && (!row.before_data || !row.after_data)) || (row.operation !== "UPDATE" && !RECOVERABLE_INSERTS.has(row.table_name))) return false;
  const current = await tx.query<Record<string, unknown>>(`SELECT to_jsonb(t) AS data FROM "${row.table_name}" t WHERE id=$1 FOR UPDATE`, [row.pk.id]);
  const data = current.rows[0]?.data;
  if (row.operation === "DELETE") return !data && Boolean(row.before_data);
  if (!row.after_data) return false;
  const projection = row.table_name === "email_accounts" ? "jsonb_build_object('status',status,'last_error',last_error,'last_sync_at',last_sync_at,'last_checked_at',last_checked_at,'updated_at',updated_at)" : "to_jsonb(t)";
  const same = await tx.query<{ same: boolean }>(`SELECT ${projection} = $2::jsonb AS same FROM "${row.table_name}" t WHERE id=$1`, [row.pk.id, JSON.stringify(row.after_data)]);
  return same.rows[0]?.same === true;
}
async function apply(tx: DbClient, row: JournalRow): Promise<void> {
  const id = row.pk.id;
  if (row.operation === "INSERT") {
    // Reject implicit cascading deletion of later rows not owned by this run.
    const refs = await tx.query<{ child_table: string; child_column: string; key_count: number }>(`SELECT c.conrelid::regclass::text AS child_table,
      a.attname AS child_column, cardinality(c.conkey) AS key_count FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
      WHERE c.contype='f' AND c.confrelid=to_regclass($1)`, [row.table_name]);
    for (const ref of refs.rows) {
      if (ref.key_count !== 1 || !/^[a-z_][a-z0-9_]*$/.test(ref.child_table) || !/^[a-z_][a-z0-9_]*$/.test(ref.child_column)) throw new Error("unsupported undo dependency");
      if ((await tx.query(`SELECT 1 FROM "${ref.child_table}" WHERE "${ref.child_column}"=$1 LIMIT 1`, [id])).rows.length) throw new Error("later dependent row prevents undo");
    }
    await tx.query(`DELETE FROM "${row.table_name}" WHERE id=$1`, [id]);
    return;
  }
  if (row.operation !== "UPDATE" || !row.before_data) throw new Error("unsupported undo mutation");
  // Restore the actual captured schema, not a second guessed list of application columns.
  const fields = row.table_name === "email_accounts" ? FIELDS.email_accounts : Object.keys(row.before_data).filter(field => field !== "id");
  if (!fields.length || fields.some(field => !/^[a-z_][a-z0-9_]*$/.test(field))) throw new Error("invalid captured columns");
  const assignments = fields.map(field => `"${field}"=r."${field}"`).join(",");
  await tx.query(`UPDATE "${row.table_name}" t SET ${assignments} FROM jsonb_populate_record(NULL::"${row.table_name}",$1::jsonb) r WHERE t.id=$2`, [JSON.stringify(row.before_data), id]);
}
export async function undoMailboxRun(db: DbClient, runId: string, actorId: string, backupReceipt?: BackupReceipt): Promise<{ undone: boolean; conflict: boolean }> {
  return db.transaction(async tx => {
    const target = (await tx.query<{ account_id: string; mode: RunMode }>("SELECT account_id,mode FROM mailbox_sync_runs WHERE id=$1", [runId])).rows[0];
    if (!target) throw new Error("mailbox sync run not found");
    if (target.mode === "scheduled" || backupReceipt) assertVerifiedBackupReceipt(backupReceipt);
    const backup = backupReceipt ? { backup: { path: backupReceipt.path, sizeBytes: backupReceipt.sizeBytes,
      tableDataCount: backupReceipt.tableDataCount, verifiedAt: backupReceipt.verifiedAt, mode: "600" } } : {};
    // Use the same account -> lease -> run lock order as sync and lease acquisition.
    await tx.query("SELECT id FROM email_accounts WHERE id=$1 FOR UPDATE", [target.account_id]);
    const lease = (await tx.query<{ active_run_id: string | null; live: boolean }>("SELECT active_run_id,lease_until > clock_timestamp() AS live FROM mailbox_sync_leases WHERE account_id=$1 FOR UPDATE", [target.account_id])).rows[0];
    const run = (await tx.query<{ status: string }>("SELECT status FROM mailbox_sync_runs WHERE id=$1 FOR UPDATE", [runId])).rows[0];
    if (run.status === "undone") return { undone: false, conflict: false };
    if (run.status === "running") {
      if (target.mode !== "scheduled" || !lease || lease.active_run_id !== runId || lease.live) throw new Error("mailbox sync run is not terminal and eligible for undo");
      const expired = await tx.query("UPDATE mailbox_sync_runs SET status='expired',finished_at=clock_timestamp(),error='lease expired' WHERE id=$1 AND status='running' RETURNING id", [runId]);
      const released = await tx.query("UPDATE mailbox_sync_leases SET active_run_id=NULL,lease_until=clock_timestamp(),updated_at=clock_timestamp() WHERE account_id=$1 AND active_run_id=$2 AND lease_until <= clock_timestamp() RETURNING account_id", [target.account_id, runId]);
      if (!expired.rows.length || !released.rows.length) throw new Error("mailbox sync stale run transition failed");
      lease.active_run_id = null;
    } else if (!["completed", "failed", "expired", "undo_conflict"].includes(run.status)) throw new Error("mailbox sync run is not terminal and eligible for undo");
    if (!lease || lease.active_run_id) throw new Error("mailbox sync undo fence rejected");
    const externalEffect = await tx.query("SELECT 1 FROM audit_log WHERE action='mailbox_sent_copy_append_intent' AND entity_type='mailbox_sync_run' AND entity_id=$1 LIMIT 1", [runId]);
    if (externalEffect.rows.length) throw new Error("mailbox sync undo refused after external Sent-copy effect intent");
    const journal = await tx.query<JournalRow>("SELECT table_name,capture_seq,pk,operation,before_data,after_data FROM mailbox_sync_journal WHERE run_id=$1 ORDER BY capture_seq DESC FOR UPDATE", [runId]);
    const conflict = async () => {
      await tx.query(`INSERT INTO audit_log(id,actor_type,actor_id,action,entity_type,entity_id,metadata)
        VALUES($1,'founder',$2,'mailbox_sync_undo_conflict','mailbox_sync_run',$3,$4::jsonb)`, [crypto.randomUUID(), actorId, runId, JSON.stringify({ runId, ...backup })]);
      await tx.query("UPDATE mailbox_sync_runs SET status='undo_conflict',error='undo refused because later state or dependencies changed' WHERE id=$1", [runId]);
      return { undone: false, conflict: true };
    };
    for (const row of journal.rows) if (!(await preflight(tx, row))) return conflict();
    await tx.exec("SAVEPOINT mailbox_sync_undo");
    try {
      for (const row of journal.rows) await apply(tx, row);
    } catch {
      await tx.exec("ROLLBACK TO SAVEPOINT mailbox_sync_undo");
      await tx.exec("RELEASE SAVEPOINT mailbox_sync_undo");
      return conflict();
    }
    await tx.exec("RELEASE SAVEPOINT mailbox_sync_undo");
    await tx.query(`INSERT INTO audit_log(id,actor_type,actor_id,action,entity_type,entity_id,metadata)
      VALUES($1,'founder',$2,'mailbox_sync_undo','mailbox_sync_run',$3,$4::jsonb)`, [crypto.randomUUID(), actorId, runId, JSON.stringify({ runId, journalRows: journal.rows.length, ...backup })]);
    await tx.query("UPDATE mailbox_sync_runs SET status='undone',finished_at=coalesce(finished_at,clock_timestamp()) WHERE id=$1", [runId]);
    return { undone: true, conflict: false };
  });
}
