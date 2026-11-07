/**
 * Approved, standalone read-only audit. Run only after review, on the server:
 *   ./node_modules/.bin/tsx scripts/inspect-mailbox.ts
 * No arguments, file output, app DB/services, SMTP, imports, link or suppression writes.
 * stdout is a deliberately constructed counts/leadnames JSON report; errors are fixed codes.
 */
import { Client } from "pg";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { config } from "dotenv";
import { decryptSecret } from "../src/lib/auth/crypto";
import { analyze, digest, folderKind, folderLabel, LIMITS, mailFacts, stamp, type Facts, type Row } from "../src/lib/email/mailbox-inspector";

export interface AuditDb {
  query(sql: string, values?: any[]): Promise<{ rows: Row[] }>;
}
export interface ReadOnlyImap {
  connect(): Promise<void>;
  list(): Promise<any[]>;
  mailboxOpen(path: string, options: { readOnly: true }): Promise<any>;
  fetch(range: string, query: any, options: { uid: true; binary: false }): AsyncIterable<any>;
  logout(): Promise<any>;
  close(): void;
}
const SNAPSHOT_SQL = `SELECT (SELECT count(*)::int FROM messages) AS messages,
 (SELECT count(*)::int FROM suppressions) AS suppressions,
 (SELECT count(*)::int FROM suppressions WHERE active) AS active_suppressions,
 (SELECT count(*)::int FROM email_bounces) AS bounces,
 (SELECT count(*)::int FROM outbound_sends) AS sends,
 (SELECT count(*)::int FROM messages WHERE source = 'smtp') AS smtp_messages,
 (SELECT count(*)::int FROM mailbox_sync_state) AS sync_states,
 (SELECT count(*)::int FROM workspace_settings WHERE follow_up_auto_enabled) AS auto_followup_enabled_rows`;
