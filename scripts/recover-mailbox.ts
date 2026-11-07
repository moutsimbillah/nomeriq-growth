/**
 * Founder-approved mailbox recovery, run on the server only after the founder approves each step.
 *
 *   tsx scripts/recover-mailbox.ts dry-run
 *   tsx scripts/recover-mailbox.ts sent IMPORT-SENT-ITEMS
 *   tsx scripts/recover-mailbox.ts check-sent
 *   tsx scripts/recover-mailbox.ts inbox IMPORT-INBOX
 *   tsx scripts/recover-mailbox.ts bounces-preview
 *   tsx scripts/recover-mailbox.ts bounces-apply APPLY-HISTORICAL-BOUNCES
 *
 * sent/inbox     Import-only: one explicit physical folder, in resumable pages, until that folder
 *                is complete. No sends, no Sent-copy appends, no translation, no address linking, and no
 *                historical suppression (delivery reports are stored and marked pending instead).
 * bounces-*      Preview (SELECT only) or apply the historical delivery-report pass. Apply is idempotent.
 *
 * Output is counts/lead names only, except explicitly requested bounce preview addresses with lead names.
 * Address linking is not here on purpose: the founder links from the message screen.
 */
import { config } from "dotenv";
import { Client } from "pg";
import { ImapFlow } from "imapflow";
import { decryptSecret } from "../src/lib/auth/crypto";
import { LIMITS } from "../src/lib/email/mailbox-inspector";
import type { DbClient } from "../src/lib/db/client";
import type { SyncOptions, SyncResult } from "../src/lib/email/sync";
import { assertTarget } from "./inspect-mailbox";

export const NEEDS_REPLY_NAMES = ["CryptoSense AI", "FXPULSE", "Forex Cipher", "Forexearlywarning", "Money Bells",
  "NeverSleep Forex Signals", "OnwardBTC", "Scope Signals", "Y7Signals", "Zak FX Hub Academy"] as const;
export const ONWARD_UTC = ["2026-10-17T23:25:00.000Z", "2026-10-24T09:47:00.000Z"] as const;
const MAX_PASSES = 60;

export type Command = "dry-run" | "sent" | "check-sent" | "inbox" | "bounces-preview" | "bounces-apply";
export function parseCommand(args: string[]): Command {
  if (args.length === 1 && args[0] === "dry-run") return "dry-run";
  if (args.length === 1 && args[0] === "check-sent") return "check-sent";
  if (args.length === 2 && args[0] === "sent" && args[1] === "IMPORT-SENT-ITEMS") return "sent";
  if (args.length === 2 && args[0] === "inbox" && args[1] === "IMPORT-INBOX") return "inbox";
  if (args.length === 1 && args[0] === "bounces-preview") return "bounces-preview";
  if (args.length === 2 && args[0] === "bounces-apply" && args[1] === "APPLY-HISTORICAL-BOUNCES") return "bounces-apply";
  throw new Error("command_rejected");
}

export const CONVERSATION_NAMES = ["Forex Cipher", "NeverSleep Forex Signals", "OnwardBTC", "Scope Signals", "Zak FX Hub Academy"];
export type RecoveryDb = Pick<DbClient, "query">;
export type FolderReader = (input: { focus: string; countsOnly: false; limit: number }) => Promise<{ focused?: { folder: string } | null }>;
export interface RecoveryDependencies {
  db: DbClient;
  sync: (accountId: string, options: SyncOptions) => Promise<SyncResult>;
  getFolderInbox: FolderReader;
}

