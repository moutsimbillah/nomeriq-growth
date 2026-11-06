import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { simpleParser } from "mailparser";
import { analyze, digest, folderKind, LIMITS, mailFacts, NEEDS_REPLY_NAMES, normalizedSubject, ONWARD_CHECKS, sameTuple, stored, type Facts, type Row } from "../src/lib/email/mailbox-inspector";
import { assertTarget, inspectWithClients, type AuditDb, type ReadOnlyImap } from "../scripts/inspect-mailbox";

const accountId = "synthetic-account";
function baseFacts(): Facts {
  return { accountId, leads: NEEDS_REPLY_NAMES.map((business_name, i) => ({ id: `lead-${i}`, business_name, domain_key: `lead${i}.invalid` })), conversations: [], messages: [], emails: [], suppressions: [], bounces: [], legacy: [], states: [], mailbox: [], firstSync: 0, primarySent: "Sent Items" };
}
function mail(overrides: Row = {}): Row {
  return { folder: "Sent Items", uid: 1, uidvalidity: "55", message_id: "<out@synthetic.invalid>", references_json: ["<Parent@synthetic.invalid>"], in_reply_to: null, direction: "outbound",    from_email: "owner@synthetic.invalid", to_emails: ["lead@synthetic.invalid"], subject: "Re: Synthetic", when: Date.parse(ONWARD_CHECKS[0]), headerDate: Date.parse(ONWARD_CHECKS[0]), bodyLength: 20, bodyDigest: digest("synthetic full body"), bounceKind: "none", bounceRecipient: null, autoReply: false, signatureCandidates: [], ...overrides };
}
function withThread(): Facts {
  const f = baseFacts();
  f.messages = [{ id: "db-in", account_id: accountId, prospect_id: "lead-6", conversation_id: "conv", message_id: "<Parent@synthetic.invalid>", direction: "inbound", received_at: "2026-10-16T12:00:00Z", subject: "Synthetic", body_text: "excerpt" }];
  f.conversations = [{ id: "conv", prospect_id: "lead-6" }];
  f.mailbox = [mail()];
  return f;
}

