import { createHash } from "node:crypto";
import { getParsedBounceInput, isAutoReply, parseBounceReports } from "./bounces";

/** No runtime services, database bootstrap, mutations or logging in this module. */
export const NEEDS_REPLY_NAMES = ["CryptoSense AI", "FXPULSE", "Forex Cipher", "Forexearlywarning", "Money Bells", "NeverSleep Forex Signals", "OnwardBTC", "Scope Signals", "Y7Signals", "Zak FX Hub Academy"] as const;
export const ONWARD_CHECKS = ["2026-10-17T19:25:00-04:00", "2026-10-24T05:47:00-04:00"] as const;
export type Row = Record<string, any>; // Database and mailparser boundaries; never returned verbatim.
export const LIMITS = { uidWindow: 200, dbPage: 500, maxRows: 250_000, maxFactBytes: 128 * 1024 * 1024, maxMessageBytes: 32 * 1024 * 1024, maxUidWindows: 100_000, timeoutMs: 30 * 60_000, analysisTimeoutMs: 60_000, maxAnalysisSteps: 10_000_000 };
export function digest(text: string) { return createHash("sha256").update(text).digest("hex"); }
export function normalizedSubject(subject: string) { return subject.replace(/^(\s*(re|fw|fwd)\s*:\s*)+/i, "").replace(/\s+/g, " ").trim().toLowerCase(); }
export function addresses(value: any): string[] { return (Array.isArray(value) ? value : value ? [value] : []).filter((v): v is string => typeof v === "string").map(v => v.trim().toLowerCase()); }
export function stamp(value: any): number { const n = value ? new Date(value).getTime() : NaN; return Number.isFinite(n) ? n : 0; }
export function owner(row: Row, conversations: Row[]): string | null { return row.prospect_id || conversations.find(c => c.id === row.conversation_id)?.prospect_id || null; }
export function sameTuple(a: Row, b: Row): boolean {
  return !!a.message_id && a.message_id === b.message_id && a.uid != null && b.uid != null && a.uidvalidity != null && b.uidvalidity != null && String(a.uid) === String(b.uid) && String(a.uidvalidity) === String(b.uidvalidity) && a.folder === b.folder;
}
export function stored(message: Row, db: Row[], accountId: string): boolean {
  return db.some(m => m.account_id === accountId && ((message.message_id && message.message_id === m.message_id) || (m.folder === message.folder && m.uid != null && String(m.uid) === String(message.uid) && String(m.uidvalidity) === String(message.uidvalidity))));
}
export function folderKind(folder: Row): "inbound" | "outbound" | null {
  if (folder.path.toUpperCase() === "INBOX" || folder.specialUse === "\\Inbox") return "inbound";
  if (/\\Sent/i.test(folder.specialUse || "") || /sent/i.test(folder.path)) return "outbound";
  return null;
}
export function safeName(value: unknown): string | null { return typeof value === "string" && value.length <= 120 && !/[@\r\n\x00-\x1f]/.test(value) ? value : null; }
export function folderLabel(path: string, ordinal: number) { return /^[\w ./\\-]{1,100}$/.test(path) && !path.includes("@") ? path : `folder_${ordinal}`; }

