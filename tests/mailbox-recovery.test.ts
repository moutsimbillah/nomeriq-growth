import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { simpleParser } from "mailparser";
import { getDb } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { storeParsedMessage, syncEmailAccount, type SyncOptions } from "@/lib/email/sync";
import { recomputeConversationChronology } from "@/lib/email/conversation-chronology";
import { getFolderInbox } from "@/lib/services/inbox";

const fake = vi.hoisted(() => ({
  account: {} as Record<string, unknown>, folder: "", failUid: 0, uidValidity: 17,
  mail: new Map<string, Map<number, string>>(), opens: [] as unknown[][], searches: [] as unknown[],
  translate: vi.fn(), bounce: vi.fn(async () => ({ isBounce: false })),
  pause: vi.fn(async () => false), copies: vi.fn(async () => []), append: vi.fn(),
}));
vi.mock("@/lib/email/accounts", () => ({ getEmailAccountRecord: async () => fake.account }));
vi.mock("@/lib/auth/crypto", () => ({ decryptSecret: () => crypto.randomUUID() }));
vi.mock("@/lib/services/message-translations", () => ({ translateOnArrival: fake.translate }));
vi.mock("@/lib/email/bounce-handling", () => ({ recordBounceIfAny: fake.bounce, pauseProfileIfBouncing: fake.pause }));
vi.mock("@/lib/email/sent-copy", () => ({ listUncopiedSentMessages: fake.copies, saveSentCopyForMessage: fake.append }));
vi.mock("imapflow", () => ({ ImapFlow: class {
  async connect() {}
  async logout() {}
  async list() { return [{ path: "INBOX" }, { path: "Sent Items", specialUse: "\\Sent" }, { path: "Sent Archive" }]; }
  async mailboxOpen(path: string, options: unknown) {
    fake.folder = path; fake.opens.push([path, options]); return { uidValidity: fake.uidValidity };
  }
  async search(query: { uid?: string; since?: Date }) {
    fake.searches.push(query);
    const after = query.uid ? Number(query.uid.split(":")[0]) : 0;
    return [...(fake.mail.get(fake.folder)?.keys() ?? [])].filter(uid => uid >= after).reverse();
  }
  async *fetch(uidText: string) {
    const uid = Number(uidText);
    if (fake.failUid === uid) throw new Error("synthetic fetch failure");
    const source = fake.mail.get(fake.folder)?.get(uid);
    if (source) yield { uid, source: Buffer.from(source), flags: new Set(["\\Seen"]), internalDate: new Date("2026-10-24T09:47:00Z") };
  }
} }));

const marker = crypto.randomUUID();
const accountId = crypto.randomUUID();
const userId = crypto.randomUUID();
const prospectId = crypto.randomUUID();
const conversationId = crypto.randomUUID();
const otherProspect = crypto.randomUUID();
const otherConversation = crypto.randomUUID();
const seedMessage = `<seed-${marker}@example.test>`;
function mime(uid: number, date: string, extra = "", body = "Our complete reply from webmail.") {
  return `From: Founder <founder@recovery.example>\r\nTo: contact@onward.example\r\nSubject: Re: OnwardBTC discussion\r\nMessage-ID: <recovery-${marker}-${uid}@example.test>\r\nIn-Reply-To: ${seedMessage}\r\nDate: ${new Date(date).toUTCString()}\r\n${extra}\r\n${body}`;
}
async function direct(raw: string, uid: number, direction: "inbound" | "outbound" = "outbound",
  options: SyncOptions = { mode: "backfill", founderUserId: userId }) {
  return storeParsedMessage({ parsed: await simpleParser(raw), account: fake.account as never,
    direction, folderPath: direction === "outbound" ? "Sent Items" : "INBOX", folderLabel: direction === "outbound" ? "Sent" : "INBOX",
    uid, uidValidity: 17, isSeen: true, internalDate: null }, options);
}