export function assertTarget(connectionString: string) {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/growth" || url.search || url.hash) throw new Error("target_rejected");
}
async function pages(db: AuditDb, table: string, columns = "*") {
  // Only internal, constant table/column identifiers reach this helper.
  const rows: Row[] = [];
  let bytes = 0;
  for (let offset = 0; ; offset += LIMITS.dbPage) {
    const page = (await db.query(`SELECT ${columns} FROM ${table} ORDER BY id LIMIT $1 OFFSET $2`, [LIMITS.dbPage, offset])).rows;
    for (const row of page) {
      // Preserve just the digest/length, not accumulated complete database bodies.
      if (typeof row.body_text === "string") {
        row.bodyDigest = digest(row.body_text); row.bodyLength = row.body_text.length; row.bodyBlank = !row.body_text.trim();
        delete row.body_text;
      }
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (bytes > LIMITS.maxFactBytes) throw new Error("database_resource_limit");
      rows.push(row);
    }
    if (rows.length > LIMITS.maxRows) throw new Error("database_resource_limit");
    if (page.length < LIMITS.dbPage) return rows;
  }
}
export interface InspectionOptions {
  /** Trusted in-process analyzer: return counts/names only; never attach facts verbatim. */
  analyzeFacts?: (facts: Facts, snapshot: Row) => Promise<Row>;
}
export async function inspectWithClients(db: AuditDb, createImap: (account: Row) => ReadOnlyImap, parse = simpleParser, options: InspectionOptions = {}) {
  const report: Row = { schemaVersion: 1, complete: false, errors: [], inventory: [], coverage: [], before: null, after: null, snapshotsEqual: false,
    limits: LIMITS, invariants: { database: "direct_pg_BEGIN_READ_ONLY_SELECT_ROLLBACK", imap: "EXAMINE_BODY.PEEK", output: "counts_leadnames_only", writes: 0, historicalSkipReasonsReconstructable: false },
    limitations: ["Only retained INBOX and every LIST-discovered Sent candidate are content-scanned; other folders inventoried only.", "No deleted/expunged history; folder changes during scan invalidate completeness.", "Old newest-40 membership and exact historical skip reasons cannot be reconstructed; reason counters are nonexclusive evidence, not causal claims.", "Old 30-day evidence uses sync-state creation as a first-sync proxy and INTERNALDATE with an extra conservative day for IMAP date granularity; near-boundary cases remain unexplained.", "Bounce kind counts are recipient-level report outcomes; reportMessages counts deduplicated DSN/ARF messages.", "Weak address/subject, domain and signature-tail candidates never become links or enter chronology simulation; quoted text can produce weak name candidates.", "Waiting simulation compares exact-thread chronology only, not all portal folder precedence; no live fix.", "Before/after counts detect concurrent changes, not equal-content replacements; no claim that production is quiescent.", "Resource/time/oversize/parse failures are explicit incomplete coverage, never silent caps."] };
  let transaction = false;
  let phase = "database_snapshot";
  let imap: ReadOnlyImap | undefined;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; imap?.close(); }, LIMITS.timeoutMs);
  timer.unref();
  const checkTime = () => { if (timedOut) throw new Error("audit_timeout"); };
  try {
    await db.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ"); transaction = true;
    if ((await db.query("SELECT current_setting('transaction_read_only') AS read_only")).rows[0]?.read_only !== "on") throw new Error("read_only_not_confirmed");
    report.before = (await db.query(SNAPSHOT_SQL)).rows[0];
    phase = "account_selection";
    const accounts = (await db.query(`SELECT id, imap_host, imap_port, imap_secure, username, password_encrypted, last_sync_at, created_at FROM email_accounts WHERE provider <> 'sandbox' AND status = 'connected' ORDER BY id`)).rows;
    if (accounts.length !== 1) throw new Error("connected_account_not_unique");
    const account = accounts[0];
    phase = "database_facts";
    const leads = await pages(db, "prospects", "id, business_name, domain_key, archived_at");
    const conversations = await pages(db, "conversations", "id, prospect_id, subject, last_inbound_at, last_outbound_at");
    const messages = await pages(db, "messages", "id, account_id, prospect_id, conversation_id, direction, source, folder, uidvalidity, uid, message_id, in_reply_to, references_json, from_email, to_emails, subject, body_text, error, sent_at, received_at");
    const emails = await pages(db, "prospect_emails", "id, prospect_id, normalized_email");
    const suppressions = await pages(db, "suppressions", "id, normalized_email, reason, active");
    const bounces = await pages(db, "email_bounces", "id, message_id, normalized_email, kind");
    const states = await pages(db, "mailbox_sync_state", "id, account_id, folder, uidvalidity, last_uid, created_at");
    // The original 19 are reconstructed from the immutable archive, not today's error flags.
    const legacy = (await db.query(`SELECT DISTINCT mm.data->>'message_id' AS message_id,
      mm.data->>'uid' AS uid, mm.data->>'uidvalidity' AS uidvalidity,
      coalesce(mm.data->>'folder', 'INBOX') AS folder,
      CASE WHEN lk.data->>'state' = 'NEEDS_MATCHING' THEN 'needs_matching' ELSE 'excerpt' END AS cohort,
      coalesce(ex.data->>'excerpt', '') AS original_body
      FROM legacy.marketing_conversation_links lk
      JOIN legacy.marketing_mailbox_messages mm ON mm.id = lk.data->>'mailbox_id'
      LEFT JOIN legacy.marketing_reply_excerpts ex ON ex.data->>'mailbox_payload_id' = mm.data->>'payload_id'
      WHERE lk.data->>'state' = 'NEEDS_MATCHING' OR (lk.data->>'state' = 'MATCHED' AND EXISTS (
        SELECT 1 FROM legacy.marketing_growth_thread_messages tm
        WHERE tm.data->>'source_id' = lk.data->>'source_id' AND tm.data->>'direction' = 'INBOUND'))`)).rows;
    if (legacy.length > LIMITS.maxRows) throw new Error("legacy_resource_limit");
    checkTime();
    phase = "imap_client";
    imap = createImap(account);
    phase = "imap_connect";
    await imap.connect();
    phase = "imap_list";
    const folders = await imap.list();
    const candidates = folders.filter(f => folderKind(f));
    if (options.analyzeFacts) {
      const order = (path: string) => path === "Sent Items" ? 0 : path === "INBOX" ? 1 : 2;
      candidates.sort((a, b) => order(a.path) - order(b.path));
    }
    report.inventory = folders.map((f, i) => ({ ordinal: i + 1, folder: folderLabel(f.path, i + 1), kind: folderKind(f) || "inventory_only", selectable: !f.flags?.has("\\Noselect") }));
    if (!candidates.some(f => folderKind(f) === "inbound")) report.errors.push("inbox_not_listed");
    if (!candidates.some(f => folderKind(f) === "outbound")) report.errors.push("sent_not_listed");
    // Mirror the old sync's selection order solely for evidence-based other_sent_folder counts.
    const primarySent = folders.find(f => /\\Sent/i.test(f.specialUse || "")) || folders.find(f => /^sent( items)?$/i.test(f.path)) || folders.find(f => /sent/i.test(f.path));
    const mailbox: Row[] = [];
    let windows = 0;
    let factBytes = 0;
    const bounds: Row[] = [];
    for (const folder of candidates) {
      checkTime();
      const coverage: Row = { ordinal: folders.indexOf(folder) + 1, folder: folderLabel(folder.path, folders.indexOf(folder) + 1), direction: folderKind(folder), retainedAtOpen: 0, metadataFetched: 0, sourceParsed: 0, oversized: 0, parseFailed: 0, sourceMissing: 0, complete: false, errors: [] };
      report.coverage.push(coverage);
      try {
        const box = await imap.mailboxOpen(folder.path, { readOnly: true });
        if (!box.readOnly) throw new Error("examine_not_confirmed");
        const validity = String(box.uidValidity), uidNext = Number(box.uidNext), exists = Number(box.exists);
        if (!Number.isSafeInteger(uidNext) || uidNext < 1 || !Number.isSafeInteger(exists) || exists < 0 || !/^\d+$/.test(validity)) throw new Error("mailbox_metadata_invalid");
        coverage.retainedAtOpen = exists;
        bounds.push({ path: folder.path, validity, uidNext, exists, coverage });
        const seen = new Set<number>();
        for (let start = 1; start < uidNext; start += LIMITS.uidWindow) {
          checkTime();
          if (++windows > LIMITS.maxUidWindows) throw new Error("uid_window_resource_limit");
          const end = Math.min(uidNext - 1, start + LIMITS.uidWindow - 1);
          // Complete a metadata fetch before another command: no nested IMAP commands during iteration.
          const batch: Row[] = [];
          for await (const m of imap.fetch(`${start}:${end}`, { uid: true, size: true, internalDate: true }, { uid: true, binary: false })) {
            if (!Number.isSafeInteger(m.uid) || m.uid < start || m.uid > end || seen.has(m.uid)) throw new Error("uid_response_invalid");
            seen.add(m.uid); batch.push(m); coverage.metadataFetched++;
            if (seen.size > LIMITS.maxRows) throw new Error("mailbox_resource_limit");
          }
          for (const meta of batch) {
            checkTime();
            if (mailbox.length >= LIMITS.maxRows || factBytes >= LIMITS.maxFactBytes) throw new Error("mailbox_resource_limit");
            if (!Number.isSafeInteger(meta.size) || meta.size < 0) throw new Error("message_size_invalid");
            if (meta.size > LIMITS.maxMessageBytes) { coverage.oversized++; continue; }
            let source: Buffer | undefined;
            for await (const m of imap.fetch(String(meta.uid), { uid: true, source: { start: 0, maxLength: LIMITS.maxMessageBytes + 1 } }, { uid: true, binary: false })) {
              if (m.uid !== meta.uid || source) throw new Error("source_response_invalid");
              source = m.source;
            }
            if (!source || source.length !== meta.size) { coverage.sourceMissing++; continue; }
            if (source.length > LIMITS.maxMessageBytes) { coverage.oversized++; continue; }
            let facts: Row;
            try {
              const parsed = await parse(source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true });
              facts = mailFacts(parsed, source, { folder: folder.path, uid: meta.uid, uidvalidity: validity, internalDate: meta.internalDate, direction: folderKind(folder) }, leads);
            } catch { coverage.parseFailed++; continue; }
            factBytes += Buffer.byteLength(JSON.stringify(facts));
            if (factBytes > LIMITS.maxFactBytes) throw new Error("mailbox_resource_limit");
            mailbox.push(facts);
            coverage.sourceParsed++;
          }
        }
        const after = await imap.mailboxOpen(folder.path, { readOnly: true });
        if (!after.readOnly || String(after.uidValidity) !== validity || Number(after.uidNext) !== uidNext || Number(after.exists) !== exists) coverage.errors.push("mailbox_changed_during_scan");
        coverage.complete = coverage.sourceParsed === exists && coverage.metadataFetched === exists && !coverage.oversized && !coverage.parseFailed && !coverage.sourceMissing && !coverage.errors.length;
        if (!coverage.complete) coverage.errors.push("folder_coverage_incomplete");
      } catch { coverage.errors.push(timedOut ? "audit_timeout" : "folder_scan_failed"); }
    }
    const inventorySignature = (list: Row[]) => JSON.stringify(list.map(f => [f.path, f.specialUse || "", [...(f.flags || [])].sort()]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    if (inventorySignature(await imap.list()) !== inventorySignature(folders)) report.errors.push("inventory_changed_during_scan");
    for (const bound of bounds) {
      checkTime();
      const current = await imap.mailboxOpen(bound.path, { readOnly: true });
      if (!current.readOnly || String(current.uidValidity) !== bound.validity || Number(current.uidNext) !== bound.uidNext || Number(current.exists) !== bound.exists) {
        bound.coverage.complete = false;
        bound.coverage.errors.push("mailbox_changed_at_final_verification");
      }
    }
    const firstSync = Math.min(...states.filter(s => s.account_id === account.id).map(s => stamp(s.created_at)).filter(Boolean), Infinity);
    phase = "analysis";
    const facts: Facts = { recoveryAccountEmail: account.email_address, inventoryFolders: folders.filter(f => !f.flags?.has("\\Noselect")).map(f => f.path), accountId: account.id, leads, conversations, messages, emails, suppressions, bounces, legacy, states, mailbox,
      firstSync: Number.isFinite(firstSync) ? firstSync : 0, primarySent: primarySent?.path || null };
    if (options.analyzeFacts) {
      phase = "recovery_analysis";
      facts.auditDecisions = (await db.query(`SELECT DISTINCT ON (entity_id, metadata->>'prospectId')
        entity_id, metadata->>'prospectId' AS prospect_id, action FROM audit_log
        WHERE actor_type = 'founder' AND entity_type = 'message'
        AND action IN ('message.linked','message.unlinked','message.rejected')
        ORDER BY entity_id, metadata->>'prospectId', created_at DESC, id DESC LIMIT $1`, [LIMITS.maxRows + 1])).rows;
      if (facts.auditDecisions.length > LIMITS.maxRows) throw new Error("audit_resource_limit");
      report.recovery = await options.analyzeFacts(facts, report.before);
      if (!report.recovery.complete || report.recovery.errors?.length) report.errors.push("recovery_analysis_incomplete");
      checkTime();
    } else {
      report.analysis = analyze(facts);
      if (report.analysis.legacy.identifiedExcerptCohort !== 19 || report.analysis.legacy.identifiedNeedsMatchingCohort !== 8) report.errors.push("legacy_cohort_count_mismatch");
      if (report.analysis.needsReply.some((r: Row) => !r.complete)) report.errors.push("needs_reply_cohort_incomplete");
    }
  } catch { report.errors.push(timedOut ? "audit_timeout" : `${phase}_failed`); }
  finally {
    if (imap) { try { await imap.logout(); } catch { imap.close(); report.errors.push("imap_cleanup_failed"); } }
    if (transaction) { try { await db.query("ROLLBACK"); transaction = false; } catch { report.errors.push("database_cleanup_failed"); } }
    try {
      await db.query("BEGIN READ ONLY"); transaction = true;
      if ((await db.query("SELECT current_setting('transaction_read_only') AS read_only")).rows[0]?.read_only !== "on") throw new Error("read_only_not_confirmed");
      report.after = (await db.query(SNAPSHOT_SQL)).rows[0];
      report.snapshotsEqual = !!report.before && JSON.stringify(report.before) === JSON.stringify(report.after);
      if (!report.snapshotsEqual) report.errors.push("snapshot_changed_or_unavailable");
    } catch { report.errors.push("after_snapshot_failed"); }
    finally { if (transaction) { try { await db.query("ROLLBACK"); } catch { report.errors.push("database_cleanup_failed"); } } }
    clearTimeout(timer);
  }
  report.complete = !report.errors.length && (!options.analyzeFacts ? !!report.analysis : !!report.recovery?.complete) && report.coverage.length > 0 && report.coverage.every((c: Row) => c.complete);
  return report;
}

