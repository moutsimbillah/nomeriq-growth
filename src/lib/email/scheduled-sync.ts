import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { config as loadDotenv } from "dotenv";
import { getDb, type DbClient } from "@/lib/db/client";
import { finishMailboxRun, startMailboxRun, undoMailboxRun, type BackupReceipt } from "./sync-journal";
import { issueVerifiedBackupReceipt } from "./verified-scheduled-backup";
import { syncEmailAccount, type SyncResult } from "./sync";

const execFile = promisify(nodeExecFile);
const BACKUP_DIR = "/var/backups/growth";
const BACKUP_RE = /^\/var\/backups\/growth\/deploy-\d{8}T\d{6}Z\.dump$/;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_RESTORE_LIST_BYTES = 2 * 1024 * 1024;
const MAX_RESTORE_MS = 30_000;
const FIXED_APP_ROOT = "/home/growth/app";

export type ScheduledSyncDeps = {
  platform: NodeJS.Platform;
  now: () => number;
  readStdin: () => Promise<string>;
  readFile: (file: string, options?: { encoding?: BufferEncoding }) => Promise<string>;
  readBackup?: (file: string) => Promise<Buffer>;
  lstat: (file: string) => Promise<{ mode: number; size: number; nlink: number; uid?: number; gid?: number; mtimeMs: number; ino?: number }>;
  realpath: (file: string) => Promise<string>;
  execFile: (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;
  initializeDb: () => Promise<DbClient>;
  appRoot: string;
  currentUid?: () => number | undefined;
  loadEnvironment?: () => void | Promise<void>;
  assertUndoQuiescent?: () => Promise<void>;
  onRunStarted?: (runId: string) => void;
  startRun?: typeof startMailboxRun;
  syncAccount?: typeof syncEmailAccount;
  finishRun?: typeof finishMailboxRun;
};

export type ScheduledSyncOutcome = {
  accountId: string;
  runId: string;
  imported: number;
  skipped: number;
  folders: number;
  historyIncomplete: boolean;
};

export type ScheduledUndoOutcome = { runId: string; status: "undone" | "already_undone" | "conflict"; journalRows: number };

export class ScheduledSyncFailure extends Error {
  constructor(readonly runId: string) { super("scheduled_sync_failed"); }
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code.slice(0, 64);
  return "scheduled_sync_failed";
}

export function parseScheduledReceipt(raw: string): BackupReceipt {
  if (Buffer.byteLength(raw, "utf8") > MAX_RECEIPT_BYTES) throw new Error("receipt_too_large");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("receipt_malformed"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("receipt_malformed");
  const r = value as Record<string, unknown>;
  if (r.kind !== "pg_dump" || r.verified !== true || typeof r.path !== "string" || !BACKUP_RE.test(r.path)) throw new Error("receipt_invalid");
  if (!Number.isSafeInteger(r.sizeBytes) || !Number.isSafeInteger(r.tableDataCount) || (r.sizeBytes as number) < 1024 || (r.tableDataCount as number) < 50) throw new Error("receipt_invalid");
  if (typeof r.verifiedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(r.verifiedAt) || !Number.isFinite(Date.parse(r.verifiedAt))) throw new Error("receipt_invalid");
  if ((r.mode !== "600" && r.fileMode !== 0o600) || (r.mode !== undefined && r.mode !== "600") || (r.fileMode !== undefined && r.fileMode !== 0o600)) throw new Error("receipt_invalid");
  if (r.sha256 !== undefined && (typeof r.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.sha256))) throw new Error("receipt_invalid");
  return { kind: "pg_dump", verified: true, path: r.path, sizeBytes: r.sizeBytes as number,
    tableDataCount: r.tableDataCount as number, verifiedAt: r.verifiedAt, mode: "600",
    ...(r.sha256 ? { sha256: r.sha256 as string } : {}) };
}

async function verifyBackup(receipt: BackupReceipt, deps: ScheduledSyncDeps): Promise<BackupReceipt> {
  if (!BACKUP_RE.test(receipt.path) || receipt.path !== "/var/backups/growth/" + path.posix.basename(receipt.path)) throw new Error("backup_path_invalid");
  const stat = await deps.lstat(receipt.path);
  if ((stat.mode & fsConstants.S_IFMT) !== fsConstants.S_IFREG || stat.nlink !== 1 || stat.size !== receipt.sizeBytes || stat.size < 1024 || (stat.mode & 0o777) !== 0o600) throw new Error("backup_file_invalid");
  const expectedUid = deps.currentUid?.();
  if (!Number.isSafeInteger(expectedUid) || !expectedUid || stat.uid !== expectedUid) throw new Error("backup_owner_invalid");
  if (await deps.realpath(receipt.path) !== receipt.path) throw new Error("backup_not_canonical");
  const age = deps.now() - Date.parse(receipt.verifiedAt);
  const mtimeAge = deps.now() - stat.mtimeMs;
  if (!Number.isFinite(age) || age < 0 || age > 300_000 || !Number.isFinite(mtimeAge) || mtimeAge < 0 || mtimeAge > 300_000
    || stat.mtimeMs > Date.parse(receipt.verifiedAt) + 1000) throw new Error("backup_receipt_stale");
  const listed = await deps.execFile("pg_restore", ["--list", receipt.path], { timeout: MAX_RESTORE_MS, maxBuffer: MAX_RESTORE_LIST_BYTES });
  const tableDataCount = listed.stdout.split(/\r?\n/).filter((line) => /\bTABLE DATA\b/.test(line) && !line.trimStart().startsWith(";")).length;
  if (tableDataCount < 50 || tableDataCount !== receipt.tableDataCount) throw new Error("backup_contents_invalid");
  if (receipt.sha256) {
    const content = await (deps.readBackup ?? fs.readFile)(receipt.path);
    if (crypto.createHash("sha256").update(content).digest("hex") !== receipt.sha256) throw new Error("backup_hash_invalid");
  }
  const after = await deps.lstat(receipt.path);
  if (after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.mode !== stat.mode
    || after.uid !== stat.uid || after.nlink !== stat.nlink) throw new Error("backup_changed_during_verification");
  return receipt;
}

async function verifiedBackupReceipt(receipt: BackupReceipt, deps: ScheduledSyncDeps): Promise<BackupReceipt> {
  return issueVerifiedBackupReceipt(await verifyBackup(parseScheduledReceipt(JSON.stringify(receipt)), deps));
}

async function ensureWorkspaceDefaults(db: DbClient): Promise<void> {
  if (!(await db.query("SELECT id FROM workspace_settings WHERE id='default'")).rows.length) {
    throw new Error("workspace_setup_required");
  }
}

async function readRunState(db: DbClient, runId: string, accountId: string): Promise<{ status: string; checkpoints: number }> {
  const run = await db.query<{ status: string }>("SELECT status FROM mailbox_sync_runs WHERE id=$1 AND account_id=$2", [runId, accountId]);
  const checkpoints = await db.query("SELECT folder FROM mailbox_sync_state WHERE account_id=$1 AND folder IN ('INBOX','Sent')", [accountId]);
  if (!run.rows[0]) throw new Error("run_readback_failed");
  return { status: run.rows[0].status, checkpoints: checkpoints.rows.length };
}

export async function runScheduledMailboxSync(receipt: BackupReceipt, deps: ScheduledSyncDeps): Promise<ScheduledSyncOutcome> {
  if (deps.platform !== "linux") throw new Error("platform_guard");
  const verified = await verifiedBackupReceipt(receipt, deps);
  const db = await deps.initializeDb();
  await ensureWorkspaceDefaults(db);
  const schema = await db.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='email_accounts' AND column_name='status') AS exists");
  if (!schema.rows[0]?.exists) throw new Error("account_status_schema_missing");
  const accounts = await db.query<{ id: string; status: string }>("SELECT id,status FROM email_accounts WHERE status IN ('connected','paused_bounce') AND provider <> 'sandbox' ORDER BY last_sync_at ASC NULLS FIRST,id ASC LIMIT 1");
  if (!accounts.rows[0]) throw new Error("no_eligible_account");
  const account = accounts.rows[0];
  const run = await (deps.startRun ?? startMailboxRun)(db, { accountId: account.id, mode: "scheduled", leaseOwner: crypto.randomUUID(), backupReceipt: verified });
  let result: SyncResult | undefined;
  try {
    deps.onRunStarted?.(run.id);
    result = await (deps.syncAccount ?? syncEmailAccount)(account.id, { mode: "incremental", executionContext: { run, mode: "scheduled" } });
    if (result.errors.length > 0) throw new Error("scheduled_sync_partial");
    await (deps.finishRun ?? finishMailboxRun)(db, run, "completed");
    const state = await readRunState(db, run.id, account.id);
    if (state.status !== "completed" || state.checkpoints !== 2) throw new Error("run_completion_readback_failed");
    // Historical coverage is not equivalent to successful processing of this incremental batch.
    return { accountId: account.id, runId: run.id, imported: result.imported, skipped: result.skipped, folders: state.checkpoints, historyIncomplete: result.historyIncomplete };
  } catch (error) {
    await (deps.finishRun ?? finishMailboxRun)(db, run, "failed", "scheduled_sync_failed").catch(() => undefined);
    throw new ScheduledSyncFailure(run.id);
  }
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export async function undoScheduledMailboxRun(runId: string, receipt: BackupReceipt, deps: ScheduledSyncDeps): Promise<ScheduledUndoOutcome> {
  if (deps.platform !== "linux") throw new Error("platform_guard");
  if (!RUN_ID.test(runId)) throw new Error("run_id_invalid");
  await deps.assertUndoQuiescent?.();
  const verified = await verifiedBackupReceipt(receipt, deps);
  const db = await deps.initializeDb();
  const target = await db.query<{ account_id: string; mode: string; status: string; created_by: string | null; role: string | null }>(
    `SELECT r.account_id,r.mode,r.status,a.created_by,u.role FROM mailbox_sync_runs r
     JOIN email_accounts a ON a.id=r.account_id LEFT JOIN users u ON u.id=a.created_by WHERE r.id=$1`, [runId]);
  const row = target.rows[0];
  if (!row || row.mode !== "scheduled") throw new Error("undo_target_rejected");
  const journal = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM mailbox_sync_journal WHERE run_id=$1", [runId]);
  const journalRows = Number(journal.rows[0]?.count);
  if (!Number.isSafeInteger(journalRows) || journalRows < 0) throw new Error("undo_readback_failed");
  if (row.status === "undone") return { runId, status: "already_undone", journalRows };
  if (!["running", "completed", "failed", "expired", "undo_conflict"].includes(row.status)) throw new Error("undo_target_not_terminal");
  if (!row.created_by || row.role !== "founder") throw new Error("undo_actor_rejected");
  const result = await undoMailboxRun(db, runId, row.created_by, verified);
  const after = await db.query<{ status: string }>("SELECT status FROM mailbox_sync_runs WHERE id=$1", [runId]);
  const action = result.conflict ? "mailbox_sync_undo_conflict" : "mailbox_sync_undo";
  const audit = await db.query<{ backup: Record<string, unknown> | null }>(
    `SELECT metadata->'backup' AS backup FROM audit_log
     WHERE action=$1 AND entity_type='mailbox_sync_run' AND entity_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`, [action, runId]);
  const expectedStatus = result.conflict ? "undo_conflict" : "undone";
  const observedBackup = audit.rows[0]?.backup;
  const backupMatches = observedBackup?.path === verified.path && observedBackup?.sizeBytes === verified.sizeBytes
    && observedBackup?.tableDataCount === verified.tableDataCount && observedBackup?.verifiedAt === verified.verifiedAt
    && observedBackup?.mode === "600";
  if (after.rows[0]?.status !== expectedStatus || !backupMatches) throw new Error("undo_readback_failed");
  return { runId, status: result.conflict ? "conflict" : "undone", journalRows };
}

export function assertScheduledDatabaseTarget(raw: string | undefined): void {
  let url: URL;
  try { url = new URL(raw ?? ""); } catch { throw new Error("database_target_rejected"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["127.0.0.1", "localhost"].includes(url.hostname)
    || (url.port && url.port !== "5432") || url.pathname !== "/growth" || url.search || url.hash) throw new Error("database_target_rejected");
}
function loadProductionEnvironment(): void {
  const loaded = loadDotenv({ path: "/home/growth/.env.production", quiet: true, override: true });
  if (loaded.error) throw new Error("environment_unavailable");
  assertScheduledDatabaseTarget(process.env.DATABASE_URL);
  if (process.env.AUTO_MIGRATE !== "false") throw new Error("explicit_migration_required");
}

async function readSystemdState(args: string[]): Promise<string> {
  try { return (await execFile("systemctl", args, { timeout: 10_000, maxBuffer: 4096 })).stdout.trim(); }
  catch (error) {
    const output = (error as { stdout?: unknown }).stdout;
    return (typeof output === "string" ? output : Buffer.isBuffer(output) ? output.toString("utf8") : "").trim();
  }
}

async function requireQuiescentMailboxWriter(): Promise<void> {
  const [timerEnabled, timerActive, serviceActive] = await Promise.all([
    readSystemdState(["is-enabled", "growth-mailbox-sync.timer"]),
    readSystemdState(["is-active", "growth-mailbox-sync.timer"]),
    readSystemdState(["is-active", "growth-mailbox-sync.service"]),
  ]);
  if (timerEnabled !== "disabled" || timerActive !== "inactive" || serviceActive !== "inactive") {
    throw new Error("undo_requires_quiescence");
  }
}

export function productionDependencies(): ScheduledSyncDeps {
  return {
    platform: process.platform,
    now: () => Date.now(),
    readStdin: async () => { const chunks: Buffer[] = []; for await (const chunk of process.stdin) { chunks.push(Buffer.from(chunk)); if (Buffer.concat(chunks).length > MAX_RECEIPT_BYTES) throw new Error("receipt_too_large"); } return Buffer.concat(chunks).toString("utf8"); },
    readFile: (file, options) => fs.readFile(file, options as { encoding: BufferEncoding }),
    readBackup: file => fs.readFile(file),
    lstat: async (file) => fs.lstat(file),
    realpath: (file) => fs.realpath(file),
    execFile: async (file, args, options) => execFile(file, args, options),
    initializeDb: async () => {
      assertScheduledDatabaseTarget(process.env.DATABASE_URL);
      const db = await getDb();
      if (!(await db.query("SELECT id FROM _migrations WHERE id='035_mailbox_sync_journal.sql'")).rows.length) throw new Error("sync_schema_not_applied");
      return db;
    },
    appRoot: FIXED_APP_ROOT,
    currentUid: () => typeof process.getuid === "function" ? process.getuid() : undefined,
    loadEnvironment: loadProductionEnvironment,
    assertUndoQuiescent: requireQuiescentMailboxWriter,
    onRunStarted: (runId) => { process.stdout.write(`RUN_STARTED run_id=${runId}${os.EOL}`); },
  };
}

export async function main(argv: string[] = process.argv.slice(2), deps: ScheduledSyncDeps = productionDependencies()): Promise<number> {
  const undoRunId = argv.length === 2 && argv[0] === "undo" && RUN_ID.test(argv[1]) ? argv[1] : undefined;
  if ((argv.length !== 0 && !undoRunId) || deps.platform !== "linux" || process.env.NODE_ENV !== "production" || deps.appRoot !== FIXED_APP_ROOT) return 2;
  try {
    await (deps.loadEnvironment ?? loadProductionEnvironment)();
    const receipt = parseScheduledReceipt(await deps.readStdin());
    if (undoRunId) {
      const outcome = await undoScheduledMailboxRun(undoRunId, receipt, deps);
      process.stdout.write(JSON.stringify(outcome) + os.EOL);
      return outcome.status === "conflict" ? 1 : 0;
    }
    const outcome = await runScheduledMailboxSync(receipt, deps);
    process.stdout.write(JSON.stringify({ status: "completed", ...outcome }) + os.EOL);
    return 0;
  } catch (error) {
    if (error instanceof ScheduledSyncFailure) {
      process.stdout.write(JSON.stringify({ status: "failed", runId: error.runId, code: "scheduled_sync_failed" }) + os.EOL);
      return 1;
    }
    process.stderr.write("scheduled mailbox sync failed\n");
    return 1;
  }
}

export const scheduledSyncConstants = { BACKUP_DIR, FIXED_APP_ROOT, MAX_RECEIPT_BYTES };
