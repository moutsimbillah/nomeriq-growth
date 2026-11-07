import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
const session = vi.hoisted(() => ({ role: "founder" as string | null, id: "" }));
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth/session")>();
  const { AppError } = await import("@/lib/utils");
  const user = () => {
    if (!session.role) throw new AppError("Sign in.", 401, "unauthorized");
    return { id: session.id, role: session.role as "founder", email: "fixture@example.test", name: "Fixture" };
  };
  return { ...original, requireApiUser: async () => user(), requireFounder: async () => { const value = user(); original.assertFounder(value); return value; } };
});
import { GET, POST } from "@/app/api/email/accounts/[id]/bounces/route";
import { closeDb, getDb, type DbClient } from "@/lib/db/client";
import { parseBounceReports, parseBounce, getParsedBounceInput, isAutoReply } from "@/lib/email/bounces";
import { applyHistoricalBounces, previewHistoricalBounces, recordBounceIfAny, countPriorSoftBounces, getAddressDeliveryStatuses, bounceRateForAccount, pauseProfileIfBouncing } from "@/lib/email/bounce-handling";
import { addSuppression } from "@/lib/services/suppressions";
import { simpleParser } from "mailparser";

let db: DbClient;
let hadSettings = false;
const accountId = crypto.randomUUID(), userId = crypto.randomUUID(), prospectId = crypto.randomUUID();
const tag = `recovery-${crypto.randomUUID()}`;
const email = (label: string) => `${label}-${tag}@example.test`;
const dsn = (recipient: string, code = "5.1.1") => `Final-Recipient: rfc822; ${recipient}\nAction: ${code.startsWith("4") ? "delayed" : "failed"}\nStatus: ${code}`;
const mail = (bodyText: string) => ({ accountId, messageDbId: null as string | null, fromEmail: "mailer-daemon@example.test", subject: "Delivery failure", bodyText });
async function stored(bodyText: string, subject = "Delivery failure", raw: object = {}) {
  const id = crypto.randomUUID();
  await db.query(`INSERT INTO messages (id,account_id,prospect_id,direction,source,from_email,subject,body_text,received_at,raw_headers)
    VALUES ($1,$2,$3,'inbound','imap','mailer-daemon@example.test',$4,$5,'2026-10-17T23:25:00Z',$6::jsonb)`, [id, accountId, prospectId, subject, bodyText, JSON.stringify(raw)]);
  return { ...mail(bodyText), messageDbId: id, subject };
}
beforeAll(async () => {
  db = await getDb();
  hadSettings = (await db.query(`SELECT 1 FROM workspace_settings WHERE id = 'default'`)).rows.length > 0;
  await db.query(`INSERT INTO email_accounts (id,name,provider,email_address,normalized_email,from_name,status,smtp_host,imap_host,username,password_encrypted,is_default)
    VALUES ($1,$2,'smtp_imap',$3,$3,'Recovery','connected','smtp.example.test','imap.example.test','fixture','x',false)`, [accountId, tag, email("sender")]);
  await db.query(`INSERT INTO users (id,email,normalized_email,name,password_hash,role) VALUES ($1,$2,$2,'Recovery fixture',$3,'founder')`, [userId, email("user"), crypto.randomUUID()]);
  await db.query(`INSERT INTO prospects (id,business_name,name_key) VALUES ($1,$2,$2)`, [prospectId, tag]);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await db.query(`DELETE FROM email_bounces WHERE normalized_email LIKE $1`, [`%${tag}%`]);
  await db.query(`DELETE FROM suppressions WHERE normalized_email LIKE $1`, [`%${tag}%`]);
  await db.query(`DELETE FROM audit_log WHERE actor_id = $1`, [userId]);
  await db.query(`DELETE FROM outbound_sends WHERE account_id = $1`, [accountId]);
  await db.query(`DELETE FROM messages WHERE account_id = $1`, [accountId]);
  await db.query(`DELETE FROM prospects WHERE id = $1`, [prospectId]);
  await db.query(`DELETE FROM email_accounts WHERE id = $1`, [accountId]);
  await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
  if (!hadSettings) await db.query(`DELETE FROM workspace_settings WHERE id = 'default'`);
  await closeDb();
});