/** Clients possess no mutation API. Unexpected SQL/method access throws, rather than simulating a write. */
function fixture(opts: { count?: number; leadCount?: number; failFetch?: boolean; changed?: boolean; oversize?: boolean; badParse?: boolean; mutateSnapshot?: boolean; noSent?: boolean; writable?: boolean } = {}) {
  const count = opts.count ?? 43;
  const source = Buffer.from("From: sender@synthetic.invalid\r\nTo: owner@synthetic.invalid\r\nSubject: synthetic private subject\r\nMessage-ID: <Synthetic@synthetic.invalid>\r\nDate: Sat, 17 Oct 2026 19:25:00 -0400\r\n\r\nsynthetic private body");
  const statements: string[] = [], calls: Row[] = [];
  let snapshots = 0, folder = "", openCount = 0;
  const base = baseFacts();
  for (let i = base.leads.length; i < (opts.leadCount || 0); i++) base.leads.push({ id: `extra-${i}`, business_name: `Extra synthetic ${i}` });
  const legacy = [...Array.from({ length: 19 }, (_, i) => ({ message_id: `<legacy-${i}@synthetic.invalid>`, uid: i + 1, uidvalidity: 55, folder: "INBOX", cohort: "excerpt", original_body: "" })), ...Array.from({ length: 8 }, (_, i) => ({ message_id: `<unmatched-${i}@synthetic.invalid>`, uid: i + 101, uidvalidity: 55, folder: "INBOX", cohort: "needs_matching" }))];
  const db: AuditDb = { async query(sql, values) {
    statements.push(sql);
    if (sql.startsWith("BEGIN READ ONLY") || sql === "ROLLBACK") return { rows: [] };
    if (!sql.startsWith("SELECT ")) throw new Error("unexpected SQL");
    if (sql.includes("current_setting('transaction_read_only')")) return { rows: [{ read_only: "on" }] };
    if (sql.includes("AS auto_followup_enabled_rows")) {
      snapshots++;
      return { rows: [{ messages: opts.mutateSnapshot && snapshots > 1 ? 2 : 1, suppressions: 0, bounces: 0, sends: 0, smtp_messages: 0, sync_states: 0, auto_followup_enabled_rows: 0 }] };
    }
    if (sql.includes("FROM email_accounts")) return { rows: [{ id: accountId }] };
    if (sql.includes("FROM legacy.")) return { rows: legacy };
    const table = sql.match(/ FROM (\w+) ORDER BY id/)?.[1];
    if (!table) throw new Error("unexpected query");
    const all = table === "prospects" ? base.leads : [];
    return { rows: all.slice(values?.[1] || 0, (values?.[1] || 0) + values?.[0]) };
  } };
  const imap: ReadOnlyImap = {
    async connect() { calls.push({ method: "connect" }); },
    async list() { calls.push({ method: "list" }); return [{ path: "INBOX", flags: new Set() }, ...opts.noSent ? [] : [{ path: "Sent Items", specialUse: "\\Sent", flags: new Set() }, { path: "Archive/Sent", flags: new Set() }], { path: "Drafts", flags: new Set() }]; },
    async mailboxOpen(path, options) {
      expect(options).toEqual({ readOnly: true });
      calls.push({ method: "mailboxOpen", path, options });
      if (folder !== path) openCount = 0;
      folder = path; openCount++;
      return { readOnly: !opts.writable, uidValidity: 55n, uidNext: opts.changed && openCount > 1 ? count + 8 : count + 1, exists: count };
    },
    async *fetch(range, query, options) {
      calls.push({ method: "fetch", range, query, options });
      expect(options).toEqual({ uid: true, binary: false });
      if (opts.failFetch) throw new Error("synthetic private provider error sender@synthetic.invalid");
      if (query.source) {
        expect(query.source).toEqual({ start: 0, maxLength: LIMITS.maxMessageBytes + 1 });
        const uid = Number(range);
        const bytes = Buffer.from(source.toString().replace("<Synthetic@", `<Synthetic-${folder.replaceAll("/", "-")}-${uid}@`));
        yield { uid, source: bytes };
      } else {
        expect(query).toEqual({ uid: true, size: true, internalDate: true });
        const [start, end] = range.split(":").map(Number);
        for (let uid = start; uid <= Math.min(count, end); uid++) {
          const bytes = Buffer.from(source.toString().replace("<Synthetic@", `<Synthetic-${folder.replaceAll("/", "-")}-${uid}@`));
          yield { uid, size: opts.oversize ? LIMITS.maxMessageBytes + 10 : bytes.length, internalDate: new Date("2026-10-17T23:25:00Z") };
        }
      }
    },
    async logout() { calls.push({ method: "logout" }); },
    close() { calls.push({ method: "close" }); },
  };
  const guarded = new Proxy(imap, { get(target, key) { if (!(key in target)) throw new Error("unapproved IMAP API"); return target[key as keyof ReadOnlyImap]; } });
  const parser = opts.badParse ? vi.fn(async () => { throw new Error("synthetic private parse error"); }) : simpleParser;
  return { db, imap: guarded, calls, statements, parser };
}

