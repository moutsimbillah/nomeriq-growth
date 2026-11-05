/**
 * Legacy gate — the portal's own send and draft functions, against the dry-run copy of the database.
 *
 * WHY THIS FILE EXISTS
 * The import put 578 leads, 431 sent first-contact drafts, 58 suppressions and 19 inbound replies into the
 * copy. A SQL query can restate what the gate *should* answer; only the application's own functions can
 * show what it *does* answer. So every probe below calls saveDraft / savePreparedFirstContactDraft /
 * sendDraft exactly as the interface and the campaign runner do, and nothing re-derives a verdict in SQL.
 *
 * THE TRANSPORT IS STUBBED AT THE BOUNDARY
 * `@/lib/email/send-provider` is replaced wholesale: any call to deliverEmail() increments a counter and
 * throws. Reaching the transport is the failure this test exists to catch, so the counter is asserted to be
 * zero after every batch — a send that was attempted fails the run even though the stub also prevents it.
 *
 * WHERE THE DATABASE COMES FROM — read this before changing it
 *   - tests/setup.ts empties DATABASE_URL and sets PGLITE_DIR, because most suites use the embedded
 *     database. This file overrides both in beforeAll: PGLITE_DIR is deleted, DATABASE_URL is set to the
 *     tunnelled copy (sslmode=require, on 127.0.0.1 — a loopback SSH forward to the server's Postgres).
 *     AUTO_MIGRATE is forced to "false": the copy already has its schema and this run must not write.
 *   - src/lib/db/client.ts would happily use that DATABASE_URL (it prefers it over PGlite), but its
 *     PgClient pools connections and its transaction() issues COMMIT, which would end the run's outer
 *     transaction and commit the probes. The app's DbClient interface is therefore served here by one
 *     pinned session: the same Postgres driver, the same ssl rule (sslmode=require → no CA verification),
 *     but every app-level transaction() becomes a SAVEPOINT. That is what makes the entire run a single
 *     transaction whose ROLLBACK is the proof that the copy was not written.
 *   - No credential is stored in this file. The connection string comes from LEGACY_GATE_DATABASE_URL and
 *     nothing here prints it.
 *
 * FIXTURES (all inside the transaction that is rolled back)
 *   The copy's only email account is `unverified` and its postal address is empty. Both are refusals that
 *   sit *after* the contact gate but *before* the transport, so leaving them in place would turn a broken
 *   already_contacted gate into a passing test — the draft would be stopped by something else. They are
 *   therefore set to permissive values inside the transaction, so the gate under test is the only thing
 *   between the draft and the transport. Where a probe needs a draft the import does not contain (a
 *   follow-up on a thread the prospect has already replied to), the row is inserted inside the same
 *   transaction; where a prospect may hold only one first-contact draft, the imported row is re-pointed
 *   for the probe and put back afterwards. Nothing is committed; the closing test proves it.
 *
 * NOTHING HERE PRINTS A RECORD VALUE. Counts, codes and table names only — never an address, a subject, a
 * body or a lead name.
 *
 * HOW TO RUN IT
 *   ssh -i <key> -N -L 127.0.0.1:15432:127.0.0.1:5432 ubuntu@<host>     # loopback only
 *   LEGACY_GATE_DATABASE_URL="postgresql://…@127.0.0.1:15432/growth_import_dryrun?sslmode=require" \
 *     npx vitest run tests/legacy-gate.test.ts --reporter=verbose
 * Without LEGACY_GATE_DATABASE_URL the file skips rather than passing quietly, so `npm test` stays green on
 * a machine with no tunnel. With it, `--reporter=verbose` prints the table; the assertions below are the
 * gate either way, and every count in the table is asserted.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";

import type { DbClient, QueryResult } from "@/lib/db/client";
import { AppError } from "@/lib/utils";
import { getDraft, saveDraft, savePreparedFirstContactDraft } from "@/lib/services/drafts";
import { sendDraft } from "@/lib/services/email-sending";
import { deliverEmail } from "@/lib/email/send-provider";
import { assertDryRunTarget } from "@/lib/import/gateTarget";

// The guard runs before any connection is opened: rewinding the host and port of the live connection string
// once left the database name as `growth`, and every assertion passed against the wrong database.
if (process.env.LEGACY_GATE_DATABASE_URL) {
  assertDryRunTarget(process.env.LEGACY_GATE_DATABASE_URL);
}

/**
 * Hoisted so the mock factories below can reach it. `db` is the gate session, filled in beforeAll.
 */