describe("recipient-safe delivery report parser", () => {
  it("handles recipient blocks independently and preserves the single-report wrapper", () => {
    const input = mail(`${dsn(email("hard"))}\n\n${dsn(email("soft"), "4.2.2")}`);
    expect(parseBounceReports(input).map((r) => [r.recipient, r.kind])).toEqual([[email("hard"), "permanent"], [email("soft"), "transient"]]);
    expect(parseBounce(input)).toEqual(parseBounceReports(input)[0]);
  });
  it("does not treat OOO quoted failures or a human complaint subject as bounces", () => {
    expect(parseBounceReports({ ...mail(dsn(email("quoted"))), subject: "Out of office: delivery failure", headers: { "auto-submitted": "auto-replied" } })).toEqual([]);
    expect(parseBounceReports({ ...mail("I have a complaint"), fromEmail: "human@example.test", subject: "Abuse report" })).toEqual([]);
  });
  it("extracts DSN attachments and auto-submitted headers from actual MIME", async () => {
    const parsed = await simpleParser(`From: mailer-daemon@example.test\r\nSubject: Out of office\r\nAuto-Submitted: auto-generated\r\nContent-Type: multipart/report; report-type=delivery-status; boundary=report\r\n\r\n--report\r\nContent-Type: text/plain\r\n\r\nDelivery failed\r\n--report\r\nContent-Type: message/delivery-status\r\n\r\n${dsn(email("mime"))}\r\n--report--`);
    expect(isAutoReply(parsed)).toBe(true);
    expect(parseBounceReports(getParsedBounceInput(parsed))[0]).toMatchObject({ recipient: email("mime"), kind: "permanent" });
  });
});
describe("atomic receipt handling on real PGlite", () => {
  it("serializes concurrent copies; replay cannot create suppression after it is removed", async () => {
    const input = await stored(dsn(email("repeat")));
    const results = await Promise.all([recordBounceIfAny(input), recordBounceIfAny(input), recordBounceIfAny(input)]);
    expect(results.reduce((n, r) => n + (r.recorded ?? 0), 0)).toBe(1);
    expect(results.reduce((n, r) => n + (r.replayed ?? 0), 0)).toBe(2);
    const before = await db.query(`SELECT * FROM email_bounces WHERE message_id = $1`, [input.messageDbId]);
    await db.query(`DELETE FROM suppressions WHERE normalized_email = $1`, [email("repeat")]);
    expect(await recordBounceIfAny(input)).toMatchObject({ replayed: 1, recorded: 0, pausedProfile: false });
    expect((await db.query(`SELECT * FROM email_bounces WHERE message_id = $1`, [input.messageDbId])).rows).toEqual(before.rows);
    expect((await db.query(`SELECT 1 FROM suppressions WHERE normalized_email = $1`, [email("repeat")])).rows).toHaveLength(0);
  });
  it("counts distinct soft reports not copies, including legacy duplicates and null identity", async () => {
    const address = email("soft3");
    const first = await stored(dsn(address, "4.2.2"));
    expect(await recordBounceIfAny(first)).toMatchObject({ action: "retried", recorded: 1 });
    await db.query(`INSERT INTO email_bounces (account_id,message_id,normalized_email,kind,action) VALUES ($1,$2,$3,'transient','retried'),($1,NULL,$3,'transient','retried')`, [accountId, first.messageDbId, address]);
    expect(await countPriorSoftBounces(address)).toBe(1);
    expect(await recordBounceIfAny(await stored(dsn(address, "4.2.2")))).toMatchObject({ action: "retried" });
    expect(await recordBounceIfAny(await stored(dsn(address, "4.2.2")))).toMatchObject({ action: "suppressed" });
    expect(await countPriorSoftBounces(address)).toBe(3);
  });
  it("serializes three distinct concurrent soft reports with only the third suppressing", async () => {
    const address = email("parallel-soft");
    const inputs = await Promise.all([stored(dsn(address, "4.2.2")), stored(dsn(address, "4.2.2")), stored(dsn(address, "4.2.2"))]);
    const results = await Promise.all(inputs.map(recordBounceIfAny));
    expect(results.filter((r) => r.action === "retried")).toHaveLength(2);
    expect(results.filter((r) => r.action === "suppressed")).toHaveLength(1);
    expect(await countPriorSoftBounces(address)).toBe(3);
  });
  it("leaves missing recipients and nonpersistent identities recognized but unprocessed", async () => {
    expect(await recordBounceIfAny(await stored("Unknown delivery failure"))).toMatchObject({ isBounce: true, unprocessed: 1, recorded: 0 });
    expect(await recordBounceIfAny(mail(dsn(email("noid"))))).toMatchObject({ isBounce: true, unprocessed: 1, recorded: 0, action: null });
    expect((await db.query(`SELECT 1 FROM suppressions WHERE normalized_email = $1`, [email("noid")])).rows).toHaveLength(0);
  });
  it("keeps handler failure recognized instead of falling through as human reply", async () => {
    const input = await stored(dsn(email("failed")));
    vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("fixture transaction failure"));
    expect(await recordBounceIfAny(input)).toMatchObject({ isBounce: true, failed: true, recorded: 0 });
  });
  it("records all recipients and preserves optout/manual reasons and dates without lead-wide bounce holds", async () => {
    for (const reason of ["unsubscribe", "opt_out", "complaint", "manual"] as const) {
      const address = email(reason);
      await db.query(`INSERT INTO suppressions (id,email,normalized_email,reason,source,created_at,updated_at) VALUES ($1,$2,$2,$3,'founder','2026-01-01Z','2026-01-01Z')`, [crypto.randomUUID(), address, reason]);
      const before = (await db.query(`SELECT * FROM suppressions WHERE normalized_email = $1`, [address])).rows;
      await recordBounceIfAny(await stored(dsn(address)));
      expect((await db.query(`SELECT * FROM suppressions WHERE normalized_email = $1`, [address])).rows).toEqual(before);
    }
    const address = email("address-only");
    await db.query(`INSERT INTO prospect_emails (id,prospect_id,email,normalized_email,source_url) VALUES ($1,$2,$3,$3,'https://example.test/contact')`, [crypto.randomUUID(), prospectId, address]);
    await addSuppression({ email: address, reason: "bounce", userId });
    expect((await db.query<{ do_not_contact: boolean }>(`SELECT do_not_contact FROM prospects WHERE id = $1`, [prospectId])).rows[0].do_not_contact).toBe(false);
    expect(await recordBounceIfAny(await stored(`${dsn(address)}\n\n${dsn(email("multi-soft"), "4.2.2")}`))).toMatchObject({ recorded: 2, pausedProfile: false });
    expect(await getAddressDeliveryStatuses(prospectId)).toContainEqual(expect.objectContaining({ normalizedEmail: address, status: "permanent_bounced", occurredAt: "2026-10-17T23:25:00.000Z" }));
  });
});
describe("manual historical recovery", () => {
  it("does not pause from historical/address-only evidence; requires dated reports after actual sends", async () => {
    const reports = await Promise.all([stored(dsn(email("rate-0"))), stored(dsn(email("rate-1")))]);
    for (let i = 0; i < 50; i++) await db.query(`INSERT INTO outbound_sends (id,account_id,idempotency_key,status,recipient_email,completed_at) VALUES ($1,$2,$3,'accepted',$4,'2026-10-18Z')`, [crypto.randomUUID(), accountId, `${tag}-rate-${i}`, email(`rate-${i}`)]);
    for (const input of reports) expect(await recordBounceIfAny(input)).toMatchObject({ recorded: 1, pausedProfile: false });
    expect(await bounceRateForAccount(accountId)).toMatchObject({ sends: 50, bounces: 0, exceeded: false });
    expect(await pauseProfileIfBouncing(accountId)).toBe(false);
    await db.query(`UPDATE messages SET received_at = '2026-10-19Z' WHERE id = ANY($1::uuid[])`, [reports.map((r) => r.messageDbId)]);
    expect(await bounceRateForAccount(accountId)).toMatchObject({ sends: 50, bounces: 2, exceeded: true });
    expect(await pauseProfileIfBouncing(accountId)).toBe(true);
    expect((await db.query<{ status: string }>(`SELECT status FROM email_accounts WHERE id = $1`, [accountId])).rows[0].status).toBe("paused_bounce");
  });
  const context = { params: Promise.resolve({ id: accountId }) };
  const origin = "http://localhost:3100";
  const post = (body: unknown, requestOrigin = origin) => new Request(`${origin}/api/email/accounts/${accountId}/bounces`, { method: "POST", headers: { origin: requestOrigin, "content-type": "application/json" }, body: JSON.stringify(body) });
  it("authenticates preview and refuses admin/cross-origin/unconfirmed apply before any writes", async () => {
    session.id = userId;
    session.role = null;
    expect((await GET(new Request(origin), context)).status).toBe(401);
    session.role = "member";
    expect((await GET(new Request(origin), context)).status).toBe(200);
    const before = (await db.query(`SELECT * FROM email_bounces WHERE account_id = $1 ORDER BY id`, [accountId])).rows;
    session.role = "admin";
    expect((await POST(post({ confirmation: "APPLY HISTORICAL BOUNCES" }), context)).status).toBe(403);
    session.role = "founder";
    expect((await POST(post({ confirmation: "APPLY HISTORICAL BOUNCES" }, "https://other.example.test"), context)).status).toBe(403);
    expect((await POST(post({ confirmation: "no" }), context)).status).toBe(400);
    expect((await POST(post({ confirmation: "APPLY HISTORICAL BOUNCES", send: true }), context)).status).toBe(400);
    expect((await db.query(`SELECT * FROM email_bounces WHERE account_id = $1 ORDER BY id`, [accountId])).rows).toEqual(before);
  });
  it("preview issues SELECT only, uses raw metadata, and reports incomplete history without guessing", async () => {
    await stored("Delivery failed", "Delivery failure", { bounceInput: { bodyText: dsn(email("history")), contentType: "multipart/report; report-type=delivery-status", headers: {} } });
    await stored("Delivery failed", "Delivery failure", { "x-failed-recipients": email("incomplete") });
    await stored(`${dsn(email("history-multi-hard"))}\n\nFinal-Recipient: rfc822; ${email("history-multi-incomplete")}`);
    await stored("Fields unavailable", "Legacy machine report", { deliveryReport: true });
    const spy = vi.spyOn(db, "query");
    const result = await previewHistoricalBounces(accountId);
    expect(result.wouldNewlySuppress).toBeGreaterThanOrEqual(1);
    expect(result.incomplete).toBeGreaterThanOrEqual(3);
    expect(result.leads).toContain(tag);
    expect(spy.mock.calls.every(([sql]) => /^\s*SELECT\b/i.test(sql))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(email("history"));
  });
  it("requires explicit founder confirmation and repeated apply replays instead of adding facts", async () => {
    await expect(applyHistoricalBounces({ accountId, founderUserId: userId, confirmation: "" })).rejects.toMatchObject({ code: "confirmation_required" });
    await expect(applyHistoricalBounces({ accountId, founderUserId: crypto.randomUUID(), confirmation: "APPLY HISTORICAL BOUNCES" })).rejects.toMatchObject({ code: "forbidden" });
    const result = await applyHistoricalBounces({ accountId, founderUserId: userId, confirmation: "APPLY HISTORICAL BOUNCES" });
    expect(result.recorded).toBeGreaterThanOrEqual(1);
    expect(await applyHistoricalBounces({ accountId, founderUserId: userId, confirmation: "APPLY HISTORICAL BOUNCES" })).toMatchObject({ recorded: 0 });
    expect((await db.query(`SELECT 1 FROM suppressions WHERE normalized_email = $1`, [email("incomplete")])).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM email_bounces WHERE normalized_email = $1`, [email("history-multi-incomplete")])).rows).toHaveLength(0);
  });
});