describe("mailbox inspector pure matching and privacy", () => {
  it("uses unique exact references and simulates chronology without claiming a live fix", () => {
    const result = analyze(withThread());
    const lead = result.needsReply.find(r => r.leadName === "OnwardBTC")!;
    expect(lead).toMatchObject({ missingExactOutbound: 1, laterMissingExactOutbound: 1, simulatedAfterExactFullImport: "Waiting_chronology_only", liveFixed: false });
    expect(result.onwardChecks[0]).toMatchObject({ mailboxMatches: 1, portalMissing: 1, exactThreadMatches: 1 });
    const output = JSON.stringify(result);
    for (const privateValue of ["synthetic.invalid", "<Parent", "Synthetic", "excerpt", "full body"]) expect(output).not.toContain(privateValue);
  });
  it("requires a unique thread prospect and marks conflicting references ambiguous", () => {
    const f = withThread();
    f.messages.push({ ...f.messages[0], id: "other", prospect_id: "lead-1" });
    expect(analyze(f).ambiguousMessages).toBe(1);
    expect(analyze(f).needsReply.find(r => r.leadName === "OnwardBTC")?.missingExactOutbound).toBe(0);
  });
  it("uses conversation ownership if direct prospect_id is null", () => {
    const f = withThread(); f.messages[0].prospect_id = null;
    expect(analyze(f).needsReply.find(r => r.leadName === "OnwardBTC")?.missingExactOutbound).toBe(1);
  });
  it("follows retained mailbox reference chains without promoting weak address matches", () => {
    const f = withThread();
    f.mailbox.unshift(mail({ uid: 2, message_id: "<later@synthetic.invalid>", references_json: ["<out@synthetic.invalid>"] }));
    expect(analyze(f).needsReply.find(r => r.leadName === "OnwardBTC")?.missingExactOutbound).toBe(2);
    f.mailbox.find(m => m.message_id === "<out@synthetic.invalid>")!.references_json = [];
    expect(analyze(f).needsReply.find(r => r.leadName === "OnwardBTC")?.missingExactOutbound).toBe(0);
  });
  it("recognizes an already-stored outbound even when it has no parent headers", () => {
    const f = withThread();
    f.messages.push({ ...f.mailbox[0], id: "stored", account_id: accountId, prospect_id: "lead-6" });
    f.mailbox[0].references_json = [];
    const lead = analyze(f).needsReply.find(r => r.leadName === "OnwardBTC")!;
    expect(lead).toMatchObject({ mailboxExactOutbound: 1, missingExactOutbound: 0 });
    expect(lead.reasons?.already_stored).toBe(1);
    expect(lead.reasons?.outside_newest40).toBeNull();
  });
  it("weak unique-address plus normalized subject is a candidate only", () => {
    const f = withThread(); f.mailbox[0].references_json = [];
    f.emails.push({ prospect_id: "lead-6", normalized_email: "lead@synthetic.invalid" });
    const lead = analyze(f).needsReply.find(r => r.leadName === "OnwardBTC");
    expect(lead).toMatchObject({ weakCandidates: 1, missingExactOutbound: 0, simulatedAfterExactFullImport: "Needs_reply_chronology_only" });
    expect(normalizedSubject(" RE: Fwd:  Synthetic  ")).toBe("synthetic");
  });
  it("does not select an owner for a shared address", () => {
    const f = withThread(); f.mailbox[0].references_json = [];
    f.emails = [{ prospect_id: "lead-6", normalized_email: "lead@synthetic.invalid" }, { prospect_id: "lead-1", normalized_email: "lead@synthetic.invalid" }];
    expect(analyze(f).ambiguousMessages).toBe(1);
  });
  it("Message-ID and tuple duplicates are account scoped", () => {
    const m = mail(), d = { ...m, account_id: "other" };
    expect(stored(m, [d], accountId)).toBe(false);
    expect(stored(m, [{ ...d, account_id: accountId }], accountId)).toBe(true);
    expect(sameTuple(m, { ...m, uidvalidity: "56" })).toBe(false);
    expect(sameTuple(m, { ...m, folder: "INBOX" })).toBe(false);
  });
  it("deduplicates report Message-IDs and counts recipients/suppressions, not every duplicate", () => {
    const f = baseFacts();
    f.mailbox = [mail({ direction: "inbound", bounceKind: "permanent", bounceRecipient: "dead@synthetic.invalid" }), mail({ direction: "inbound", folder: "INBOX", bounceKind: "permanent", bounceRecipient: "dead@synthetic.invalid" }), mail({ direction: "inbound", message_id: null, uid: 2, bounceKind: "complaint", bounceRecipient: null })];
    f.suppressions.push({ normalized_email: "dead@synthetic.invalid" });
    expect(analyze(f).bounces).toMatchObject({ permanent: 1, complaint: 1, duplicateReports: 1, unattributed: 1, distinctRecipients: 1, alreadySuppressed: 1, newSuppressionCandidates: 0 });
    expect(analyze(f).alternateAddressCandidates).toHaveLength(0);
  });
  it("does not double-count already recorded transient reports at suppression threshold", () => {
    const f = baseFacts();
    f.mailbox = [mail({ direction: "inbound", bounceKind: "transient", bounceRecipient: "soft@synthetic.invalid" })];
    f.messages = [{ ...f.mailbox[0], account_id: accountId, id: "stored-report" }];
    f.bounces = [{ message_id: "stored-report", normalized_email: "soft@synthetic.invalid", kind: "transient" }, { message_id: "other", normalized_email: "soft@synthetic.invalid", kind: "transient" }];
    expect(analyze(f).bounces).toMatchObject({ alreadyRecordedReports: 1, transientBelowThreshold: 1, newSuppressionCandidates: 0 });
    f.mailbox.push(mail({ message_id: "<new-report@synthetic.invalid>", uid: 2, direction: "inbound", bounceKind: "transient", bounceRecipient: "soft@synthetic.invalid" }));
    expect(analyze(f).bounces.newSuppressionCandidates).toBe(1);
  });
  it("inactive suppressions are new candidates, not already suppressed", () => {
    const f = baseFacts();
    f.mailbox = [mail({ direction: "inbound", bounceKind: "permanent", bounceRecipient: "dead@synthetic.invalid" })];
    f.suppressions = [{ normalized_email: "dead@synthetic.invalid", active: false }];
    expect(analyze(f).bounces).toMatchObject({ alreadySuppressed: 0, newSuppressionCandidates: 1 });
  });
  it("reports alias candidates by leadnames/current owner only, excluding delivery reports", () => {
    const f = withThread();
    f.mailbox = [mail({ direction: "inbound", from_email: "alias@lead6.invalid", signatureCandidates: ["lead-6"] })];
    expect(analyze(f).alternateAddressCandidates[0]).toMatchObject({ candidates: ["OnwardBTC"], confidence: "exact_thread" });
    f.mailbox[0].references_json = [];
    expect(analyze(f).alternateAddressCandidates[0]).toMatchObject({ candidates: ["OnwardBTC"], confidence: "domain_candidate_only" });
    expect(JSON.stringify(analyze(f))).not.toContain("alias@");
    f.mailbox[0].bounceKind = "permanent";
    expect(analyze(f).alternateAddressCandidates).toHaveLength(0);
  });
  it("keeps both supplied OnwardBTC timestamps in EDT and matches to minute", () => {
    const f = withThread(); f.mailbox.push(mail({ message_id: "<second@synthetic.invalid>", uid: 2, when: Date.parse(ONWARD_CHECKS[1]) + 59_000, headerDate: Date.parse(ONWARD_CHECKS[1]) + 59_000 }));
    expect(new Date(Date.parse(ONWARD_CHECKS[0])).toISOString()).toBe("2026-10-17T23:25:00.000Z");
    expect(new Date(Date.parse(ONWARD_CHECKS[1])).toISOString()).toBe("2026-10-24T09:47:00.000Z");
    expect(analyze(f).onwardChecks.map(c => c.mailboxMatches)).toEqual([1, 1]);
  });
  it("compares original legacy body, tuple, digest and length without outputting any", () => {
    const f = baseFacts(), body = "synthetic full body";
    f.mailbox = [mail({ bodyLength: body.length, bodyDigest: digest(body) })];
    f.messages = [{ ...f.mailbox[0], id: "legacy", account_id: accountId, body_text: "excerpt", bodyDigest: digest("excerpt"), bodyLength: "excerpt".length, prospect_id: "lead-6", conversation_id: "conv" }];
    f.legacy = [{ ...f.mailbox[0], cohort: "excerpt", original_body: "excerpt" }, { ...f.mailbox[0], cohort: "needs_matching" }];
    expect(analyze(f).legacy).toMatchObject({ identifiedExcerptCohort: 1, mailboxFullBodyAvailable: 1, currentDiffersFromMailbox: 1, originalEqualsCurrent: 1, identifiedNeedsMatchingCohort: 1, nowMatched: 1 });
  });
  it("lists all Sent paths, including nested and special-use folders", () => {
    expect(["Sent", "Sent Items", "INBOX/Sent", "Archive/Sent Messages"].map(path => folderKind({ path }))).toEqual(Array(4).fill("outbound"));
    expect(folderKind({ path: "Gesendet", specialUse: "\\Sent" })).toBe("outbound");
  });
  it("MIME parser preserves case-sensitive references; DSNs parse without returning content", async () => {
    const raw = Buffer.from("From: mailer-daemon@synthetic.invalid\r\nSubject: Delivery failure\r\nReferences: <CaseSensitive@synthetic.invalid>\r\nContent-Type: multipart/report; report-type=delivery-status; boundary=test\r\n\r\n--test\r\nContent-Type: text/plain\r\n\r\nDelivery failed\r\n--test\r\nContent-Type: message/delivery-status\r\n\r\nFinal-Recipient: rfc822; dead@synthetic.invalid\r\nAction: failed\r\nStatus: 5.1.1\r\n\r\n--test--\r\n");
    const facts = mailFacts(await simpleParser(raw), raw, {}, []);
    expect(facts.references_json).toEqual(["<CaseSensitive@synthetic.invalid>"]);
    expect(facts.bounceKind).toBe("permanent");
    expect(facts.bounceRecipient).toBe("dead@synthetic.invalid");
    expect(facts).not.toHaveProperty("bodyText");
  });
  it("OOO/vacation messages are not bounce suppression candidates", async () => {
    const raw = Buffer.from("From: no-reply@synthetic.invalid\r\nSubject: Automatic reply: Delivery failure\r\nAuto-Submitted: auto-replied\r\n\r\nI am on vacation");
    expect(mailFacts(await simpleParser(raw), raw, {}, []).bounceKind).toBe("none");
  });
  it("counts mixed-recipient DSN outcomes without losing the second recipient", async () => {
    const raw = Buffer.from("From: mailer-daemon@synthetic.invalid\r\nSubject: Delivery report\r\nContent-Type: text/plain\r\n\r\nFinal-Recipient: rfc822; hard@synthetic.invalid\r\nStatus: 5.1.1\r\nAction: failed\r\n\r\nFinal-Recipient: rfc822; soft@synthetic.invalid\r\nStatus: 4.2.2\r\nAction: delayed\r\n");
    const facts = mailFacts(await simpleParser(raw), raw, { direction: "inbound", folder: "INBOX", uid: 1, uidvalidity: 55 }, []);
    const f = baseFacts(); f.mailbox = [facts];
    expect(analyze(f).bounces).toMatchObject({ reportMessages: 1, permanent: 1, transient: 1, distinctRecipients: 2, newSuppressionCandidates: 1, transientBelowThreshold: 1 });
  });
  it("counts ARF complaints separately from ordinary autoreplies", async () => {
    const raw = Buffer.from("From: abuse@synthetic.invalid\r\nSubject: Feedback report\r\nContent-Type: multipart/report; report-type=feedback-report; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nOriginal-Recipient: rfc822; complained@synthetic.invalid\r\n\r\n--x--");
    const facts = mailFacts(await simpleParser(raw), raw, { direction: "inbound" }, []);
    expect(facts.bounceKind).toBe("complaint");
    expect(facts.bounceRecipient).toBe("complained@synthetic.invalid");
  });
});