beforeAll(async () => {
  const db = await getDb();
  await db.query(`INSERT INTO users(id,email,normalized_email,name,password_hash,role)
    VALUES ($1,$2,$2,'Recovery fixture',$3,'founder')`, [userId, `${marker}@example.test`, hashPassword(crypto.randomUUID())]);
  await db.query(`INSERT INTO email_accounts(id,name,provider,email_address,normalized_email,from_name,created_by)
    VALUES ($1,'Recovery fixture','sandbox',$3,$3,'Founder',$2)`, [accountId, userId, `${marker}@recovery.example`]);
  for (const [id, name] of [[prospectId, "OnwardBTC"], [otherProspect, "Other fixture"]]) {
    await db.query(`INSERT INTO prospects(id,business_name,name_key,created_by_type) VALUES ($1,$2,$3,'founder')`, [id, name, `${marker}-${name}`]);
  }
  await db.query(`INSERT INTO prospect_emails(id,prospect_id,email,normalized_email,source_url,source_type)
    VALUES ($1,$2,'contact@onward.example','contact@onward.example','https://onward.example','official_website')`, [crypto.randomUUID(), prospectId]);
  for (const [id, owner] of [[conversationId, prospectId], [otherConversation, otherProspect]]) {
    await db.query(`INSERT INTO conversations(id,prospect_id,subject,status) VALUES ($1,$2,'OnwardBTC discussion','replied')`, [id, owner]);
  }
  await db.query(`INSERT INTO messages(id,account_id,prospect_id,conversation_id,message_id,direction,from_email,body_text,received_at)
    VALUES ($1,$2,$3,$4,$5,'inbound','contact@onward.example','Please share more details','2026-10-10T09:00:00Z')`,
    [crypto.randomUUID(), accountId, prospectId, conversationId, seedMessage]);
  await db.query(`INSERT INTO mailbox_sync_state(id,account_id,folder,uidvalidity,last_uid,history_complete)
    VALUES ($1,$2,'Sent',17,2000,false)`, [crypto.randomUUID(), accountId]);
  fake.account = { id: accountId, provider: "ionos", status: "connected", emailAddress: "founder@recovery.example",
    fromName: "Founder", imapHost: "invalid.example.test", imapPort: 993, imapSecure: true,
    username: crypto.randomUUID(), passwordEncrypted: crypto.randomUUID() };
  const sent = new Map<number, string>();
  sent.set(1, mime(1, "2026-10-17T19:25:00-04:00"));
  sent.set(2, mime(2, "2026-10-24T05:47:00-04:00"));
  for (let uid = 3; uid <= 153; uid++) sent.set(uid, mime(uid, "2026-11-05T10:00:00Z")
    .replace(`In-Reply-To: ${seedMessage}\r\n`, "")
    .replace("contact@onward.example", "unrelated@newer.example")
    .replace("Re: OnwardBTC discussion", "Unrelated newer mail"));
  fake.mail = new Map([["INBOX", new Map()], ["Sent Items", sent], ["Sent Archive", new Map([[1, mime(1, "2026-10-17T19:25:00-04:00")]])]]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
afterAll(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM messages WHERE account_id = $1`, [accountId]);
  await db.query(`DELETE FROM prospects WHERE id = ANY($1::uuid[])`, [[prospectId, otherProspect]]);
  await db.query(`DELETE FROM email_accounts WHERE id = $1`, [accountId]);
  await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
  vi.restoreAllMocks();
});

describe("explicit import-only mailbox recovery", () => {
  it("requires explicit founder mode; ordinary incremental never starts recovery", async () => {
    await expect(syncEmailAccount(accountId, { mode: "backfill" })).rejects.toMatchObject({ code: "founder_required" });
    await expect(syncEmailAccount(accountId, { processHistoricalBounces: true })).rejects.toMatchObject({ code: "backfill_required" });
    const result = await syncEmailAccount(accountId);
    expect(result.mode).toBe("incremental");
    expect(result.progress).toEqual([]);
    expect((await getDb()).query).toBeDefined();
    fake.translate.mockClear(); fake.bounce.mockClear(); fake.copies.mockClear(); fake.pause.mockClear();
  });
  it("recovers both exact OnwardBTC timestamps beyond lookback and newest-40, then resumes after failure without false completion", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-12-20T12:00:00Z"));
    // Founder acceptance: before recovery their message is the latest, so the lead needs a reply.
    expect((await getFolderInbox({ focus: prospectId })).focused?.folder).toBe("needs_reply");
    const first = await syncEmailAccount(accountId, { mode: "backfill", founderUserId: userId });
    expect(first.errors).toEqual([]);
    expect(first.progress?.find(row => row.folder === "Sent Items")).toMatchObject({ lastUid: 100, remaining: 53, complete: false });
    expect(first.historyIncomplete).toBe(true);
    const db = await getDb();
    const examples = await db.query<{ sent_at: string; external: boolean; conversation_id: string }>(
      `SELECT sent_at,external,conversation_id FROM messages WHERE account_id=$1 AND uid IN (1,2) ORDER BY uid`, [accountId]);
    expect(examples.rows.map(row => new Date(row.sent_at).toISOString())).toEqual(["2026-10-17T23:25:00.000Z", "2026-10-24T09:47:00.000Z"]);
    expect(examples.rows.every(row => row.external && row.conversation_id === conversationId)).toBe(true);
    const onward = await db.query<{ status: string; last_outbound_at: string }>(`SELECT status,last_outbound_at FROM conversations WHERE id=$1`, [conversationId]);
    expect(onward.rows[0].status).toBe("waiting");
    expect(new Date(onward.rows[0].last_outbound_at).toISOString()).toBe("2026-10-24T09:47:00.000Z");
    // Morning founder rule: a lead who ever replied belongs In conversation after our answer.
    expect((await getFolderInbox({ focus: prospectId })).focused?.folder).toBe("in_conversation");
    fake.failUid = 105;
    const failed = await syncEmailAccount(accountId, { mode: "backfill", founderUserId: userId });
    expect(failed.historyIncomplete).toBe(true);
    expect(failed.progress?.find(row => row.folder === "Sent Items")).toMatchObject({ lastUid: 104, complete: false });
    expect(failed.errors).toHaveLength(1);
    fake.failUid = 0;
    const resumed = await syncEmailAccount(accountId, { mode: "backfill", founderUserId: userId });
    expect(resumed.historyIncomplete).toBe(false);
    expect(resumed.progress?.every(row => row.complete)).toBe(true);
    expect((await syncEmailAccount(accountId, { mode: "backfill", founderUserId: userId })).imported).toBe(0);
    const total = await db.query<{ n: number }>(`SELECT count(*)::int n FROM messages WHERE account_id=$1 AND source='imap' AND direction='outbound'`, [accountId]);
    // The duplicate physical Sent folder did not create an extra copy.
    expect(total.rows[0].n).toBe(153);
    const live = await db.query<{ last_uid: number }>(`SELECT last_uid FROM mailbox_sync_state WHERE account_id=$1 AND folder='Sent'`, [accountId]);
    expect(Number(live.rows[0].last_uid)).toBe(2000);
    expect(fake.opens.every(([, options]) => (options as { readOnly: boolean }).readOnly)).toBe(true);
    expect(fake.translate).not.toHaveBeenCalled(); expect(fake.bounce).not.toHaveBeenCalled();
    expect(fake.copies).not.toHaveBeenCalled(); expect(fake.append).not.toHaveBeenCalled(); expect(fake.pause).not.toHaveBeenCalled();
  });
  it("fills only blank/error-marked excerpts, clears stale marker and preserves full bodies", async () => {
    const db = await getDb();
    await db.query(`UPDATE messages SET body_text='old excerpt',error='excerpt only, full body pending mailbox sync' WHERE account_id=$1 AND uid=1`, [accountId]);
    expect((await direct(mime(1, "2026-10-17T23:25:00Z", "", "Complete recovered body."), 1)).filled).toBe(true);
    expect((await direct(mime(1, "2026-10-17T23:25:00Z", "", "Do not overwrite complete body."), 1)).filled).toBe(false);
    const result = await db.query<{ body_text: string; error: string | null }>(`SELECT body_text,error FROM messages WHERE account_id=$1 AND uid=1`, [accountId]);
    expect(result.rows[0]).toEqual({ body_text: "Complete recovered body.", error: null });
  });
  it("DSNs remain delivery reports with no historical suppression or reply even if bounce handling fails", async () => {
    fake.bounce.mockRejectedValueOnce(new Error("synthetic handler failure") as never);
    const raw = mime(500, "2026-11-06T10:00:00Z", "Content-Type: multipart/report; report-type=delivery-status\r\n", "Final-Recipient: rfc822; dead@example.test\r\nStatus: 5.1.1\r\nAction: failed");
    await direct(raw, 500, "inbound");
    const db = await getDb();
    const message = await db.query<{ raw_headers: { deliveryReport: boolean; historicalBouncePending: boolean } }>(`SELECT raw_headers FROM messages WHERE account_id=$1 AND uid=500`, [accountId]);
    expect(message.rows[0].raw_headers).toMatchObject({ deliveryReport: true, historicalBouncePending: true });
    await db.transaction(tx => recomputeConversationChronology(tx, prospectId));
    const conv = await db.query<{ status: string; last_inbound_at: string }>(`SELECT status,last_inbound_at FROM conversations WHERE id=$1`, [conversationId]);
    expect(conv.rows[0].status).toBe("waiting");
    expect(new Date(conv.rows[0].last_inbound_at).toISOString()).toBe("2026-10-10T09:00:00.000Z");
    expect(fake.bounce).not.toHaveBeenCalled();
    // Current-ingest compatibility still checks bounces; a broken handler must never create a reply.
    await direct(raw.replace(`-${marker}-500@`, `-${marker}-505@`), 505, "inbound", {});
    expect(fake.bounce).toHaveBeenCalledTimes(1);
    const after = await db.query<{ status: string }>(`SELECT status FROM conversations WHERE id=$1`, [conversationId]);
    expect(after.rows[0].status).toBe("waiting");
    fake.bounce.mockReset(); fake.bounce.mockResolvedValue({ isBounce: false });
  });
  it("a genuine later inbound beats Sent chronology; replaying an older inbound cannot undo it", async () => {
    const later = mime(501, "2026-11-08T10:00:00Z", "", "Yes, a demo sounds good.").replace("From: Founder <founder@recovery.example>", "From: Contact <contact@onward.example>");
    await direct(later, 501, "inbound");
    await direct(later.replace("501@", "502@").replace("Sun, 08 Nov", "Sat, 07 Nov"), 502, "inbound");
    const db = await getDb();
    const conv = await db.query<{ status: string; last_inbound_at: string; last_outbound_at: string }>(`SELECT status,last_inbound_at,last_outbound_at FROM conversations WHERE id=$1`, [conversationId]);
    expect(conv.rows[0].status).toBe("replied");
    expect(new Date(conv.rows[0].last_inbound_at).toISOString()).toBe("2026-11-08T10:00:00.000Z");
    expect(new Date(conv.rows[0].last_outbound_at).toISOString()).toBe("2026-10-24T09:47:00.000Z");
  });
  it("uses unique exact address plus normalized subject, never domains or ambiguous references", async () => {
    const db = await getDb();
    const noHeader = mime(600, "2026-10-18T10:00:00Z").replace(`In-Reply-To: ${seedMessage}\r\n`, "");
    expect((await direct(noHeader, 600)).prospectId).toBe(prospectId);
    expect((await direct(noHeader.replace("-600@", "-601@").replace("Re: OnwardBTC discussion", "Unrelated question"), 601)).prospectId).toBeNull();
    await db.query(`UPDATE prospects SET domain_key='onward.example' WHERE id=$1`, [prospectId]);
    expect((await direct(noHeader.replace("-600@", "-602@").replace("contact@onward.example", "unknown@onward.example"), 602)).prospectId).toBeNull();
    const otherId = `<other-${marker}@example.test>`;
    await db.query(`INSERT INTO messages(id,account_id,prospect_id,conversation_id,message_id,direction,from_email,body_text,received_at)
      VALUES ($1,$2,$3,$4,$5,'inbound','other@example.test','Other thread','2026-10-01')`,
      [crypto.randomUUID(), accountId, otherProspect, otherConversation, otherId]);
    const ambiguous = mime(603, "2026-10-18T10:00:00Z", `References: ${otherId}\r\n`);
    expect((await direct(ambiguous, 603)).prospectId).toBeNull();
    // Multiple recipient owners also cannot be resolved by whichever address appeared first.
    await db.query(`INSERT INTO prospect_emails(id,prospect_id,email,normalized_email,source_url,source_type)
      VALUES ($1,$2,'other@other.example','other@other.example','https://other.example','official_website')`, [crypto.randomUUID(), otherProspect]);
    const multi = noHeader.replace("-600@", "-604@").replace("To: contact@onward.example", "To: contact@onward.example, other@other.example");
    expect((await direct(multi, 604)).prospectId).toBeNull();
  });
  it("retains manual classification and freshly prepared follow-ups on an older inbound replay", async () => {
    const db = await getDb();
    await db.query(`UPDATE conversations SET classification='technical',classification_source='founder' WHERE id=$1`, [conversationId]);
    const draftId = crypto.randomUUID();
    await db.query(`INSERT INTO drafts(id,prospect_id,kind,status,subject,body,recipient_email,created_at)
      VALUES ($1,$2,'follow_up','draft','Fixture','Fixture','contact@onward.example','2026-11-09T10:00:00Z')`, [draftId, prospectId]);
    await direct(mime(605, "2026-10-12T10:00:00Z", "", "Unsubscribe"), 605, "inbound");
    const draft = await db.query<{ status: string }>(`SELECT status FROM drafts WHERE id=$1`, [draftId]);
    expect(draft.rows[0].status).toBe("draft");
    const conv = await db.query<{ classification: string; last_inbound_at: string }>(`SELECT classification,last_inbound_at FROM conversations WHERE id=$1`, [conversationId]);
    expect(conv.rows[0].classification).toBe("technical");
    expect(new Date(conv.rows[0].last_inbound_at).toISOString()).toBe("2026-11-08T10:00:00.000Z");
    const suppressed = await db.query<{ n: number }>(`SELECT count(*)::int n FROM suppressions WHERE prospect_id=$1`, [prospectId]);
    expect(suppressed.rows[0].n).toBe(0);
    await db.query(`DELETE FROM drafts WHERE id=$1`, [draftId]);
  });
  it("an actual new outbound cancels the active follow-up and older inbound ingest cannot undo Waiting", async () => {
    const db = await getDb();
    const draftId = crypto.randomUUID();
    await db.query(`INSERT INTO drafts(id,prospect_id,kind,status,subject,body,recipient_email,created_at)
      VALUES ($1,$2,'follow_up','approved','Fixture','Fixture','contact@onward.example','2026-11-09T10:00:00Z')`, [draftId, prospectId]);
    await direct(mime(700, "2026-11-10T10:00:00Z"), 700, "outbound", {});
    expect((await db.query<{ status: string }>(`SELECT status FROM drafts WHERE id=$1`, [draftId])).rows[0].status).toBe("cancelled");
    await direct(mime(701, "2026-10-14T10:00:00Z", "", "Unsubscribe"), 701, "inbound", {});
    const conv = await db.query<{ status: string; last_outbound_at: string }>(`SELECT status,last_outbound_at FROM conversations WHERE id=$1`, [conversationId]);
    expect(conv.rows[0].status).toBe("waiting");
    expect(new Date(conv.rows[0].last_outbound_at).toISOString()).toBe("2026-11-10T10:00:00.000Z");
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM suppressions WHERE prospect_id=$1`, [prospectId])).rows[0].n).toBe(0);
    await db.query(`DELETE FROM drafts WHERE id=$1`, [draftId]);
  });
  it("UIDVALIDITY reset restarts the independent recovery cursor and Message-ID dedupe still holds", async () => {
    fake.uidValidity = 18;
    const result = await syncEmailAccount(accountId, { mode: "backfill", founderUserId: userId });
    expect(result.progress?.find(row => row.folder === "Sent Items")).toMatchObject({ uidValidity: 18, lastUid: 100, complete: false });
    expect(result.imported).toBe(0);
    expect(result.historyIncomplete).toBe(true);
    fake.uidValidity = 17;
  });
  it("preserves full HTML beyond the former truncation boundary and excludes auto replies from clocks", async () => {
    const html = `<p>${"a".repeat(510_000)}</p>`;
    await direct(mime(710, "2026-10-16T10:00:00Z", "Content-Type: text/html; charset=utf-8\r\n", html), 710);
    const db = await getDb();
    const stored = await db.query<{ body_html: string }>(`SELECT body_html FROM messages WHERE account_id=$1 AND uid=710`, [accountId]);
    expect(stored.rows[0].body_html.trim()).toBe(html);
    await direct(mime(711, "2026-11-11T10:00:00Z", "Auto-Submitted: auto-replied\r\n", "Out of office"), 711, "inbound");
    await db.transaction(tx => recomputeConversationChronology(tx, prospectId));
    const clock = await db.query<{ status: string; last_message_at: string }>(`SELECT status,last_message_at FROM conversations WHERE id=$1`, [conversationId]);
    expect(clock.rows[0].status).toBe("waiting");
    expect(new Date(clock.rows[0].last_message_at).toISOString()).toBe("2026-11-10T10:00:00.000Z");
  });
});
