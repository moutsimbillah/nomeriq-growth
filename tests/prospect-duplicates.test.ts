import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { closeDb, getDb } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import {
  getActiveDuplicateLink,
  listDuplicatesOf,
  markProspectDuplicate,
  restoreProspectDuplicate,
  searchCanonicalCandidates,
  type DuplicateSnapshot,
} from "@/lib/services/prospect-duplicates";
import { GET, POST } from "@/app/api/leads/[id]/duplicate/route";

/**
 * Founder's reversible "Duplicate of": archive + do-not-contact + cancel unsent work, NO suppression,
 * exact undo snapshot, strict restore. Synthetic rows only; nothing is sent. Pairs use unrelated
 * identities on purpose: migration 034's identity guard refuses two leads sharing a business identity,
 * and a manual founder mark does not depend on the resolver.
 */

const auth = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      auth.token && name === "nomeriq_growth_session" ? { name, value: auth.token } : undefined,
    set: () => undefined,
    delete: () => undefined,
  }),
}));

const RUN = crypto.randomUUID().slice(0, 8);
const prospectIds: string[] = [];
const userIds: string[] = [];
let founder = { id: "", role: "founder" as const };
let admin = { id: "", role: "admin" as const };

async function newUser(role: "founder" | "admin"): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const email = `dup-${role}-${RUN}@test.nomeriq.invalid`;
  await db.query(
    `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
     VALUES ($1, $2, $2, $3, $4, $5)`,
    [id, email, `Duplicate ${role}`, hashPassword(crypto.randomUUID()), role],
  );
  userIds.push(id);
  return id;
}

/** A synthetic lead with a microsecond-precision updated_at, so the snapshot's precision is tested. */
async function newLead(label: string, extra: { doNotContact?: boolean; nextAction?: string | null } = {}) {
  const db = await getDb();
  const id = crypto.randomUUID();
  const name = `DupFixture ${label} ${RUN} ${id.slice(0, 6)}`;
  await db.query(
    `INSERT INTO prospects (id, business_name, name_key, status, qualification_status, created_by_type,
       do_not_contact, next_action, updated_at)
     VALUES ($1, $2, $3, 'draft_prepared', 'verified', 'seed', $4, $5, '2026-01-02 03:04:05.123456+00')`,
    [id, name, name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), extra.doNotContact ?? false, "nextAction" in extra ? extra.nextAction : "Review"],
  );
  prospectIds.push(id);
  return { id, name };
}

async function newDraft(prospectId: string, status: string, kind: "first_contact" | "follow_up", sequence = 0) {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email, created_by_type)
     VALUES ($1, $2, $3, $4, $5, 'Synthetic', 'Synthetic body', 'nobody@example.invalid', 'seed')`,
    [id, prospectId, kind, sequence, status],
  );
  return id;
}

async function newSend(prospectId: string, draftId: string, status: "queued" | "sending" | "accepted") {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO outbound_sends (id, draft_id, prospect_id, idempotency_key, status, queued_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'queued' THEN now() + interval '1 hour' END)`,
    [id, draftId, prospectId, `dup-test-${id}`, status],
  );
  return id;
}

async function prospectRow(id: string) {
  const db = await getDb();
  return (
    await db.query<any>(
      `SELECT archived_at::text AS archived_at, do_not_contact, next_action, status, qualification_status,
              updated_at::text AS updated_at
         FROM prospects WHERE id = $1`,
      [id],
    )
  ).rows[0];
}

async function draftStatus(id: string) {
  const db = await getDb();
  return (await db.query<{ status: string }>(`SELECT status FROM drafts WHERE id = $1`, [id])).rows[0]?.status;
}

async function sendStatus(id: string) {
  const db = await getDb();
  return (await db.query<{ status: string }>(`SELECT status FROM outbound_sends WHERE id = $1`, [id])).rows[0]
    ?.status;
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  founder = { id: await newUser("founder"), role: "founder" };
  admin = { id: await newUser("admin"), role: "admin" };
});