/** Extract just facts/digests. MIME/raw content stays in the caller's process, never in the report. */
export function mailFacts(parsed: Row, raw: Buffer, envelope: Row, leads: Row[]): Row {
  const body = parsed.text || (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : "");
  // Match storeParsedMessage's bodyText hydration eligibility without retaining content.
  const recoveryBody = parsed.text?.trim() ? parsed.text.trim() : typeof parsed.html === "string" ? parsed.html
    .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim() : "";
  const from = addresses(parsed.from?.value?.map((a: Row) => a.address))[0] || "";
  // Parse authoritative MIME parts before excluding automatic replies. Real DSNs may carry
  // Auto-Submitted: auto-replied and a quoted report-type; their attached original is not evidence.
  const input = getParsedBounceInput(parsed as any);
  const deliveryReports = parseBounceReports(input).map(r => ({ kind: r.kind, recipient: r.recipient }));
  const report = deliveryReports[0] ?? { kind: "none", recipient: null };
  const autoReply = !deliveryReports.length && isAutoReply(input);
  const signature = body.slice(-4000).toLowerCase();
  const signatureCandidates = leads.filter(p => p.business_name?.length >= 5 && signature.includes(p.business_name.toLowerCase())).map(p => p.id);
  return { ...envelope, recoveryBodyLength: recoveryBody.length, recoveryBodyBlank: !recoveryBody, recoveryBodyDigest: digest(recoveryBody), message_id: parsed.messageId?.trim() || null, references_json: (Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []).filter((v: unknown) => typeof v === "string"), in_reply_to: parsed.inReplyTo || null,
    from_email: from, recoveryFromCount: parsed.from?.value?.length ?? 0, to_emails: addresses([...(parsed.to?.value || []), ...(parsed.cc?.value || [])].map((a: Row) => a.address)),
    subject: parsed.subject || "", recoveryToEmails: addresses((parsed.to?.value || []).map((a: Row) => a.address)), deliveryReport: deliveryReports.length > 0 || /multipart\/report|message\/delivery-status|feedback-report/i.test(input.contentType || ""), bodyBlank: !body.trim(), when: stamp(parsed.date) || stamp(envelope.internalDate), headerDate: stamp(parsed.date), internalTime: stamp(envelope.internalDate), bodyLength: body.length, bodyDigest: digest(body),
    bounceKind: report.kind, bounceRecipient: report.recipient, deliveryReports, autoReply, signatureCandidates };
}