export async function checkpointComplete(db: RecoveryDb, accountId: string, folder: string) {
  const rows = (await db.query<{ history_complete: boolean; error: string | null }>(
    `SELECT history_complete,error FROM mailbox_sync_state WHERE account_id = $1 AND folder = $2`, [accountId, `backfill:${folder}`])).rows;
  return rows.length === 1 && rows[0].history_complete === true && !rows[0].error;
}
export async function readFolders(db: RecoveryDb, getFolderInbox: FolderReader) {
  const folders: Record<string, string | null> = {};
  for (const name of [...NEEDS_REPLY_NAMES, "IVI Cryptos"]) {
    const rows = (await db.query<{ id: string }>(`SELECT id FROM prospects WHERE business_name = $1 AND archived_at IS NULL`, [name])).rows;
    folders[name] = rows.length === 1 ? (await getFolderInbox({ focus: rows[0].id, countsOnly: false, limit: 1 })).focused?.folder ?? null : "not_unique";
  }
  return folders;
}
export async function checkSent(db: RecoveryDb, accountId: string, getFolderInbox: FolderReader, options: { requireAnsweredFolders?: boolean } = {}) {
  const folders = await readFolders(db, getFolderInbox);
  const onward = (await db.query<{ sent_at: string; conversation_id: string; prospect_id: string }>(`SELECT m.sent_at,m.conversation_id,c.prospect_id
    FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN prospects p ON p.id = c.prospect_id
    WHERE p.business_name = 'OnwardBTC' AND p.archived_at IS NULL AND m.prospect_id = p.id
      AND m.account_id = $1 AND m.direction = 'outbound' AND m.folder = 'Sent Items'
      AND m.sent_at = ANY($2::timestamptz[])`, [accountId, [...ONWARD_UTC]])).rows;
  const exactTimes = ONWARD_UTC.map(time => onward.filter(r => new Date(r.sent_at).toISOString() === time).length);
  const duplicates = (await db.query<{ message_ids: number; physical_uids: number; conversations: number }>(`SELECT
    (SELECT count(*)::int FROM (SELECT account_id,message_id FROM messages WHERE message_id IS NOT NULL AND message_id <> '' GROUP BY account_id,message_id HAVING count(*) > 1) d) AS message_ids,
    (SELECT count(*)::int FROM (SELECT account_id,folder,uidvalidity,uid FROM messages WHERE uid IS NOT NULL AND uidvalidity IS NOT NULL GROUP BY account_id,folder,uidvalidity,uid HAVING count(*) > 1) d) AS physical_uids,
    (SELECT count(*)::int FROM (SELECT prospect_id FROM conversations GROUP BY prospect_id HAVING count(*) > 1) d) AS conversations`)).rows[0];
  const checkpoint = await checkpointComplete(db, accountId, "Sent Items");
  const complete = checkpoint && (options.requireAnsweredFolders === false || CONVERSATION_NAMES.every(name => folders[name] === "in_conversation"))
    && exactTimes.every(n => n === 1) && new Set(onward.map(r => r.conversation_id)).size === 1
    && new Set(onward.map(r => r.prospect_id)).size === 1 && !!duplicates && Object.values(duplicates).every(n => Number(n) === 0);
  return { complete, checkpoint, folders, onward: exactTimes.map((count, i) => ({ time: ONWARD_UTC[i], count })), duplicates };
}
export async function forbiddenSnapshot(db: RecoveryDb) {
  return (await db.query(`SELECT
    (SELECT count(*)::int FROM suppressions) AS suppressions,
    (SELECT count(*)::int FROM email_bounces) AS email_bounces,
    (SELECT count(*)::int FROM prospect_emails) AS prospect_emails,
    (SELECT count(*)::int FROM outbound_sends) AS outbound_sends,
    (SELECT count(*)::int FROM messages WHERE source = 'smtp') AS smtp_messages,
    (SELECT count(*)::int FROM message_translations) AS translations,
    (SELECT count(*)::int FROM audit_log WHERE action IN ('message.linked','message.unlinked','message.rejected','lead.email_linked','lead.email_unlinked','lead.recipient_set')) AS link_audits,
    (SELECT count(*)::int FROM workspace_settings) AS workspace_rows,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id)::text,'[]')) FROM workspace_settings t) AS workspace_digest,
    (SELECT count(*)::int FROM ai_task_settings) AS ai_rows,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.task)::text,'[]')) FROM ai_task_settings t) AS ai_digest`)).rows[0];
}
export async function importFolder(deps: RecoveryDependencies, accountId: string, founderUserId: string, folder: "Sent Items" | "INBOX") {
  if (folder === "INBOX" && !(await checkSent(deps.db, accountId, deps.getFolderInbox)).complete) throw new Error("sent_check_failed");
  const before = await forbiddenSnapshot(deps.db);
  const beforeIds = (await deps.db.query<{ id: string }>(`SELECT id FROM messages`)).rows.map(r => r.id);
  const totals = { passes: 0, imported: 0, filled: 0, skipped: 0, errors: 0 };
  let progress: SyncResult["progress"] = [], complete = false;
  try {
    while (totals.passes < MAX_PASSES) {
      const result = await deps.sync(accountId, { mode: "backfill", founderUserId, recoveryFolder: folder,
        linkCertainAddresses: false, processHistoricalBounces: false });
      totals.passes++; totals.imported += result.imported; totals.filled += result.filled ?? 0;
      totals.skipped += result.skipped; totals.errors += result.errors.length;
      progress = result.progress ?? [];
      if (result.errors.length) break;
      if (progress.length !== 1 || progress[0].folder !== folder || result.folders.some(f => f.folder !== folder)) break;
      complete = result.complete === true && !result.historyIncomplete && progress[0].complete && progress[0].remaining === 0;
      if (complete) break;
    }
  } finally {
    if (JSON.stringify(before) !== JSON.stringify(await forbiddenSnapshot(deps.db))) throw new Error("forbidden_effects_changed");
  }
  const perLead = (await deps.db.query<{ lead: string; imported: number; threads: number }>(`SELECT coalesce(p.business_name,'Unmatched') AS lead,
    count(*)::int AS imported,count(DISTINCT m.conversation_id)::int AS threads FROM messages m
    LEFT JOIN conversations c ON c.id = m.conversation_id LEFT JOIN prospects p ON p.id = coalesce(m.prospect_id,c.prospect_id)
    WHERE m.account_id = $1 AND NOT (m.id = ANY($2::uuid[])) GROUP BY coalesce(p.business_name,'Unmatched') ORDER BY lead`, [accountId, beforeIds])).rows;
  return { complete, totals, perFolder: [{ folder, imported: totals.imported, skipped: totals.skipped, filled: totals.filled }],
    perLead, classifyUnmatched: true, progress, forbiddenEffectsEqual: true, folders: await readFolders(deps.db, deps.getFolderInbox) };
}
/** Testable command boundary: every incomplete page/error is a nonzero command result. */
export async function executeCommand(command: Exclude<Command, "dry-run">, deps: RecoveryDependencies) {
  const accounts = (await deps.db.query<{ id: string }>(`SELECT id FROM email_accounts WHERE provider <> 'sandbox' AND status = 'connected'`)).rows;
  const founders = (await deps.db.query<{ id: string }>(`SELECT id FROM users WHERE role = 'founder' AND is_active = true`)).rows;
  if (accounts.length !== 1 || founders.length !== 1) throw new Error("account_or_founder_not_unique");
  const accountId = accounts[0].id, founderUserId = founders[0].id;
  if (command === "sent" || command === "inbox") {
    const result = await importFolder(deps, accountId, founderUserId, command === "sent" ? "Sent Items" : "INBOX");
    const checked = result.complete ? await checkSent(deps.db, accountId, deps.getFolderInbox, { requireAnsweredFolders: command === "sent" }) : null;
    return { ...result, sentCheck: checked, complete: result.complete && checked?.complete === true };
  }
  const sentCheck = await checkSent(deps.db, accountId, deps.getFolderInbox, { requireAnsweredFolders: command === "check-sent" });
  if (command === "check-sent") return sentCheck;
  if (!sentCheck.complete) throw new Error("sent_check_failed");
  if (!await checkpointComplete(deps.db, accountId, "INBOX")) throw new Error("inbox_checkpoint_incomplete");
  const bounces = await import("@/lib/email/bounce-handling");
  const preview = await deps.db.transaction(async tx => {
    await tx.query("SET TRANSACTION READ ONLY");
    return bounces.previewHistoricalBounces(accountId, { suppliedDbClient: tx, includeAddresses: true });
  });
  if (command === "bounces-preview") return { complete: preview.incomplete === 0, result: preview };
  if (preview.incomplete > 0) throw new Error("bounce_preview_incomplete");
  // Preview must be shown as a distinct command before this explicitly approved apply operation.
  const result = await bounces.applyHistoricalBounces({ accountId, founderUserId, confirmation: "APPLY HISTORICAL BOUNCES" });
  const after = await deps.db.query<{ normalized_email: string }>(`SELECT normalized_email FROM suppressions WHERE active AND normalized_email = ANY($1::text[])`, [preview.newlySuppressed?.map(r => r.address) ?? []]);
  return { complete: result.unprocessed === 0 && after.rows.length === preview.wouldNewlySuppress, result };
}