const holder = vi.hoisted(() => ({
  db: null as DbClient | null,
  transportCalls: 0,
}));

vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return {
    ...actual,
    getDb: async () => {
      if (!holder.db) throw new Error("legacy gate: the gate session is not open");
      return holder.db;
    },
    // The gate session is owned by this file; its lifetime is closed in afterAll.
    closeDb: async () => undefined,
  };
});

vi.mock("@/lib/email/send-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send-provider")>();
  return {
    ...actual,
    deliverEmail: async () => {
      holder.transportCalls += 1;
      // Definitive, so a broken gate stops here instead of being recorded as an uncertain send.
      throw new actual.EmailDeliveryError("legacy gate: the transport must never be called", true);
    },
  };
});

const GATE_URL = (process.env.LEGACY_GATE_DATABASE_URL ?? "").trim();
const gateEnabled = GATE_URL.length > 0;

/** The same ssl rule src/lib/db/client.ts applies to a DATABASE_URL. */
function sslFor(url: string) {
  return /supabase\.co|pooler\.supabase\.com|sslmode=require/i.test(url)
    ? { rejectUnauthorized: false }
    : undefined;
}

/**
 * A connection to the copy. `sslmode=require` is taken out of the string and expressed as the ssl
 * object instead: pg 8.23 parses that mode itself and treats it as verify-full, which a self-signed
 * server certificate cannot satisfy — the ssl option would be ignored. Nothing here changes what the
 * connection protects; it mirrors the ssl object src/lib/db/client.ts builds for the same URL.
 */
function connectionOptions(): { connectionString: string; ssl?: { rejectUnauthorized: boolean } } {
  const ssl = sslFor(GATE_URL);
  if (!ssl) return { connectionString: GATE_URL };
  const parsed = new URL(GATE_URL);
  parsed.searchParams.delete("sslmode");
  parsed.searchParams.delete("ssl");
  return { connectionString: parsed.toString(), ssl };
}

function connect(): Client {
  return new Client(connectionOptions());
}

/**
 * One session, one open transaction. Application transactions become SAVEPOINTs so a nested commit
 * cannot end the run's outer transaction; the only COMMIT that could ever happen is the one this file
 * never issues.
 */