describe("read-only injected runtime; no network or live credentials", () => {
  it("pages database facts through the final page past 500 rows", async () => {
    const f = fixture({ count: 0, leadCount: 501 });
    const r = await inspectWithClients(f.db, () => f.imap, f.parser);
    expect(r.complete).toBe(true);
    expect(f.statements.filter(s => /FROM prospects ORDER BY id/.test(s))).toHaveLength(2);
  });
  it("scans every retained UID in every Sent folder beyond 40 and pages beyond 200", async () => {
    const f = fixture({ count: 205 });
    const r = await inspectWithClients(f.db, () => f.imap, f.parser);
    expect(r.complete).toBe(true);
    expect(r.inventory).toHaveLength(4);
    expect(r.coverage).toHaveLength(3);
    expect(r.coverage.map((c: Row) => c.sourceParsed)).toEqual([205, 205, 205]);
    expect(r.analysis.scannedOccurrences).toBe(615);
    expect(f.calls.filter(c => c.method === "fetch" && !c.query.source)).toHaveLength(6);
    expect(f.statements.filter(s => s.startsWith("BEGIN READ ONLY"))).toHaveLength(2);
    expect(f.statements.filter(s => s === "ROLLBACK")).toHaveLength(2);
    expect(f.statements.every(s => s.startsWith("SELECT ") || s.startsWith("BEGIN READ ONLY") || s === "ROLLBACK")).toBe(true);
    expect(r.snapshotsEqual).toBe(true);
    expect(r.before).toEqual(r.after);
    const output = JSON.stringify(r);
    for (const privateValue of ["synthetic.invalid", "private subject", "private body", "Synthetic@", "password_encrypted"]) expect(output).not.toContain(privateValue);
  });
  it.each([{ failFetch: true }, { changed: true }, { oversize: true }, { badParse: true }, { writable: true }, { noSent: true }, { mutateSnapshot: true }])("fails closed with explicit incomplete coverage: %j", async options => {
    const f = fixture({ count: 1, ...options });
    const r = await inspectWithClients(f.db, () => f.imap, f.parser);
    expect(r.complete).toBe(false);
    expect(r.errors.length || r.coverage.some((c: Row) => !c.complete)).toBeTruthy();
    expect(JSON.stringify(r)).not.toContain("synthetic.invalid");
    expect(f.calls.at(-1)?.method).toBe("logout");
    expect(f.statements.at(-1)).toBe("ROLLBACK");
  });
  it("rejects nonlocal/wrong database/options before any production client exists", () => {
    for (const url of ["postgres://localhost/notgrowth", "postgres://remote.invalid/growth", "postgres://localhost/growth?host=remote.invalid", "postgres://localhost/growth#x"]) expect(() => assertTarget(url)).toThrow();
    expect(() => assertTarget("postgresql://localhost/growth")).not.toThrow();
    expect(() => assertTarget("postgres://127.0.0.1/growth")).not.toThrow();
  });
  it("installed ImapFlow maps readOnly to EXAMINE and source to BODY.PEEK, never Seen", () => {
    const require = createRequire(import.meta.url), root = dirname(require.resolve("imapflow"));
    const select = readFileSync(join(root, "commands/select.js"), "utf8");
    const fetch = readFileSync(join(root, "commands/fetch.js"), "utf8");
    expect(select).toContain("!options.readOnly ? 'SELECT' : 'EXAMINE'");
    expect(fetch).toContain("value: `${binaryAddressable ? commandKey : 'BODY'}.PEEK`");
    expect(fetch).toMatch(/if \(query.source\)[\s\S]*?setBodyPeek\(null, partial\)/);
    expect(fetch).not.toMatch(/['"](?:STORE|APPEND)['"]|markSeen/);
  });
  it("entrypoint import graph is standalone and has no mutation, model or filesystem-write APIs", () => {
    const source = readFileSync(join(process.cwd(), "scripts/inspect-mailbox.ts"), "utf8");
    const helper = readFileSync(join(process.cwd(), "src/lib/email/mailbox-inspector.ts"), "utf8");
    expect(source).not.toMatch(/getDb|from ["'].*(?:services|sync|accounts|bounce-handling|sent-copy|send-provider|nodemailer)/);
    expect(source + helper).not.toMatch(/\.(?:append|messageFlagsAdd|messageFlagsSet|messageFlagsRemove|messageDelete|mailboxCreate|mailboxDelete|messageMove|messageCopy|writeFile|createWriteStream)\s*\(/);
    expect(source).toContain('logger: false, logRaw: false, emitLogs: false');
    expect(source).toContain('path: "/home/growth/.env.production", quiet: true');
  });
});