export async function runRecoveryCommand(command: Exclude<Command, "dry-run">, deps: RecoveryDependencies) {
  try {
    const report = await executeCommand(command, deps);
    return { report, exitCode: report.complete === true ? 0 : 1 };
  } catch (error) {
    return { report: { complete: false, error: error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "run_failed" }, exitCode: 1 };
  }
}

export async function main() {
  let raw: Client | undefined;
  let close: (() => Promise<void>) | undefined;
  let out: Record<string, unknown> = { schemaVersion: 2, complete: false };
  try {
    const command = parseCommand(process.argv.slice(2));
    if (process.platform !== "linux") throw new Error("runtime_rejected");
    const env = config({ path: "/home/growth/.env.production", quiet: true, debug: false, override: true });
    if (env.error || !process.env.DATABASE_URL) throw new Error("environment_unavailable");
    assertTarget(process.env.DATABASE_URL);
    process.env.AUTO_MIGRATE = "false";
    if (command === "dry-run") {
      let connectionError = false;
      raw = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15_000, query_timeout: 60_000, application_name: "readonly-mailbox-recovery" });
      raw.on("error", () => { connectionError = true; });
      await raw.connect();
      const { runRecoveryDryRun } = await import("../src/lib/email/recovery-dry-run");
      out = await runRecoveryDryRun(raw, account => {
        const imap = new ImapFlow({ host: account.imap_host, port: account.imap_port, secure: account.imap_secure,
          auth: { user: account.username, pass: decryptSecret(account.password_encrypted) }, logger: false, logRaw: false, emitLogs: false,
          disableAutoIdle: true, socketTimeout: 60_000, connectionTimeout: 20_000, greetingTimeout: 20_000,
          maxLineLength: 1024 * 1024, maxLiteralSize: LIMITS.maxMessageBytes + 1,
          maxResponseSize: LIMITS.maxMessageBytes + 1024 * 1024, maxResponseTokens: 100_000 });
        imap.on("error", () => { connectionError = true; });
        return imap;
      });
      if (connectionError) { out.complete = false; out.error = "connection_event_error"; }
    } else {
      const { getDb, closeDb } = await import("@/lib/db/client");
      close = closeDb;
      const db = await getDb();
      const { syncEmailAccount } = await import("@/lib/email/sync");
      const { getFolderInbox } = await import("@/lib/services/inbox");
      const result = await runRecoveryCommand(command, { db, sync: syncEmailAccount, getFolderInbox });
      out = { schemaVersion: 2, command, ...result.report };
      process.exitCode = result.exitCode;
    }
  } catch (error) {
    out.complete = false;
    out.error = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "run_failed";
  } finally {
    try { if (raw) await raw.end(); if (close) await close(); } catch { out.complete = false; out.error = "cleanup_failed"; }
  }
  if (!out.complete) process.exitCode = 1;
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (process.argv[1] && /(?:^|[\\/])recover-mailbox\.ts$/.test(process.argv[1])) void main();