afterAll(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM audit_log WHERE entity_id = ANY($1::text[])`, [prospectIds]);
  await db.query(
    `DELETE FROM prospect_duplicate_links WHERE prospect_id = ANY($1::uuid[]) OR canonical_prospect_id = ANY($1::uuid[])`,
    [prospectIds],
  );
  await db.query(`DELETE FROM suppressions WHERE prospect_id = ANY($1::uuid[])`, [prospectIds]);
  await db.query(`DELETE FROM outbound_sends WHERE prospect_id = ANY($1::uuid[])`, [prospectIds]);
  await db.query(`DELETE FROM drafts WHERE prospect_id = ANY($1::uuid[])`, [prospectIds]);
  await db.query(`DELETE FROM prospects WHERE id = ANY($1::uuid[])`, [prospectIds]);
  await db.query(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [userIds]);
  await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
  await closeDb();
});

describe("mark as duplicate", () => {
  it("archives + do-not-contact, cancels unsent drafts and queued sends, keeps outcomes, creates NO suppression", async () => {
    const keep = await newLead("keep");
    const dup = await newLead("dup");
    const firstDraft = await newDraft(dup.id, "approved", "first_contact");
    const followDraft = await newDraft(dup.id, "draft", "follow_up", 1);
    const sentDraft = await newDraft(dup.id, "sent", "follow_up", 2);
    const queued = await newSend(dup.id, firstDraft, "queued");
    const accepted = await newSend(dup.id, sentDraft, "accepted");
    const keepDraft = await newDraft(keep.id, "approved", "first_contact");

    const { link, alreadyLinked } = await markProspectDuplicate({
      prospectId: dup.id,
      canonicalProspectId: keep.id,
      actor: founder,
    });
    expect(alreadyLinked).toBe(false);
    expect(link).toMatchObject({
      prospectId: dup.id,
      canonicalProspectId: keep.id,
      canonicalName: keep.name,
      canonicalActive: true,
      restoredAt: null,
      cancelledDrafts: 2,
      blockedSends: 1,
    });

    const row = await prospectRow(dup.id);
    expect(row.archived_at).not.toBeNull();
    expect(row.do_not_contact).toBe(true);
    expect(row.next_action).toBe(`Duplicate of ${keep.name}`);
    // Qualification and pipeline status are preserved, not rewritten to lost/rejected.
    expect(row.status).toBe("draft_prepared");
    expect(row.qualification_status).toBe("verified");

    expect(await draftStatus(firstDraft)).toBe("cancelled");
    expect(await draftStatus(followDraft)).toBe("cancelled");
    expect(await draftStatus(sentDraft)).toBe("sent");
    expect(await sendStatus(queued)).toBe("blocked");
    expect(await sendStatus(accepted)).toBe("accepted");
    // The canonical lead's own work is untouched.
    expect(await draftStatus(keepDraft)).toBe("approved");
    expect((await prospectRow(keep.id)).archived_at).toBeNull();

    const db = await getDb();
    const suppressions = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM suppressions WHERE prospect_id = ANY($1::uuid[])`,
      [[dup.id, keep.id]],
    );
    expect(suppressions.rows[0].n).toBe(0);

    const audit = await db.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM audit_log WHERE entity_id = $1`,
      [dup.id],
    );
    expect(audit.rows).toEqual([{ action: "prospect.duplicate_marked", actor_id: founder.id }]);

    expect((await getActiveDuplicateLink(dup.id))?.id).toBe(link.id);
    expect((await listDuplicatesOf(keep.id)).map((item) => item.prospectId)).toEqual([dup.id]);
  });

  it("stores the exact prior state, including microsecond timestamps and draft/send snapshots", async () => {
    const keep = await newLead("keep-precision");
    const dup = await newLead("dup-precision", { nextAction: null });
    const draft = await newDraft(dup.id, "draft", "first_contact");
    const queued = await newSend(dup.id, draft, "queued");
    const db = await getDb();
    const before = await db.query<any>(
      `SELECT updated_at::text AS u FROM drafts WHERE id = $1`,
      [draft],
    );
    await markProspectDuplicate({ prospectId: dup.id, canonicalProspectId: keep.id, actor: founder });
    const stored = await db.query<{ previous_state: DuplicateSnapshot; created_by_user_id: string }>(
      `SELECT previous_state, created_by_user_id::text AS created_by_user_id FROM prospect_duplicate_links
        WHERE prospect_id = $1 AND restored_at IS NULL`,
      [dup.id],
    );
    const snapshot = stored.rows[0].previous_state;
    expect(stored.rows[0].created_by_user_id).toBe(founder.id);
    expect(snapshot.version).toBe(1);
    expect(snapshot.before.prospect).toMatchObject({
      archived_at: null,
      do_not_contact: false,
      next_action: null,
      status: "draft_prepared",
      qualification_status: "verified",
    });
    const equal = await db.query<{ same: boolean }>(
      `SELECT $1::timestamptz = '2026-01-02 03:04:05.123456+00'::timestamptz AS same`,
      [snapshot.before.prospect.updated_at],
    );
    expect(equal.rows[0].same).toBe(true);
    expect(snapshot.before.drafts).toEqual([{ id: draft, status: "draft", updated_at: before.rows[0].u }]);
    expect(snapshot.before.sends.map((s) => [s.id, s.status])).toEqual([[queued, "queued"]]);
    expect(snapshot.after.sends.map((s) => [s.id, s.status])).toEqual([[queued, "blocked"]]);
    expect(snapshot.cancelledDraftIds).toEqual([draft]);
    expect(snapshot.blockedSendIds).toEqual([queued]);
    const after = await prospectRow(dup.id);
    expect(snapshot.after.prospect.archived_at).toBe(after.archived_at);
    expect(snapshot.after.prospect.updated_at).toBe(after.updated_at);
  });

  it("repeating the same mark is idempotent; a different canonical is refused", async () => {
    const keep = await newLead("keep-repeat");
    const other = await newLead("other-repeat");
    const dup = await newLead("dup-repeat");
    const first = await markProspectDuplicate({ prospectId: dup.id, canonicalProspectId: keep.id, actor: founder });
    const again = await markProspectDuplicate({ prospectId: dup.id, canonicalProspectId: keep.id, actor: founder });
    expect(again.alreadyLinked).toBe(true);
    expect(again.link.id).toBe(first.link.id);
    await expect(
      markProspectDuplicate({ prospectId: dup.id, canonicalProspectId: other.id, actor: founder }),
    ).rejects.toMatchObject({ status: 409, code: "already_duplicate" });
  });

  it("refuses self-links, chains, archived leads, inactive canonicals and non-founders without changing anything", async () => {
    const keep = await newLead("keep-refuse");
    const middle = await newLead("middle-refuse");
    const dup = await newLead("dup-refuse");
    const archived = await newLead("archived-refuse");
    const db = await getDb();
    await db.query(`UPDATE prospects SET archived_at = now() WHERE id = $1`, [archived.id]);

    await expect(
      markProspectDuplicate({ prospectId: dup.id, canonicalProspectId: dup.id, actor: founder }),
    ).rejects.toMatchObject({ status: 400, code: "duplicate_self" });
    await expect(
      markProspectDuplicate({ prospectId: dup.id, canonicalProspectId: keep.id, actor: admin }),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(
      markProspectDuplicate({ prospectId: dup.id, canonicalProspectId: archived.id, actor: founder }),
    ).rejects.toMatchObject({ status: 409, code: "canonical_unavailable" });
    await expect(
      markProspectDuplicate({ prospectId: archived.id, canonicalProspectId: keep.id, actor: founder }),
    ).rejects.toMatchObject({ status: 409, code: "already_archived" });
    await expect(
      markProspectDuplicate({ prospectId: crypto.randomUUID(), canonicalProspectId: keep.id, actor: founder }),
    ).rejects.toMatchObject({ status: 404 });

    await markProspectDuplicate({ prospectId: middle.id, canonicalProspectId: keep.id, actor: founder });
    // A → B where B is itself a duplicate: refused (canonical archived by the mark, and linked).
    await expect(
      markProspectDuplicate({ prospectId: dup.id, canonicalProspectId: middle.id, actor: founder }),
    ).rejects.toMatchObject({ status: 409 });
    // Retiring a lead other leads point at: refused.
    await expect(
      markProspectDuplicate({ prospectId: keep.id, canonicalProspectId: dup.id, actor: founder }),
    ).rejects.toMatchObject({ status: 409, code: "duplicate_chain" });

    const untouched = await prospectRow(dup.id);
    expect(untouched).toMatchObject({ archived_at: null, do_not_contact: false });
    expect((await prospectRow(keep.id)).archived_at).toBeNull();
  });

  it("refuses while a send is in flight and leaves every row as it was", async () => {
    const keep = await newLead("keep-inflight");
    const dup = await newLead("dup-inflight");
    const draft = await newDraft(dup.id, "approved", "first_contact");
    const sending = await newSend(dup.id, draft, "sending");
    await expect(
      markProspectDuplicate({ prospectId: dup.id, canonicalProspectId: keep.id, actor: founder }),
    ).rejects.toMatchObject({ status: 409, code: "send_in_progress" });
    expect(await draftStatus(draft)).toBe("approved");
    expect(await sendStatus(sending)).toBe("sending");
    expect((await prospectRow(dup.id)).archived_at).toBeNull();
    expect(await getActiveDuplicateLink(dup.id)).toBeNull();
  });
});

describe("restore a duplicate", () => {
  it("restores visibility and prior do-not-contact, keeps cancellations, and repeats idempotently", async () => {
    const keep = await newLead("keep-restore");
    const dup = await newLead("dup-restore", { nextAction: "Call back" });
    const draft = await newDraft(dup.id, "approved", "first_contact");
    const queued = await newSend(dup.id, draft, "queued");
    const { link } = await markProspectDuplicate({ prospectId: dup.id, canonicalProspectId: keep.id, actor: founder });

    await expect(restoreProspectDuplicate({ prospectId: dup.id, actor: admin })).rejects.toMatchObject({
      status: 403,
    });

    const restored = await restoreProspectDuplicate({ prospectId: dup.id, actor: founder });
    expect(restored.alreadyRestored).toBe(false);
    expect(restored.link.id).toBe(link.id);
    expect(restored.link.restoredAt).not.toBeNull();

    const row = await prospectRow(dup.id);
    expect(row).toMatchObject({
      archived_at: null,
      do_not_contact: false,
      next_action: "Call back",
      status: "draft_prepared",
      qualification_status: "verified",
    });
    // Nothing is approved, re-queued or sent by a restore.
    expect(await draftStatus(draft)).toBe("cancelled");
    expect(await sendStatus(queued)).toBe("blocked");
    expect(await getActiveDuplicateLink(dup.id)).toBeNull();

    const repeat = await restoreProspectDuplicate({ prospectId: dup.id, actor: founder });
    expect(repeat).toMatchObject({ alreadyRestored: true, link: { id: link.id } });

    // A later re-mark after restore is a fresh link (the partial unique index allows history).
    const remark = await markProspectDuplicate({ prospectId: dup.id, canonicalProspectId: keep.id, actor: founder });
    expect(remark.alreadyLinked).toBe(false);
    expect(remark.link.id).not.toBe(link.id);
    expect(remark.link.cancelledDrafts).toBe(0);
  });

  it("keeps a lead that was already do-not-contact as do-not-contact after restore", async () => {
    const keep = await newLead("keep-dnc");
    const dup = await newLead("dup-dnc", { doNotContact: true });
    await markProspectDuplicate({ prospectId: dup.id, canonicalProspectId: keep.id, actor: founder });
    await restoreProspectDuplicate({ prospectId: dup.id, actor: founder });
    expect((await prospectRow(dup.id)).do_not_contact).toBe(true);
  });

  it("refuses (409) when the lead, its drafts or its sends changed after the mark", async () => {
    const db = await getDb();
    const keep = await newLead("keep-changed");

    const touched = await newLead("dup-touched");
    await markProspectDuplicate({ prospectId: touched.id, canonicalProspectId: keep.id, actor: founder });
    await db.query(`UPDATE prospects SET founder_notes = 'edited', updated_at = now() WHERE id = $1`, [touched.id]);
    await expect(restoreProspectDuplicate({ prospectId: touched.id, actor: founder })).rejects.toMatchObject({
      status: 409,
      code: "duplicate_state_changed",
    });
    expect((await prospectRow(touched.id)).archived_at).not.toBeNull();
    expect(await getActiveDuplicateLink(touched.id)).not.toBeNull();

    const drafted = await newLead("dup-drafted");
    const draft = await newDraft(drafted.id, "draft", "first_contact");
    await markProspectDuplicate({ prospectId: drafted.id, canonicalProspectId: keep.id, actor: founder });
    await db.query(`UPDATE drafts SET status = 'draft', updated_at = now() WHERE id = $1`, [draft]);
    await expect(restoreProspectDuplicate({ prospectId: drafted.id, actor: founder })).rejects.toMatchObject({
      code: "duplicate_state_changed",
    });

    const newWork = await newLead("dup-newwork");
    await markProspectDuplicate({ prospectId: newWork.id, canonicalProspectId: keep.id, actor: founder });
    await newDraft(newWork.id, "draft", "follow_up", 1);
    await expect(restoreProspectDuplicate({ prospectId: newWork.id, actor: founder })).rejects.toMatchObject({
      code: "duplicate_state_changed",
    });
  });

  it("returns 404 for a lead that was never marked", async () => {
    const lead = await newLead("never-marked");
    await expect(restoreProspectDuplicate({ prospectId: lead.id, actor: founder })).rejects.toMatchObject({
      status: 404,
      code: "duplicate_not_found",
    });
  });
});

describe("canonical search", () => {
  it("offers active leads only, never the lead itself or a current duplicate", async () => {
    const tag = `Searchable${RUN}`;
    const self = await newLead(`${tag} self`);
    const keep = await newLead(`${tag} keep`);
    const gone = await newLead(`${tag} gone`);
    await markProspectDuplicate({ prospectId: gone.id, canonicalProspectId: keep.id, actor: founder });
    const ids = (await searchCanonicalCandidates(self.id, tag)).map((row) => row.id);
    expect(ids).toContain(keep.id);
    expect(ids).not.toContain(self.id);
    expect(ids).not.toContain(gone.id);
    expect(await searchCanonicalCandidates(self.id, "a")).toEqual([]);
  });
});

describe("lead page wiring and agent boundary", () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  it("the page shows Mark only to the founder, and renders a duplicate's link + Restore instead of 404", () => {
    const page = read("src/app/(app)/leads/[id]/page.tsx");
    expect(page).toContain("getActiveDuplicateLink(id)");
    expect(page).toMatch(/isFounder && \(\s*<MarkDuplicateButton/);
    expect(page).toContain('canManage={viewer?.role === "founder"}');
    expect(page).toContain("<RestoreDuplicateButton");
    expect(page).toContain("<DuplicatesOfList duplicates={duplicatesOf} />");
  });

  it("the control warns before marking, requires confirmation, and says restore revives nothing", () => {
    const control = read("src/components/prospect-duplicate-control.tsx");
    expect(control).toContain("description={DUPLICATE_MARK_WARNING}");
    expect(control).toContain("description={DUPLICATE_RESTORE_NOTE}");
    expect(control).toContain("disabled={pending || !selected || !confirmed}");
    expect(control).toContain('confirm: true');
    expect(control).toMatch(/no address is suppressed/);
    expect(control).toMatch(/nothing is approved, queued or sent automatically/);
  });

  it("no agent/MCP surface can mark or restore duplicates", () => {
    for (const path of ["src/lib/agent/service.ts", "src/lib/agent/scopes.ts", "src/app/api/mcp/route.ts"]) {
      expect(read(path), path).not.toMatch(/prospect-duplicates|markProspectDuplicate|restoreProspectDuplicate/);
    }
  });
});

describe("POST/GET /api/leads/[id]/duplicate", () => {
  const origin = "http://localhost:3100";
  function post(id: string, body: unknown, headers: Record<string, string> = { origin }) {
    return POST(
      new Request(`${origin}/api/leads/${id}/duplicate`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  it("is founder-only and same-origin, and validates the body strictly before any change", async () => {
    const keep = await newLead("keep-route");
    const dup = await newLead("dup-route");
    const mark = { action: "mark", canonicalProspectId: keep.id, confirm: true };

    auth.token = null;
    expect((await post(dup.id, mark)).status).toBe(401);
    auth.token = (await createSession(admin.id)).token;
    expect((await post(dup.id, mark)).status).toBe(403);

    auth.token = (await createSession(founder.id)).token;
    expect((await post(dup.id, mark, {})).status).toBe(403);
    expect((await post(dup.id, mark, { origin: "https://evil.example" })).status).toBe(403);
    for (const bad of [
      { action: "mark", canonicalProspectId: keep.id },
      { action: "mark", canonicalProspectId: keep.id, confirm: "yes" },
      { ...mark, extra: 1 },
      { action: "restore", force: true },
      { action: "merge" },
      { action: "mark", canonicalProspectId: "not-a-uuid", confirm: true },
      [mark],
      null,
      7,
    ]) {
      const response = await post(dup.id, bad);
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await post(dup.id, "{not json")).status).toBe(400);
    expect((await post("not-a-uuid", mark)).status).toBe(404);
    expect((await prospectRow(dup.id)).archived_at).toBeNull();

    const marked = await post(dup.id, mark);
    expect(marked.status).toBe(200);
    const markedBody = await marked.json();
    expect(markedBody).toMatchObject({ ok: true, data: { alreadyLinked: false, link: { canonicalProspectId: keep.id } } });

    const state = await GET(new Request(`${origin}/api/leads/${dup.id}/duplicate`), {
      params: Promise.resolve({ id: dup.id }),
    });
    expect((await state.json()).data.link.canonicalProspectId).toBe(keep.id);
    const canonicalState = await GET(new Request(`${origin}/api/leads/${keep.id}/duplicate?q=DupFixture`), {
      params: Promise.resolve({ id: keep.id }),
    });
    const canonicalBody = await canonicalState.json();
    expect(canonicalBody.data.duplicates.map((d: { prospectId: string }) => d.prospectId)).toEqual([dup.id]);
    expect(canonicalBody.data.candidates.map((c: { id: string }) => c.id)).not.toContain(keep.id);
    expect(
      (await GET(new Request(`${origin}/api/leads/${keep.id}/duplicate?q=x&other=1`), {
        params: Promise.resolve({ id: keep.id }),
      })).status,
    ).toBe(400);

    const restored = await post(dup.id, { action: "restore" });
    expect(restored.status).toBe(200);
    expect((await restored.json()).data.alreadyRestored).toBe(false);
    const again = await post(dup.id, { action: "restore" });
    expect((await again.json()).data.alreadyRestored).toBe(true);

    auth.token = (await createSession(admin.id)).token;
    expect(
      (await GET(new Request(`${origin}/api/leads/${dup.id}/duplicate`), { params: Promise.resolve({ id: dup.id }) }))
        .status,
    ).toBe(403);
    auth.token = null;
  });
});