function gateClient(session: Client): DbClient {
  let depth = 0;
  const run = async <T>(text: string, params: unknown[] = []): Promise<QueryResult<T>> => {
    const result = await session.query(text, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  };
  const tx: DbClient = {
    query: run,
    exec: async (sql: string) => {
      await session.query(sql);
    },
    transaction: async <T>(fn: (inner: DbClient) => Promise<T>) => fn(tx),
    close: async () => undefined,
  };
  return {
    query: run,
    exec: async (sql: string) => {
      await session.query(sql);
    },
    transaction: async <T>(fn: (inner: DbClient) => Promise<T>) => {
      const name = `legacy_gate_${(depth += 1)}`;
      await session.query(`SAVEPOINT ${name}`);
      try {
        const value = await fn(tx);
        await session.query(`RELEASE SAVEPOINT ${name}`);
        return value;
      } catch (error) {
        await session.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw error;
      } finally {
        depth -= 1;
      }
    },
    close: async () => undefined,
  };
}

/** Counts only: this is the before/after fingerprint that proves the rollback. */
const SNAPSHOT: Array<[string, string]> = [
  ["prospects", "SELECT count(*)::int AS n FROM prospects"],
  ["prospects_dnc", "SELECT count(*)::int AS n FROM prospects WHERE do_not_contact"],
  ["drafts", "SELECT count(*)::int AS n FROM drafts"],
  ["drafts_sent", "SELECT count(*)::int AS n FROM drafts WHERE status = 'sent'"],
  ["drafts_draft", "SELECT count(*)::int AS n FROM drafts WHERE status = 'draft'"],
  ["drafts_approved", "SELECT count(*)::int AS n FROM drafts WHERE status = 'approved'"],
  ["draft_revisions", "SELECT count(*)::int AS n FROM draft_revisions"],
  ["messages", "SELECT count(*)::int AS n FROM messages"],
  ["conversations", "SELECT count(*)::int AS n FROM conversations"],
  ["outbound_sends", "SELECT count(*)::int AS n FROM outbound_sends"],
  ["suppressions_active", "SELECT count(*)::int AS n FROM suppressions WHERE active"],
  ["unsubscribe_tokens", "SELECT count(*)::int AS n FROM unsubscribe_tokens"],
  ["postal_address_set", "SELECT count(*)::int AS n FROM workspace_settings WHERE coalesce(postal_address,'') <> ''"],
  ["accounts_connected", "SELECT count(*)::int AS n FROM email_accounts WHERE status = 'connected'"],
];

async function snapshot(session: Client): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [label, sql] of SNAPSHOT) {
    const result = await session.query<{ n: number }>(sql);
    out[label] = Number(result.rows[0]?.n ?? -1);
  }
  return out;
}

/** The refusal code an app function produced, or a marker that it did not refuse at all. */
async function refusalCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "NOT_REFUSED";
  } catch (error) {
    if (error instanceof AppError) return error.code;
    return `unexpected_error:${(error as Error)?.name ?? "unknown"}`;
  }
}

function tally(counts: Map<string, number>, code: string) {
  counts.set(code, (counts.get(code) ?? 0) + 1);
}

function describeCodes(counts: Map<string, number>): string {
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return rows.length ? rows.map(([code, n]) => `${code} × ${n}`).join(", ") : "—";
}

function assertNoTransport() {
  expect(holder.transportCalls, "a probe reached the email transport").toBe(0);
}

/** One row per probe, printed at the end. Counts and codes only. */
const report: Array<{ probe: string; attempted: number; refused: number; codes: string }> = [];
/** Facts that are not a refusal count, printed under the table. */
const facts: Array<[string, string]> = [];

let preSnapshot: Record<string, number> = {};
let postSnapshot: Record<string, number> = {};
let session: Client | undefined;
let rolledBack = false;

const SAMPLE_SIZE = 30;
const ACTOR = "legacy-gate";

type SampleLead = { id: string; sentDraftId: string | null };

let sample: SampleLead[] = [];

