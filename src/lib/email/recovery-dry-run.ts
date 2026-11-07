import { inspectWithClients, type AuditDb, type ReadOnlyImap } from "../../../scripts/inspect-mailbox";
import { LIMITS, safeName, type Facts, type Row } from "./mailbox-inspector";
import { matchRecoveryOwner, type RecoveryLookups } from "./recovery-matching";

const EXCERPT = "excerpt only, full body pending mailbox sync";
function counters() {
  return { scanned: 0, wouldImport: 0, wouldSkipDuplicate: 0, persistedDuplicates: 0, withinRunDuplicates: 0, wouldHydrate: 0, wouldRematch: 0, founderVetoes: 0, identityConflicts: 0 };
}
/** Ordered shadow simulation, not a fixed-point inference over future messages. No fact mutation. */
export async function analyzeRecoveryFacts(f: Facts): Promise<Row> {
  const messages: Row[] = f.messages.map(m => ({ ...m, shadow: false }));
  const totals = counters(), perFolder: Row[] = [], perLead = new Map<string, ReturnType<typeof counters>>();
  const threads = new Map<string, { leadName: string; matched: number; threadHeaders: number; uniqueAddressSubject: number }>();
  const errors: string[] = [];
  if (f.inventoryFolders && !["Sent Items", "INBOX"].every(path => f.inventoryFolders!.includes(path))) errors.push("required_recovery_folder_missing");
  const deadline = Date.now() + LIMITS.analysisTimeoutMs;
  let steps = 0;
  const guard = () => { if (++steps > LIMITS.maxAnalysisSteps || Date.now() > deadline) throw new Error("recovery_analysis_resource_limit"); };
  const lookup: RecoveryLookups = {
    async threads(ids) {
      const out: { prospectId: string; conversationId: string }[] = [];
      for (const m of messages) { guard();
        if (!ids.includes(m.message_id)) continue;
        const c = f.conversations.find(c => c.id === m.conversation_id);
        if (c?.prospect_id && (!m.prospect_id || m.prospect_id === c.prospect_id)) out.push({ prospectId: c.prospect_id, conversationId: c.id });
      }
      return out;
    },
    async prospects(emails) {
      return f.emails.filter(e => { guard(); return emails.includes(e.normalized_email) && f.leads.some(p => p.id === e.prospect_id && !p.archived_at); }).map(e => e.prospect_id);
    },
    async conversations(id) { return f.conversations.filter(c => c.prospect_id === id).map(c => ({ id: c.id, subject: c.subject || "" })); },
  };
  const match = (m: Row) => matchRecoveryOwner({ direction: m.direction, fromEmail: m.from_email || "", toEmails: m.recoveryToEmails ?? m.to_emails ?? [],
    inReplyTo: m.in_reply_to || null, references: m.references_json || [], subject: m.subject || "(no subject)" }, lookup);
  try {
    for (const folder of ["Sent Items", "INBOX"]) {
      const count = counters(); perFolder.push({ folder, ...count });
      const folderReport = perFolder[perFolder.length - 1];
      // The writer processes retained UIDs ascending, Sent Items before INBOX.
      for (const retained of f.mailbox.filter(m => m.folder === folder).sort((a, b) => Number(a.uid) - Number(b.uid))) {
        const m: Row = { ...retained, bodyBlank: retained.recoveryBodyBlank ?? retained.bodyBlank,
          bodyLength: retained.recoveryBodyLength ?? retained.bodyLength, bodyDigest: retained.recoveryBodyDigest ?? retained.bodyDigest };
        guard();
        const event = counters(); event.scanned = 1;
        if (folder === "Sent Items" && f.recoveryAccountEmail && (m.recoveryFromCount !== 1 || m.from_email !== f.recoveryAccountEmail.trim().toLowerCase())) {
          errors.push("sent_sender_not_account");
          break;
        }
        const duplicate = messages.filter(d => { guard(); return d.account_id === f.accountId && ((m.message_id && d.message_id === m.message_id) ||
          (d.folder === m.folder && d.uid != null && String(d.uid) === String(m.uid) && d.uidvalidity != null && String(d.uidvalidity) === String(m.uidvalidity))); });
        if (duplicate.length > 1) {
          event.identityConflicts = 1;
          for (const key of Object.keys(event) as (keyof typeof event)[]) { totals[key] += event[key]; folderReport[key] += event[key]; }
          errors.push("message_identity_conflict");
          break;
        }
        let row = duplicate[0];
        let matchedBy = "existing_owner";
        if (row) {
          event.wouldSkipDuplicate = 1;
          if (row.shadow) event.withinRunDuplicates = 1; else event.persistedDuplicates = 1;
          if (!row.prospect_id && !row.conversation_id && !m.deliveryReport && m.bounceKind === "none" && !m.autoReply) {
            const found = await match(m);
            if (found.prospectId) {
              const veto = f.auditDecisions?.find(a => a.entity_id === row.id && a.prospect_id === found.prospectId);
              if (veto && veto.action !== "message.linked") event.founderVetoes = 1;
              else { row.prospect_id = found.prospectId; row.conversation_id = found.conversationId; event.wouldRematch = 1; matchedBy = found.matchedBy; }
            }
          }
          const blank = row.bodyBlank ?? (typeof row.body_text === "string" ? !row.body_text.trim() : !(row.bodyLength || 0));
          if (!m.bodyBlank && m.bodyLength > 0 && (blank || row.error === EXCERPT)) {
            event.wouldHydrate = 1; row.bodyBlank = false; row.bodyLength = m.bodyLength; row.bodyDigest = m.bodyDigest; row.error = null;
          }
        } else {
          const found = await match(m); matchedBy = found.matchedBy;
          row = { ...m, id: `shadow-${messages.length}`, account_id: f.accountId, prospect_id: found.prospectId, conversation_id: found.conversationId, shadow: true };
          messages.push(row); event.wouldImport = 1;
        }
        const prospectId = row.prospect_id || f.conversations.find(c => c.id === row.conversation_id)?.prospect_id;
        const leadName = safeName(f.leads.find(p => p.id === prospectId)?.business_name) || "Unmatched";
        const lead = perLead.get(leadName) || counters(); perLead.set(leadName, lead);
        for (const key of Object.keys(event) as (keyof typeof event)[]) { totals[key] += event[key]; folderReport[key] += event[key]; lead[key] += event[key]; }
        if (row.conversation_id) {
          const thread = threads.get(row.conversation_id) || { leadName, matched: 0, threadHeaders: 0, uniqueAddressSubject: 0 };
          thread.matched++; if (matchedBy === "thread_headers") thread.threadHeaders++; if (matchedBy === "unique_address_subject") thread.uniqueAddressSubject++;
          threads.set(row.conversation_id, thread);
        }
      }
      if (errors.length) break;
    }
  } catch { errors.push("recovery_analysis_resource_limit"); }
  return { complete: !errors.length, errors, ...totals, perFolder,
    perLead: [...perLead].map(([leadName, counts]) => ({ leadName, ...counts })).sort((a, b) => a.leadName.localeCompare(b.leadName)),
    threads: [...threads.values()].sort((a, b) => a.leadName.localeCompare(b.leadName)),
    inventoryOnlyOccurrences: f.mailbox.filter(m => !["Sent Items", "INBOX"].includes(m.folder)).length,
    policy: "Sent Items then INBOX, ascending UID; existing conversations only; no address linking" };
}
/** CLI entry: raw PG READ ONLY + EXAMINE/PEEK via the reviewed inspector. */
export async function runRecoveryDryRun(db: AuditDb, createImap: (account: Row) => ReadOnlyImap): Promise<Row> {
  const report = await inspectWithClients(db, createImap, undefined, { analyzeFacts: analyzeRecoveryFacts });
  if (!report.recovery) report.recovery = { complete: false, errors: ["recovery_analysis_unavailable"], perFolder: [], perLead: [], threads: [] };
  if (!report.complete) {
    report.recovery.complete = false;
    if (!report.recovery.errors.length) report.recovery.errors.push("inspection_incomplete");
  }
  return report;
}
