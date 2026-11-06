import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

/**
 * The DELETE route is founder-only. An admin can edit providers, but destroying a stored key cannot
 * be undone, so it is refused before any database write. The session is mocked; the route, its
 * authorisation and the delete service are real.
 */

const { role } = vi.hoisted(() => ({ role: { current: "founder" as string | null, userId: "" } }));

// Session functions call each other inside their module, so the request scope is replaced at the
// guard the route uses. The founder rule it applies is the real `assertFounder`, tested below.
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth/session")>();
  const { AppError } = await import("@/lib/utils");
  const signedIn = () => {
    if (!role.current) throw new AppError("Sign in to continue.", 401, "unauthorized");
    // A real user row, because the deletion records who did it through a foreign key.
    return { id: role.userId, email: "route-founder@example.test", name: "Route founder", role: role.current as "founder" };
  };
  return {
    ...original,
    requireEditor: async () => signedIn(),
    requireFounder: async () => { const user = signedIn(); original.assertFounder(user); return user; },
  };
});

import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { createResearchProvider } from "@/lib/services/research-provider-admin";
import { DELETE } from "@/app/api/settings/providers/[id]/route";

/** Leave no AI assignment behind: later test files expect an unconfigured registry. */
async function clearAiSettings() {
  const db = await getDb();
  await db.query(`DELETE FROM ai_task_fallbacks`);
  await db.query(`DELETE FROM ai_task_settings`);
  await db.query(`DELETE FROM research_providers`);
}
import { assertFounder, ensureBootstrapUser } from "@/lib/auth/session";

const ORIGIN = process.env.APP_URL ?? "http://localhost:3100";
let providerId = "";

function request() {
  return new Request(`${ORIGIN}/api/settings/providers/${providerId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({}),
  });
}

async function storedKey() {
  const db = await getDb();
  const row = await db.query<{ encrypted_api_key: string; deleted_at: string | null }>(
    `SELECT encrypted_api_key, deleted_at FROM research_providers WHERE id = $1`,
    [providerId],
  );
  return row.rows[0]!;
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  role.userId = (await ensureBootstrapUser({
    email: "route-founder@example.test",
    password: crypto.randomUUID(),
    name: "Route founder",
  })).id;
});
beforeEach(async () => {
  const db = await getDb();
  await db.query(`DELETE FROM ai_task_fallbacks`);
  await db.query(`DELETE FROM ai_task_settings`);
  await db.query(`DELETE FROM research_providers`);
  providerId = await createResearchProvider({ name: "Route fixture", provider: "openai", apiKey: "sk-route-fixture" });
});
afterAll(async () => { await clearAiSettings();
  await closeDb(); });

it("the founder rule admits only the founder role", () => {
  expect(() => assertFounder({ role: "founder" })).not.toThrow();
  for (const other of ["admin", "editor", "viewer"]) {
    expect(() => assertFounder({ role: other as "founder" })).toThrow(/Only the founder/);
  }
});

it("refuses an admin, leaving the key untouched", async () => {
  role.current = "admin";
  const response = await DELETE(request(), { params: Promise.resolve({ id: providerId }) });
  expect(response.status).toBe(403);
  const row = await storedKey();
  expect(row.encrypted_api_key).not.toBe("");
  expect(row.deleted_at).toBeNull();
});

it("refuses a signed-out caller", async () => {
  role.current = null;
  const response = await DELETE(request(), { params: Promise.resolve({ id: providerId }) });
  expect(response.status).toBe(401);
  expect((await storedKey()).deleted_at).toBeNull();
});

it("lets the founder delete an unused provider, wiping its key", async () => {
  role.current = "founder";
  const response = await DELETE(request(), { params: Promise.resolve({ id: providerId }) });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.data.deleted).toBe("Route fixture");
  // The response never echoes a key, and the deleted row is gone from the returned list.
  expect(JSON.stringify(body)).not.toContain("sk-route-fixture");
  expect(body.data.providers.some((p: { id: string }) => p.id === providerId)).toBe(false);
  const row = await storedKey();
  expect(row.encrypted_api_key).toBe("");
  expect(row.deleted_at).not.toBeNull();

  // Who deleted it is recorded on the tombstone and in the audit log.
  const db = await getDb();
  const by = await db.query<{ deleted_by: string }>(`SELECT deleted_by FROM research_providers WHERE id = $1`, [providerId]);
  expect(by.rows[0]!.deleted_by).toBe(role.userId);
  const audit = await db.query<{ actor_id: string }>(
    `SELECT actor_id FROM audit_log WHERE action = 'ai_provider.deleted' AND entity_id = $1`,
    [providerId],
  );
  expect(audit.rows[0]!.actor_id).toBe(role.userId);
});