describe.skipIf(!gateEnabled)("legacy import: the send gate, run through the app's own functions", () => {
  beforeAll(async () => {
    // Point the app at the copy, not at the embedded database tests/setup.ts configures.
    process.env.DATABASE_URL = GATE_URL;
    delete process.env.PGLITE_DIR;
    process.env.AUTO_MIGRATE = "false";

    const reader = connect();
    await reader.connect();
    preSnapshot = await snapshot(reader);
    await reader.end();

    session = connect();
    await session.connect();
    await session.query("BEGIN");
    const db = gateClient(session);
    holder.db = db;
    holder.transportCalls = 0;

    // Fixtures, all inside the transaction that is rolled back (see the header).
    await db.query("UPDATE email_accounts SET status = 'connected', last_error = null");
    await db.query(
      `UPDATE workspace_settings SET postal_address = $1
        WHERE id = 'default' AND coalesce(postal_address, '') = ''`,
      ["Gate test placeholder address — never used to send anything"],
    );

    const leads = await db.query<{ id: string; sent_draft_id: string | null }>(
      `SELECT p.id,
              (SELECT d.id FROM drafts d
                WHERE d.prospect_id = p.id AND d.kind = 'first_contact' AND d.status = 'sent'
                ORDER BY d.created_at LIMIT 1) AS sent_draft_id
         FROM prospects p
        WHERE EXISTS (SELECT 1 FROM messages m
                       WHERE m.prospect_id = p.id AND m.direction = 'outbound'
                         AND m.delivery_status IN ('accepted', 'uncertain'))
        ORDER BY p.id
        LIMIT $1`,
      [SAMPLE_SIZE],
    );
    sample = leads.rows.map((row) => ({ id: row.id, sentDraftId: row.sent_draft_id }));
  });

  it("arms the transport stub — a direct call is counted and throws", async () => {
    // The control for every zero below: if this does not fire, a later "0 calls" would prove nothing.
    await expect(deliverEmail({} as never, {} as never)).rejects.toThrow();
    expect(holder.transportCalls).toBe(1);
    holder.transportCalls = 0;
  });

  it("refuses a new first contact on 30 leads the import already contacted", async () => {
    expect(sample).toHaveLength(SAMPLE_SIZE);

    const editCodes = new Map<string, number>();
    const agentPathCodes = new Map<string, number>();
    let editedRefused = 0;
    let preserved = 0;
    let editedInPlace = 0;
    let created = 0;
    let sendableLeftBehind = 0;
    let withoutSentDraft = 0;

    for (const lead of sample) {
      const existing = await holder.db!.query<{ id: string }>(
        `SELECT id FROM drafts WHERE prospect_id = $1 AND kind = 'first_contact'`,
        [lead.id],
      );
      const known = new Set(existing.rows.map((row) => row.id));

      const target = lead.sentDraftId ? await getDraft(lead.sentDraftId) : null;
      if (!target) {
        withoutSentDraft += 1;
        continue;
      }

      // (1) saveDraft — the edit path the interface uses to change a first-contact message.
      const code = await refusalCode(() =>
        saveDraft({
          id: target.id,
          subject: "Gate test first contact",
          body: "Gate test body for the legacy gate. This text exists only inside a rolled-back transaction.",
          recipientEmail: target.recipientEmail,
          actorType: "api",
        }),
      );
      tally(editCodes, code);
      if (code !== "NOT_REFUSED") editedRefused += 1;

      // What the save left behind: a first-contact draft in a sendable state that did not exist before.
      const after = await holder.db!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM drafts
          WHERE prospect_id = $1 AND kind = 'first_contact'
            AND status IN ('draft', 'approved') AND id <> ALL($2::uuid[])`,
        [lead.id, [...known]],
      );
      sendableLeftBehind += Number(after.rows[0]?.n ?? 0);

      // (2) savePreparedFirstContactDraft — the connector/agent path that saves a first contact.
      const before = new Set(known);
      try {
        const saved = await savePreparedFirstContactDraft({
          prospectId: lead.id,
          subject: "Gate test first contact",
          body: "Gate test body for the legacy gate. This text exists only inside a rolled-back transaction.",
          actorType: "api",
          sourceClient: "legacy-gate-test",
        });
        if (saved.preserved) preserved += 1;
        else if (before.has(saved.draft.id)) editedInPlace += 1;
        else created += 1;
      } catch (error) {
        tally(agentPathCodes, error instanceof AppError ? error.code : `unexpected_error:${(error as Error)?.name}`);
      }

      assertNoTransport();
    }

    report.push({
      probe: "saveDraft, first contact on a contacted lead",
      attempted: SAMPLE_SIZE,
      refused: editedRefused,
      codes: describeCodes(editCodes),
    });
    report.push({
      probe: "savePreparedFirstContactDraft (agent path)",
      attempted: SAMPLE_SIZE,
      refused: SAMPLE_SIZE - preserved - editedInPlace - created,
      codes: `preserved ${preserved}, edited in place ${editedInPlace}, created ${created}${
        agentPathCodes.size ? `, refused ${describeCodes(agentPathCodes)}` : ""
      }`,
    });
    facts.push([
      "sendable first-contact drafts left behind by those saves",
      String(sendableLeftBehind),
    ]);

    expect(editedRefused).toBe(SAMPLE_SIZE);
    expect(editCodes.get("draft_sent")).toBe(SAMPLE_SIZE);
    expect(created, "a first contact was saved as a new draft on a contacted lead").toBe(0);
    expect(sendableLeftBehind, "a sendable first-contact draft was left behind").toBe(0);
    expect(withoutSentDraft, "a sampled lead had no imported first-contact draft").toBe(0);
    assertNoTransport();
  });

  it("refuses to send the imported first-contact drafts again", async () => {
    const asImported = new Map<string, number>();
    const asApproved = new Map<string, number>();
    let refusedAsImported = 0;
    let refusedAsApproved = 0;
    let skipped = 0;

    for (const lead of sample) {
      if (!lead.sentDraftId) {
        skipped += 1;
        continue;
      }
      const draft = await getDraft(lead.sentDraftId);
      if (!draft) {
        skipped += 1;
        continue;
      }

      // (a) exactly as the import left it: status 'sent', no outbound_sends row.
      const code = await refusalCode(() => sendDraft({ draftId: draft.id, actorUserId: ACTOR }));
      tally(asImported, code);
      if (code !== "NOT_REFUSED") refusedAsImported += 1;
      assertNoTransport();

      // (b) the contact gate itself: the draft is made to look sendable (approved) inside the
      // transaction, so the only thing that can stop it is the record of the earlier contact.
      await holder.db!.query(
        `UPDATE drafts SET status = 'approved', approved_at = now(), updated_at = now() WHERE id = $1`,
        [draft.id],
      );
      const gateCode = await refusalCode(() => sendDraft({ draftId: draft.id, actorUserId: ACTOR }));
      tally(asApproved, gateCode);
      if (gateCode !== "NOT_REFUSED") refusedAsApproved += 1;
      assertNoTransport();
    }

    report.push({
      probe: "sendDraft, imported first contact as imported",
      attempted: SAMPLE_SIZE - skipped,
      refused: refusedAsImported,
      codes: describeCodes(asImported),
    });
    report.push({
      probe: "sendDraft, same draft made approved in-transaction",
      attempted: SAMPLE_SIZE - skipped,
      refused: refusedAsApproved,
      codes: describeCodes(asApproved),
    });

    expect(refusedAsImported).toBe(SAMPLE_SIZE - skipped);
    expect(asImported.get("already_sent")).toBe(SAMPLE_SIZE - skipped);
    expect(refusedAsApproved).toBe(SAMPLE_SIZE - skipped);
    // A suppressed address is refused before the contact gate, by the gate's own order.
    const alreadyContacted = asApproved.get("already_contacted") ?? 0;
    const otherGate = (asApproved.get("suppressed") ?? 0) + (asApproved.get("do_not_contact") ?? 0);
    expect(alreadyContacted + otherGate).toBe(SAMPLE_SIZE - skipped);
    assertNoTransport();
  });

  it("refuses a send to every suppressed address (all 58)", async () => {
    const rows = await holder.db!.query<{ normalized_email: string; prospect_id: string | null }>(
      `SELECT normalized_email, prospect_id FROM suppressions WHERE active ORDER BY normalized_email`,
    );
    const codes = new Map<string, number>();
    let refused = 0;
    let withoutDraft = 0;

    for (const row of rows.rows) {
      if (!row.prospect_id) continue;
      // The lead's own first-contact draft, addressed to the suppressed address — which is the lead's
      // own address in every one of the 58 cases. A prospect may hold only one first-contact draft
      // (drafts_one_first_contact), so the row is re-pointed for the probe and put back after it.
      const found = await holder.db!.query<{
        id: string;
        status: string;
        recipient_email: string;
        approved_at: string | null;
      }>(
        `SELECT id, status, recipient_email, approved_at FROM drafts
          WHERE prospect_id = $1 AND kind = 'first_contact' LIMIT 1`,
        [row.prospect_id],
      );
      const target = found.rows[0];
      if (!target) {
        withoutDraft += 1;
        continue;
      }
      await holder.db!.query(
        `UPDATE drafts SET status = 'approved', recipient_email = $2, approved_at = now(),
           updated_at = now() WHERE id = $1`,
        [target.id, row.normalized_email],
      );
      const code = await refusalCode(() => sendDraft({ draftId: target.id, actorUserId: ACTOR }));
      tally(codes, code);
      if (code !== "NOT_REFUSED") refused += 1;

      await holder.db!.query(
        `UPDATE drafts SET status = $2, recipient_email = $3, approved_at = $4, updated_at = now()
          WHERE id = $1`,
        [target.id, target.status, target.recipient_email, target.approved_at],
      );

      assertNoTransport();
    }

    report.push({
      probe: "sendDraft to a suppressed address",
      attempted: rows.rows.length,
      refused,
      codes: describeCodes(codes),
    });

    expect(rows.rows.length).toBe(58);
    expect(withoutDraft, "a suppressed lead held no first-contact draft").toBe(0);
    expect(refused).toBe(rows.rows.length);
    // Every refusal is one of the recipient-safety stops; nothing reached the transport.
    for (const code of codes.keys()) {
      expect(["suppressed", "do_not_contact"]).toContain(code);
    }
    assertNoTransport();
  });

  it("refuses a follow-up where the prospect has replied", async () => {
    const target = await holder.db!.query<{ prospect_id: string; email: string }>(
      `SELECT c.prospect_id,
              (SELECT e.email FROM prospect_emails e
                WHERE e.prospect_id = c.prospect_id
                ORDER BY e.is_primary DESC, e.email LIMIT 1) AS email
         FROM conversations c
        WHERE EXISTS (SELECT 1 FROM messages m
                       WHERE m.conversation_id = c.id AND m.direction = 'inbound'
                         AND m.created_at > coalesce((
                           SELECT max(o.created_at) FROM messages o
                            WHERE o.conversation_id = c.id AND o.direction = 'outbound'
                         ), '-infinity'::timestamptz))
          AND EXISTS (SELECT 1 FROM prospect_emails e WHERE e.prospect_id = c.prospect_id)
          AND NOT EXISTS (SELECT 1 FROM drafts d
                           WHERE d.prospect_id = c.prospect_id AND d.kind = 'follow_up')
          AND NOT EXISTS (SELECT 1 FROM prospects p
                           WHERE p.id = c.prospect_id AND (p.do_not_contact OR p.archived_at IS NOT NULL))
          AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.active AND s.prospect_id = c.prospect_id)
        ORDER BY c.prospect_id
        LIMIT 1`,
    );
    expect(target.rows.length, "no replied conversation to test the follow-up gate").toBe(1);
    const row = target.rows[0];

    const draftId = await insertProbeDraft({
      prospectId: row.prospect_id,
      kind: "follow_up",
      recipientEmail: row.email,
    });
    const code = await refusalCode(() => sendDraft({ draftId, actorUserId: ACTOR }));

    report.push({
      probe: "sendDraft follow-up after an inbound reply",
      attempted: 1,
      refused: code === "NOT_REFUSED" ? 0 : 1,
      codes: code,
    });

    expect(code).toBe("prospect_replied");
    assertNoTransport();
  });

  it("refuses the first contact on P4 Provider and Tawsiyat with the hold cleared", async () => {
    const cleared = await holder.db!.query<{ id: string; sent_draft_id: string | null }>(
      `UPDATE prospects SET do_not_contact = false, updated_at = now()
        WHERE business_name ILIKE 'P4%' OR business_name ILIKE 'Tawsiyat%'
        RETURNING id,
                  (SELECT d.id FROM drafts d
                    WHERE d.prospect_id = prospects.id AND d.kind = 'first_contact' AND d.status = 'sent'
                    ORDER BY d.created_at LIMIT 1) AS sent_draft_id`,
    );
    expect(cleared.rows).toHaveLength(2);

    const codes = new Map<string, number>();
    let refused = 0;
    for (const row of cleared.rows) {
      if (!row.sent_draft_id) continue;
      await holder.db!.query(
        `UPDATE drafts SET status = 'approved', approved_at = now(), updated_at = now() WHERE id = $1`,
        [row.sent_draft_id],
      );
      const code = await refusalCode(() =>
        sendDraft({ draftId: row.sent_draft_id!, actorUserId: ACTOR }),
      );
      tally(codes, code);
      if (code !== "NOT_REFUSED") refused += 1;
      assertNoTransport();
    }

    // The hold really is cleared inside this transaction — otherwise the refusal above would be the
    // do_not_contact stop, not the contact gate.
    const heldNowOff = await holder.db!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM prospects
        WHERE (business_name ILIKE 'P4%' OR business_name ILIKE 'Tawsiyat%') AND do_not_contact = false`,
    );
    expect(Number(heldNowOff.rows[0]?.n)).toBe(2);

    report.push({
      probe: "sendDraft first contact, hold cleared in-transaction",
      attempted: 2,
      refused,
      codes: describeCodes(codes),
    });

    expect(refused).toBe(2);
    expect(codes.get("already_contacted")).toBe(2);
    assertNoTransport();
  });

  it("rolls back, and the copy is exactly as it was found", async () => {
    expect(session).toBeDefined();
    await session!.query("ROLLBACK");
    rolledBack = true;

    const reader = connect();
    await reader.connect();
    postSnapshot = await snapshot(reader);

    // Read on a separate connection, so this is what the database committed — not what is sitting in a
    // transaction that has not ended.
    const held = await reader.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM prospects
        WHERE (business_name ILIKE 'P4%' OR business_name ILIKE 'Tawsiyat%') AND do_not_contact = true`,
    );
    await reader.end();

    expect(postSnapshot).toEqual(preSnapshot);
    expect(Number(held.rows[0]?.n), "the withheld leads lost their hold").toBe(2);
    expect(holder.transportCalls, "a probe reached the email transport").toBe(0);

    printReport();
  });
});

/** The follow-up draft the import does not contain, created inside the transaction that is rolled back. */
async function insertProbeDraft(input: {
  prospectId: string;
  kind: "first_contact" | "follow_up";
  recipientEmail: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  await holder.db!.query(
    `INSERT INTO drafts
       (id, prospect_id, kind, sequence, status, subject, body, recipient_email, ai_generated,
        created_by_type, approved_at, created_at, updated_at, source_channel)
     VALUES ($1, $2, $3, 0, 'approved', $4, $5, $6, false, 'legacy', now(), now(), now(), 'legacy_import')`,
    [
      id,
      input.prospectId,
      input.kind,
      "Legacy gate probe",
      "Legacy gate probe body. It exists only inside the transaction this test rolls back.",
      input.recipientEmail,
    ],
  );
  return id;
}

afterAll(async () => {
  if (gateEnabled) {
    if (session && !rolledBack) {
      await session.query("ROLLBACK").catch(() => undefined);
    }
    await session?.end().catch(() => undefined);
    holder.db = null;
    printReport();
  }
});

let printed = false;

/** The report: one row per probe. Counts and refusal codes only, never a record value. */
function printReport() {
  if (printed || !report.length) return;
  printed = true;
  const width = Math.max(...report.map((row) => row.probe.length));
  const lines = report.map(
    (row) =>
      `  ${row.probe.padEnd(width)}  attempted ${String(row.attempted).padStart(3)}  ` +
      `refused ${String(row.refused).padStart(3)}  ${row.codes}`,
  );
  console.log(
    [
      "",
      "LEGACY GATE — app functions, not SQL re-derivation. Counts and refusal codes only.",
      ...lines,
      "",
      "  facts:",
      ...facts.map(([label, value]) => `    ${label}: ${value}`),
      `    transport calls: ${holder.transportCalls}`,
      `    copy unchanged after rollback: ${JSON.stringify(postSnapshot) === JSON.stringify(preSnapshot)}`,
      "",
    ].join("\n"),
  );
}

if (!gateEnabled) {
  console.info(
    "[legacy-gate] skipped: set LEGACY_GATE_DATABASE_URL to the tunnelled dry-run copy to run this gate.",
  );
}