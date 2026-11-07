import { describe, expect, it } from "vitest";
import { analyzeRecoveryFacts, runRecoveryDryRun } from "../src/lib/email/recovery-dry-run";
import { matchRecoveryOwner, recoverySqlLookups } from "../src/lib/email/recovery-matching";
import { type Facts, type Row } from "../src/lib/email/mailbox-inspector";
import { inspectWithClients, type AuditDb, type ReadOnlyImap } from "../scripts/inspect-mailbox";
function facts(): Facts {
  return { accountId: "account-private", leads: [{ id: "p-private", business_name: "Synthetic Lead" }], conversations: [{ id: "thread-private", prospect_id: "p-private", subject: "Topic" }],
    messages: [{ id: "db-private", account_id: "account-private", message_id: "<Parent@private.invalid>", conversation_id: "thread-private", prospect_id: "p-private" }],
    emails: [{ prospect_id: "p-private", normalized_email: "lead@private.invalid" }], suppressions: [], bounces: [], legacy: [], states: [], mailbox: [], primarySent: "Sent Items", firstSync: 0 };
}
function mail(extra: Row = {}): Row {
  return { folder: "Sent Items", uid: 1, uidvalidity: "55", direction: "outbound", message_id: "<New@private.invalid>", in_reply_to: "<Parent@private.invalid>", references_json: [],
    to_emails: ["lead@private.invalid"], from_email: "owner@private.invalid", subject: "Re: Topic", bodyLength: 10, bodyBlank: false, bodyDigest: "private-digest", bounceKind: "none", autoReply: false, ...extra };
}
describe("recovery ordered shadow policy", () => {
  it("rejects a Sent message from a different or ambiguous sender just like the writer", async () => {
    for (const extra of [{ from_email: "other@private.invalid", recoveryFromCount: 1 }, { recoveryFromCount: 2 }]) {
      const f = facts(); f.recoveryAccountEmail = "owner@private.invalid"; f.mailbox = [mail(extra)];
      expect(await analyzeRecoveryFacts(f)).toMatchObject({ complete: false, wouldImport: 0, errors: ["sent_sender_not_account"] });
    }
  });
  it("models Sent first then Inbox with ascending UID and newly imported thread headers", async () => {
    const f = facts();
    f.mailbox = [mail({ folder: "INBOX", direction: "inbound", uid: 1, message_id: "<Reply@private.invalid>", in_reply_to: "<Later@private.invalid>", from_email: "unknown@private.invalid" }),
      mail({ uid: 2, message_id: "<Later@private.invalid>", in_reply_to: "<New@private.invalid>", to_emails: [], subject: "Different" }), mail()];
    const before = JSON.stringify(f);
    const r = await analyzeRecoveryFacts(f);
    expect(r).toMatchObject({ complete: true, wouldImport: 3 });
    expect(r.perLead).toEqual([expect.objectContaining({ leadName: "Synthetic Lead", wouldImport: 3 })]);
    expect(r.threads).toEqual([{ leadName: "Synthetic Lead", matched: 3, threadHeaders: 3, uniqueAddressSubject: 0 }]);
    expect(r.perFolder.map((p: Row) => p.folder)).toEqual(["Sent Items", "INBOX"]);
    expect(JSON.stringify(f)).toBe(before);
    for (const token of ["private", "Topic", "<", "@", "thread-private"]) expect(JSON.stringify(r)).not.toContain(token);
  });
  it("does not infer backward from a future UID and predicts other Sent folders inventory only", async () => {
    const f = facts(); f.mailbox = [mail({ uid: 1, in_reply_to: "<Future@private.invalid>", to_emails: [], subject: "Unknown" }), mail({ uid: 2, message_id: "<Future@private.invalid>" }), mail({ folder: "Archive/Sent", uid: 3 })];
    const r = await analyzeRecoveryFacts(f);
    expect(r).toMatchObject({ wouldImport: 2, inventoryOnlyOccurrences: 1 });
    expect(r.perLead.find((p: Row) => p.leadName === "Unmatched").wouldImport).toBe(1);
  });
  it("distinguishes persisted and within-run duplicates and hydrates once", async () => {
    const f = facts(); f.messages.push({ ...mail(), id: "blank", account_id: f.accountId, bodyLength: 0, bodyBlank: true });
    f.mailbox = [mail(), mail({ folder: "INBOX", direction: "inbound", uid: 8 }), mail({ uid: 2, message_id: "<Fresh@private.invalid>" }), mail({ folder: "INBOX", uid: 9, message_id: "<Fresh@private.invalid>" })];
    expect(await analyzeRecoveryFacts(f)).toMatchObject({ wouldImport: 1, wouldSkipDuplicate: 3, persistedDuplicates: 2, withinRunDuplicates: 1, wouldHydrate: 1, wouldRematch: 1 });
  });
  it.each(["message.rejected", "message.unlinked", "message.linked"])("honors newest founder decision %s", async action => {
    const f = facts(); f.messages.push({ ...mail(), id: "old", account_id: f.accountId, bodyLength: 12, error: null });
    f.auditDecisions = [{ entity_id: "old", prospect_id: "p-private", action }]; f.mailbox = [mail()];
    expect(await analyzeRecoveryFacts(f)).toMatchObject({ wouldHydrate: 0, wouldRematch: action === "message.linked" ? 1 : 0, founderVetoes: action === "message.linked" ? 0 : 1 });
  });
  it("only hydrates blanks or the exact legacy error marker; keeps complete short bodies", async () => {
    const f = facts(); f.messages.push({ ...mail(), id: "old", account_id: f.accountId, bodyLength: 1, error: "excerpt only, full body pending mailbox sync" }); f.mailbox = [mail()];
    expect(await analyzeRecoveryFacts(f)).toMatchObject({ wouldHydrate: 1 });
    f.messages[1].error += ".";
    expect(await analyzeRecoveryFacts(f)).toMatchObject({ wouldHydrate: 0 });
  });
  it("stops incomplete when Message-ID and UID identify two rows", async () => {
    const f = facts(); f.messages.push({ ...mail(), id: "one", account_id: f.accountId, uid: 8 }, { ...mail(), id: "two", account_id: f.accountId, message_id: "<Other@private.invalid>" }); f.mailbox = [mail(), mail({ uid: 2 })];
    expect(await analyzeRecoveryFacts(f)).toMatchObject({ complete: false, errors: ["message_identity_conflict"], identityConflicts: 1, scanned: 1, wouldImport: 0 });
  });
  it("ambiguous headers never fall back; preserves Message-ID case", async () => {
    const f = facts(); f.conversations.push({ id: "second", prospect_id: "p-private", subject: "Topic" });
    f.messages.push({ ...f.messages[0], id: "other", conversation_id: "second" }); f.mailbox = [mail()];
    expect((await analyzeRecoveryFacts(f)).perLead[0].leadName).toBe("Unmatched");
    f.conversations.pop(); f.messages.pop(); f.emails = [];
    f.mailbox[0].in_reply_to = "<parent@private.invalid>";
    expect((await analyzeRecoveryFacts(f)).perLead[0].leadName).toBe("Unmatched");
  });
  it("requires one existing conversation and exact address/subject", async () => {
    const f = facts(); f.mailbox = [mail({ in_reply_to: null })];
    expect((await analyzeRecoveryFacts(f)).threads[0].uniqueAddressSubject).toBe(1);
    f.conversations[0].subject = "Different";
    expect((await analyzeRecoveryFacts(f)).perLead[0].leadName).toBe("Unmatched");
    f.conversations = [];
    expect((await analyzeRecoveryFacts(f)).perLead[0].leadName).toBe("Unmatched");
  });
  it("includes all retained historical messages beyond both old caps and scopes identity by account", async () => {
    const f = facts();
    f.mailbox = Array.from({ length: 81 }, (_, i) => mail({ uid: i + 1, message_id: `<Historic-${i}@private.invalid>`, when: Date.parse("2020-01-01") }));
    f.messages.push({ ...f.mailbox[0], id: "other-account", account_id: "other", prospect_id: "p-private", conversation_id: "thread-private" });
    expect(await analyzeRecoveryFacts(f)).toMatchObject({ complete: true, scanned: 81, wouldImport: 81, wouldSkipDuplicate: 0 });
  });
  it("never rematches existing automatic replies or delivery reports", async () => {
    for (const flags of [{ autoReply: true }, { deliveryReport: true, bounceKind: "permanent" }]) {
      const f = facts(); f.messages.push({ ...mail(), id: "old", account_id: f.accountId }); f.mailbox = [mail(flags)];
      expect(await analyzeRecoveryFacts(f)).toMatchObject({ wouldRematch: 0, wouldSkipDuplicate: 1 });
    }
  });
  it("requires exact approved physical folders", async () => {
    const f = facts(); f.inventoryFolders = ["INBOX", "Sent"];
    expect(await analyzeRecoveryFacts(f)).toMatchObject({ complete: false, errors: ["required_recovery_folder_missing"] });
  });
  it("SQL adapter performs SELECTs only", async () => {
    const queries: string[] = [];
    const db: AuditDb = { async query(sql) { expect(sql).toMatch(/^SELECT /); expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i); queries.push(sql);
      return { rows: sql.includes("FROM prospects") ? [{ id: "p" }] : sql.includes("SELECT id, subject") ? [{ id: "c", subject: "Topic" }] : [] }; } };
    expect(await matchRecoveryOwner({ direction: "inbound", fromEmail: "lead@private.invalid", toEmails: [], inReplyTo: "<Parent>", references: [], subject: "Re: Topic" }, recoverySqlLookups(db)))
      .toMatchObject({ prospectId: "p", conversationId: "c", matchedBy: "unique_address_subject" });
    expect(queries).toHaveLength(3);
  });
});
function readOnlyFixture(opts: { fail?: boolean; changed?: boolean } = {}) {
  const statements: string[] = [], calls: string[] = []; let folder = "", snapshots = 0;
  const source = Buffer.from("From: lead@private.invalid\r\nTo: owner@private.invalid\r\nMessage-ID: <Mail@private.invalid>\r\nSubject: Topic\r\n\r\nprivate body");
  const f = facts();
  const db: AuditDb = { async query(sql, values) {
    statements.push(sql);
    if (sql.startsWith("BEGIN READ ONLY") || sql === "ROLLBACK") return { rows: [] };
    expect(sql).toMatch(/^SELECT /); expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
    if (sql.includes("current_setting")) return { rows: [{ read_only: "on" }] };
    if (sql.includes("AS auto_followup_enabled_rows")) return { rows: [{ messages: opts.changed && ++snapshots > 1 ? 2 : 1 }] };
    if (sql.includes("FROM email_accounts")) return { rows: [{ id: f.accountId }] };
    if (sql.includes("FROM legacy.") || sql.includes("FROM audit_log")) return { rows: [] };
    const table = sql.match(/ FROM (\w+) ORDER BY id/)?.[1];
    const rows = table === "prospects" ? f.leads : table === "conversations" ? f.conversations : table === "prospect_emails" ? f.emails : [];
    return { rows: values?.[1] ? [] : structuredClone(rows) };
  } };
  const imap: ReadOnlyImap = {
    async connect() { calls.push("connect"); }, async list() { return [{ path: "INBOX" }, { path: "Sent Items", specialUse: "\\Sent" }, { path: "Archive/Sent" }]; },
    async mailboxOpen(path, options) { expect(options).toEqual({ readOnly: true }); folder = path; return { readOnly: true, uidValidity: 55n, uidNext: 2, exists: 1 }; },
    async *fetch(range, query, options) { calls.push("fetch"); expect(options).toEqual({ uid: true, binary: false }); if (opts.fail) throw new Error("private provider error");
      if (query.source) yield { uid: 1, source }; else yield { uid: 1, size: source.length, internalDate: new Date("2020-01-01") };
    }, async logout() { calls.push("logout"); }, close() { calls.push("close"); },
  };
  return { db, statements, calls, createImap: () => new Proxy(imap, { get(target, key) { if (!(key in target)) throw new Error(`IMAP mutation prohibited: ${String(key)}`); return target[key as keyof ReadOnlyImap]; } }) };
}
describe("CLI read-only recovery interface", () => {
  it("runs real inspector pipeline with SELECT/READ ONLY/ROLLBACK and no IMAP mutation API", async () => {
    const f = readOnlyFixture(); const r = await runRecoveryDryRun(f.db, f.createImap);
    expect(r).toMatchObject({ complete: true, errors: [], snapshotsEqual: true, recovery: { complete: true, wouldImport: 1, withinRunDuplicates: 1, inventoryOnlyOccurrences: 1 } });
    expect(r.recovery.perFolder).toHaveLength(2);
    expect(f.statements.filter(s => s === "ROLLBACK")).toHaveLength(2);
    expect(f.calls).toContain("logout");
    for (const token of ["private.invalid", "private body", "Mail@", "thread-private"]) expect(JSON.stringify(r)).not.toContain(token);
  });
  it.each([{ fail: true }, { changed: true }])("marks failures/snapshot changes incomplete %j", async opts => {
    const f = readOnlyFixture(opts); const r = await runRecoveryDryRun(f.db, f.createImap);
    expect(r.complete).toBe(false); expect(r.recovery.complete).toBe(false);
  });
  it("callback errors become fixed-code incomplete output, never exception content", async () => {
    const f = readOnlyFixture(); const r = await inspectWithClients(f.db, f.createImap, undefined, { analyzeFacts: async (facts, snapshot) => {
      expect(facts.mailbox).toHaveLength(3); expect(snapshot).toEqual({ messages: 1 }); throw new Error("private content");
    } });
    expect(r.complete).toBe(false); expect(r.errors).toContain("recovery_analysis_failed"); expect(JSON.stringify(r)).not.toContain("private content");
  });
});
