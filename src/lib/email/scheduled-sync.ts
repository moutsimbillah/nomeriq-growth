import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { config as loadDotenv } from "dotenv";
import { getDb, type DbClient } from "@/lib/db/client";
import { finishMailboxRun, startMailboxRun, type BackupReceipt } from "./sync-journal";
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
  const verified = await issueVerifiedBackupReceipt(await verifyBackup(parseScheduledReceipt(JSON.stringify(receipt)), deps));
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
    result = await (deps.syncAccount ?? syncEmailAccount)(account.id, { mode: "incremental", executionContext: { run, mode: "scheduled" } });
    if (result.errors.length > 0) throw new Error("scheduled_sync_partial");
    await (deps.finishRun ?? finishMailboxRun)(db, run, "completed");
    const state = await readRunState(db, run.id, account.id);
    if (state.status !== "completed" || state.checkpoints !== 2) throw new Error("run_completion_readback_failed");
    // Historical coverage is not equivalent to successful processing of this incremental batch.
    return { accountId: account.id, runId: run.id, imported: result.imported, skipped: result.skipped, folders: state.checkpoints, historyIncomplete: result.historyIncomplete };
  } catch (error) {
    await (deps.finishRun ?? finishMailboxRun)(db, run, "failed", "scheduled_sync_failed").catch(() => undefined);
    throw new Error("scheduled_sync_failed");
  }
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
  };
}

export async function main(argv: string[] = process.argv.slice(2), deps: ScheduledSyncDeps = productionDependencies()): Promise<number> {
  if (argv.length !== 0 || deps.platform !== "linux" || process.env.NODE_ENV !== "production" || deps.appRoot !== FIXED_APP_ROOT) return 2;
  try {
    await (deps.loadEnvironment ?? loadProductionEnvironment)();
    const receipt = parseScheduledReceipt(await deps.readStdin());
    const outcome = await runScheduledMailboxSync(receipt, deps);
    process.stdout.write(JSON.stringify(outcome) + os.EOL);
    return 0;
  } catch {
    process.stderr.write("scheduled mailbox sync failed\n");
    return 1;
  }
}

export const scheduledSyncConstants = { BACKUP_DIR, FIXED_APP_ROOT, MAX_RECEIPT_BYTES };