export interface Facts { recoveryAccountEmail?: string; inventoryFolders?: string[]; auditDecisions?: Row[]; accountId: string; leads: Row[]; conversations: Row[]; messages: Row[]; emails: Row[]; suppressions: Row[]; bounces: Row[]; legacy: Row[]; states: Row[]; mailbox: Row[]; firstSync: number; primarySent: string | null; }
export function analyze(f: Facts) {
  const deadline = Date.now() + LIMITS.analysisTimeoutMs;
  let steps = 0;
  const guard = () => { if (++steps > LIMITS.maxAnalysisSteps || Date.now() > deadline) throw new Error("analysis_resource_limit"); };
  const name = (id: string | null) => safeName(f.leads.find(p => p.id === id)?.business_name);
  const threadOwners = new Map<string, Set<string>>();
  for (const m of f.messages) { const id = owner(m, f.conversations); if (m.message_id && id) { const set = threadOwners.get(m.message_id) || new Set<string>(); set.add(id); threadOwners.set(m.message_id, set); } }
  const resolve = (m: Row) => {
    guard();
    const ids = new Set<string>();
    for (const ref of [m.message_id, m.in_reply_to, ...(m.references_json || [])].filter(Boolean)) for (const id of threadOwners.get(ref) || []) ids.add(id);
    if (ids.size === 1) return { id: [...ids][0], confidence: "exact_thread", ambiguous: false };
    if (ids.size > 1) return { id: null, confidence: "ambiguous_thread", ambiguous: true };
    const candidates = new Set(f.emails.filter(e => (m.direction === "inbound" ? [m.from_email] : m.to_emails).includes(e.normalized_email) && f.leads.some(p => p.id === e.prospect_id && !p.archived_at)).map(e => e.prospect_id));
    if (candidates.size !== 1) return { id: null, confidence: candidates.size ? "ambiguous_address" : "unmatched", ambiguous: candidates.size > 1 };
    const id = [...candidates][0];
    const subjects = f.messages.filter(d => owner(d, f.conversations) === id).map(d => normalizedSubject(d.subject));
    return subjects.includes(normalizedSubject(m.subject)) && normalizedSubject(m.subject) ? { id, confidence: "weak_address_subject", ambiguous: false } : { id: null, confidence: "thread_not_matched", ambiguous: false };
  };
  // Deduplicate analysis, but retain every folder/UID occurrence for reasons and legacy tuple evidence.
  const groups = new Map<string, Row[]>();
  for (const m of f.mailbox) { const key = m.message_id || `${m.folder}:${m.uidvalidity}:${m.uid}`; const g = groups.get(key) || []; g.push(m); groups.set(key, g); }
  const unique: Row[] = [...groups.values()].map(occurrences => {
    const selected = occurrences.find(m => m.direction === "outbound") || occurrences[0];
    return { ...selected, occurrences, match: resolve(selected), present: occurrences.some(m => stored(m, f.messages, f.accountId)) };
  });
  // Propagate the complete set of possible owners through retained-mailbox references.
  // Union, rather than first-match assignment, makes conflicts order independent.
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of f.mailbox) {
      guard();
      if (!m.message_id || m.bounceKind !== "none" || m.autoReply) continue;
      const set = threadOwners.get(m.message_id) || new Set<string>();
      const previous = set.size;
      for (const ref of [m.in_reply_to, ...(m.references_json || [])].filter(Boolean)) for (const id of threadOwners.get(ref) || []) set.add(id);
      if (set.size) threadOwners.set(m.message_id, set);
      if (set.size !== previous) changed = true;
    }
  }
  for (const m of unique) {
    const matches = m.occurrences.map((x: Row) => resolve(x));
    const owners = new Set(matches.map((x: Row) => x.id).filter(Boolean));
    m.match = owners.size > 1 || matches.some((x: Row) => x.ambiguous)
      ? { id: null, confidence: "ambiguous_duplicate_or_thread", ambiguous: true }
      : matches.find((x: Row) => x.confidence === "exact_thread") || resolve(m);
  }
  const counts = { reportMessages: 0, permanent: 0, transient: 0, complaint: 0, unattributed: 0, autoRepliesExcluded: 0, duplicateReports: 0, distinctRecipients: 0, alreadySuppressed: 0, newSuppressionCandidates: 0, transientBelowThreshold: 0, alreadyRecordedReports: 0 };
  const recipients = new Map<string, { hard: boolean; soft: number; newSoft: number }>();
  for (const m of unique.filter(m => m.occurrences.some((x: Row) => x.direction === "inbound"))) {
    guard();
    if (m.autoReply && m.bounceKind === "none") counts.autoRepliesExcluded++;
    if (m.bounceKind === "none") continue;
    counts.reportMessages++;
    counts.duplicateReports += m.occurrences.filter((x: Row) => x.direction === "inbound").length - 1;
    const dbIds = new Set(f.messages.filter(d => m.occurrences.some((x: Row) => stored(x, [d], f.accountId))).map(d => d.id));
    const recorded = f.bounces.some(b => dbIds.has(b.message_id));
    if (recorded) counts.alreadyRecordedReports++;
    for (const part of m.deliveryReports || [{ kind: m.bounceKind, recipient: m.bounceRecipient }]) {
      if (part.kind === "none") continue;
      counts[part.kind as "permanent" | "transient" | "complaint"]++;
      if (!part.recipient) { counts.unattributed++; continue; }
      const r = recipients.get(part.recipient) || { hard: false, soft: 0, newSoft: 0 };
      r.hard ||= part.kind !== "transient";
      if (part.kind === "transient") {
        r.soft++;
        if (!f.bounces.some(b => dbIds.has(b.message_id) && b.normalized_email === part.recipient && b.kind === "transient")) r.newSoft++;
      }
      recipients.set(part.recipient, r);
    }
  }
  counts.distinctRecipients = recipients.size;
  for (const [email, r] of recipients) {
    if (f.suppressions.some(s => s.normalized_email === email && s.active !== false)) counts.alreadySuppressed++;
    else if (r.hard || new Set(f.bounces.filter(b => b.normalized_email === email && b.kind === "transient").map(b => b.message_id || b.id)).size + r.newSoft >= 3) counts.newSuppressionCandidates++;
    else counts.transientBelowThreshold++;
  }
  const needsReply = NEEDS_REPLY_NAMES.map(leadName => {
    const candidates = f.leads.filter(p => p.business_name === leadName);
    if (candidates.length !== 1) return { leadName, complete: false, reason: "lead_missing_or_ambiguous" };
    const p = candidates[0], db = f.messages.filter(m => owner(m, f.conversations) === p.id);
    const inbound = Math.max(0, ...db.filter(m => m.direction === "inbound" && !f.bounces.some(b => b.message_id === m.id)).map(m => stamp(m.received_at || m.sent_at)));
    const outbound = Math.max(0, ...db.filter(m => m.direction === "outbound").map(m => stamp(m.sent_at || m.received_at)));
    const matched = unique.filter(m => m.direction === "outbound" && m.match.id === p.id && m.bounceKind === "none");
    const exact = matched.filter(m => m.match.confidence === "exact_thread");
    const missing = exact.filter(m => !m.present);
    const reasons = { outside_old_30days: 0, outside_newest40: null as number | null, other_sent_folder: 0, thread_not_matched: 0, already_stored: 0, within_old_window_unexplained: 0 };
    for (const m of matched) {
      if (m.present) { reasons.already_stored++; continue; }
      if (m.match.confidence !== "exact_thread") reasons.thread_not_matched++;
      if (f.firstSync && m.internalTime && m.internalTime < f.firstSync - 31 * 86_400_000) reasons.outside_old_30days++;
      if (f.primarySent && m.occurrences.every((x: Row) => x.folder !== f.primarySent)) reasons.other_sent_folder++;
      // Historical newest-40 cannot be reconstructed from today's retained folder order.
      if (!f.firstSync || !m.internalTime || m.internalTime >= f.firstSync - 31 * 86_400_000) reasons.within_old_window_unexplained++;
    }
    const simulatedInbound = Math.max(inbound, ...unique.filter(m => m.direction === "inbound" && m.bounceKind === "none" && !m.autoReply && m.match.id === p.id && m.match.confidence === "exact_thread").map(m => m.when));
    const simulatedOutbound = Math.max(outbound, ...exact.map(m => m.when));
    const simulated = simulatedInbound ? simulatedOutbound > simulatedInbound ? "In_conversation_chronology_only" : "Needs_reply_chronology_only" : "unknown";
    return { leadName, complete: true, currentNeedsReplyByChronology: inbound > outbound, portalInbound: db.filter(m => m.direction === "inbound").length, portalOutbound: db.filter(m => m.direction === "outbound").length,
      portalImapOutbound: db.filter(m => m.direction === "outbound" && m.source === "imap").length,
      mailboxExactOutbound: exact.length, laterExactOutbound: exact.filter(m => m.when > inbound).length, missingExactOutbound: missing.length, laterMissingExactOutbound: missing.filter(m => m.when > inbound).length,
      weakCandidates: matched.length - exact.length, weakLaterCandidates: matched.filter(m => m.match.confidence !== "exact_thread" && m.when > inbound).length, weakMissingCandidates: matched.filter(m => m.match.confidence !== "exact_thread" && !m.present).length,
      reasons, old30DaysEvidence: f.firstSync ? "conservative_INTERNALDATE_sync_state_creation_proxy" : "first_sync_unavailable", otherSentFolderEvidence: "relative_to_current_LIST_primary_not_proven_historical_selection", newest40Evidence: "not_reconstructable_from_retained_mailbox", simulatedAfterExactFullImport: simulated, liveFixed: false };
  });
  const onwardId = f.leads.find(p => p.business_name === "OnwardBTC")?.id;
  const onwardChecks = ONWARD_CHECKS.map(date => {
    const found = unique.filter(m => m.direction === "outbound" && onwardId && m.match.id === onwardId && Math.floor((m.headerDate || 0) / 60_000) === Math.floor(stamp(date) / 60_000));
    return { leadName: "OnwardBTC", date, mailboxMatches: found.length, exactThreadMatches: found.filter(m => m.match.confidence === "exact_thread").length, portalPresent: found.filter(m => m.present).length, portalMissing: found.filter(m => !m.present).length, ambiguous: found.length > 1, dateMatchPrecision: "minute" };
  });
  const legacyCounts = { expectedExcerptCohort: 19, identifiedExcerptCohort: 0, mailboxFullBodyAvailable: 0, currentEqualsMailbox: 0, currentDiffersFromMailbox: 0, originalEqualsCurrent: 0, originalDiffersFromCurrent: 0, missingOrAmbiguous: 0, expectedNeedsMatchingCohort: 8, identifiedNeedsMatchingCohort: 0, nowMatched: 0 };
  for (const a of f.legacy) {
    const db = f.messages.filter(m => m.account_id === f.accountId && sameTuple(a, m));
    if (a.cohort === "excerpt") {
      legacyCounts.identifiedExcerptCohort++;
      const mail = f.mailbox.filter(m => sameTuple(a, m));
      if (mail.length === 1 && mail[0].bodyLength) legacyCounts.mailboxFullBodyAvailable++;
      if (db.length !== 1) { legacyCounts.missingOrAmbiguous++; continue; }
      const currentDigest = db[0].bodyDigest || digest(db[0].body_text || "");
      const currentLength = db[0].bodyLength ?? (db[0].body_text || "").length;
      if (digest(a.original_body || "") === currentDigest && (a.original_body || "").length === currentLength) legacyCounts.originalEqualsCurrent++; else legacyCounts.originalDiffersFromCurrent++;
      if (mail.length !== 1) { legacyCounts.missingOrAmbiguous++; continue; }
      if (currentDigest === mail[0].bodyDigest && currentLength === mail[0].bodyLength) legacyCounts.currentEqualsMailbox++; else legacyCounts.currentDiffersFromMailbox++;
    } else { legacyCounts.identifiedNeedsMatchingCohort++; if (db.length === 1 && owner(db[0], f.conversations) && db[0].conversation_id) legacyCounts.nowMatched++; }
  }
  const aliases = unique.filter(m => m.direction === "inbound" && m.bounceKind === "none" && !m.autoReply && !f.emails.some(e => e.normalized_email === m.from_email)).map((m, index) => {
    guard();
    const current = new Set(f.messages.filter(d => m.occurrences.some((x: Row) => stored(x, [d], f.accountId))).map(d => owner(d, f.conversations)).filter(Boolean));
    const domain = m.from_email.split("@")[1];
    const domainIds = /^(gmail|outlook|yahoo|hotmail|icloud|protonmail)\./i.test(domain || "") ? [] : f.leads.filter(p => p.domain_key === domain).map(p => p.id);
    const candidates = m.match.confidence === "exact_thread" ? [m.match.id] : [...new Set([...domainIds, ...m.signatureCandidates])];
    return { ordinal: index + 1, currentOwner: current.size === 1 ? name([...current][0]) : null, candidates: candidates.map((id: string) => name(id)).filter(Boolean), confidence: m.match.confidence === "exact_thread" ? "exact_thread" : candidates.length === 1 ? domainIds.length ? "domain_candidate_only" : "signature_name_candidate_only" : candidates.length ? "ambiguous_candidate" : "no_candidate", threadMatched: current.size === 1, linked: false };
  });
  return { scannedOccurrences: f.mailbox.length, uniqueMessages: unique.length, ambiguousMessages: unique.filter(m => m.match.ambiguous).length,
    unattributedOutbound: unique.filter(m => m.direction === "outbound" && !m.match.id).length,
    bounces: counts, needsReply, onwardChecks, legacy: legacyCounts, alternateAddressCandidates: aliases };
}
