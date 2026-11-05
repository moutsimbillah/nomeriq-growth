import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { POST } from "@/app/api/leads/[id]/follow-up-exclusion/route";
import { setFollowUpExclusion } from "@/lib/services/prospects";

/**
 * Exclusion keeps a lead out of the automatic follow-up job; it does not ban contact.
 *
 * The route is founder-only, so these cases drive it as a real session would: a session row is written
 * and `cookies()` is answered from it, which means the real guard — not a stub of it — decides.
 */

const auth = vi.hoisted(() => ({ token: null as string | null, cookie: "nomeriq_growth_session" }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      auth.token && name === auth.cookie ? { name, value: auth.token } : undefined,
    set: () => undefined,
    delete: () => undefined,
  }),
}));

const ids = {
  founder: "",
  member: "",
  prospect: "",
  doNotContactProspect: "",
};

async function newUser(role: "founder" | "member", email: string): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
     VALUES ($1, $2, $2, $3, $4, $5)`,
    [id, email, `Exclusion ${role}`, hashPassword("TestPassw0rd!123"), role],
  );
  return id;
}

async function newProspect(name: string, doNotContact = false): Promise<string> {
  const db = await getDb();
  const row = await db.query<{ id: string }>(
    `INSERT INTO prospects (id, business_name, name_key, status, created_by_type, do_not_contact)
     VALUES (gen_random_uuid(), $1, $2, 'contacted', 'legacy', $3) RETURNING id`,
    [name, name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), doNotContact],
  );
  return row.rows[0].id;
}

async function signInAs(userId: string): Promise<void> {
  auth.token = (await createSession(userId)).token;
}

function requestFor(id: string, body: unknown): Request {
  return new Request(`http://localhost:3100/api/leads/${id}/follow-up-exclusion`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3100" },
    body: JSON.stringify(body),
  });
}

async function callRoute(id: string, body: unknown) {
  const response = await POST(requestFor(id, body), { params: Promise.resolve({ id }) });
  const payload = (await response.json()) as {
    ok: boolean;
    excluded?: boolean;
    error?: string;
    code?: string;
  };
  return { status: response.status, payload };
}

async function flags(prospectId: string) {
  const db = await getDb();
  const result = await db.query<{ follow_up_excluded: boolean; do_not_contact: boolean }>(
    `SELECT follow_up_excluded, do_not_contact FROM prospects WHERE id = $1`,
    [prospectId],
  );
  return result.rows[0];
}

beforeAll(async () => {
  ids.founder = await newUser("founder", "follow-up-exclusion-founder@test.nomeriq.com");
  ids.member = await newUser("member", "follow-up-exclusion-member@test.nomeriq.com");
  ids.prospect = await newProspect("Exclusion Lead");
  ids.doNotContactProspect = await newProspect("Exclusion Banned Lead", true);
});

afterAll(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [
    [ids.founder, ids.member],
  ]);
  await db.query(`DELETE FROM prospects WHERE id = ANY($1::uuid[])`, [
    [ids.prospect, ids.doNotContactProspect],
  ]);
  await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ids.founder, ids.member]]);
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

describe("follow-up exclusion", () => {
  it("sets and clears the column, and returns the value it now holds", async () => {
    expect(await flags(ids.prospect)).toEqual({
      follow_up_excluded: false,
      do_not_contact: false,
    });

    expect(await setFollowUpExclusion(ids.prospect, true)).toBe(true);
    expect((await flags(ids.prospect)).follow_up_excluded).toBe(true);

    expect(await setFollowUpExclusion(ids.prospect, false)).toBe(false);
    expect((await flags(ids.prospect)).follow_up_excluded).toBe(false);
  });

  it("never changes do_not_contact, in either direction", async () => {
    await setFollowUpExclusion(ids.prospect, true);
    expect((await flags(ids.prospect)).do_not_contact).toBe(false);

    await setFollowUpExclusion(ids.doNotContactProspect, true);
    expect((await flags(ids.doNotContactProspect)).do_not_contact).toBe(true);

    // and it leaves no suppression behind: nothing about this stops a deliberate email
    const db = await getDb();
    const suppressed = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM suppressions WHERE prospect_id = $1`,
      [ids.prospect],
    );
    expect(suppressed.rows[0].n).toBe(0);

    await setFollowUpExclusion(ids.prospect, false);
    expect((await flags(ids.prospect)).do_not_contact).toBe(false);
  });

  it("lets the founder toggle it through the route", async () => {
    await signInAs(ids.founder);

    const excluded = await callRoute(ids.prospect, { excluded: true });
    expect(excluded.status).toBe(200);
    expect(excluded.payload).toEqual({ ok: true, excluded: true });
    expect((await flags(ids.prospect)).follow_up_excluded).toBe(true);

    const included = await callRoute(ids.prospect, { excluded: false });
    expect(included.status).toBe(200);
    expect(included.payload).toEqual({ ok: true, excluded: false });
    expect((await flags(ids.prospect)).follow_up_excluded).toBe(false);
  });

  it("refuses a non-founder, and leaves the lead untouched", async () => {
    await signInAs(ids.member);

    const refused = await callRoute(ids.prospect, { excluded: true });
    expect(refused.status).toBe(403);
    expect(refused.payload).toMatchObject({ ok: false, code: "forbidden" });
    expect((await flags(ids.prospect)).follow_up_excluded).toBe(false);
  });

  it("answers an unknown lead with 404", async () => {
    await signInAs(ids.founder);

    const missing = await callRoute(crypto.randomUUID(), { excluded: true });
    expect(missing.status).toBe(404);
    expect(missing.payload).toMatchObject({
      ok: false,
      error: "Prospect not found.",
      code: "prospect_not_found",
    });
  });
});