export async function main() {
  let db: Client | undefined;
  let connectionError = false;
  try {
    if (process.platform !== "linux" || process.argv.length !== 2) throw new Error("runtime_rejected");
    // Matches growth.service's verified EnvironmentFiles path, not the backup helper's DB-only file.
    const env = config({ path: "/home/growth/.env.production", quiet: true, debug: false, override: true });
    if (env.error || !process.env.DATABASE_URL) throw new Error("environment_unavailable");
    assertTarget(process.env.DATABASE_URL);
    db = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15_000, query_timeout: 60_000, application_name: "readonly-mailbox-inspector" });
    db.on("error", () => { connectionError = true; }); // Never print provider errors containing credentials/content.
    await db.connect();
    const report = await inspectWithClients(db, account => {
      const imap = new ImapFlow({ host: account.imap_host, port: account.imap_port, secure: account.imap_secure,
        auth: { user: account.username, pass: decryptSecret(account.password_encrypted) }, logger: false, logRaw: false, emitLogs: false,
        disableAutoIdle: true, socketTimeout: 60_000, connectionTimeout: 20_000, greetingTimeout: 20_000,
        maxLineLength: 1024 * 1024, maxLiteralSize: LIMITS.maxMessageBytes + 1,
        maxResponseSize: LIMITS.maxMessageBytes + 1024 * 1024, maxResponseTokens: 100_000 });
      imap.on("error", () => { connectionError = true; });
      return imap;
    });
    await db.end(); db = undefined;
    if (connectionError) { report.complete = false; report.errors.push("connection_event_error"); }
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.complete) process.exitCode = 1;
  } catch {
    if (db) { try { await db.end(); } catch { /* fixed-code output only */ } }
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, complete: false, errors: ["runtime_failed"] })}\n`);
    process.exitCode = 1;
  }
}
// Importing in unit tests cannot load env, decrypt credentials or establish any connection.
if (process.argv[1] && /(?:^|[\\/])inspect-mailbox\.ts$/.test(process.argv[1])) void main();
