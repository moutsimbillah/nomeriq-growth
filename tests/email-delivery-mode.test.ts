import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const authState = vi.hoisted(() => ({ role: "founder" as string | null, userId: "" }));

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth/session")>();
  const { AppError } = await import("@/lib/utils");
  return {
    ...original,
    requireFounder: async () => {
      if (!authState.role) throw new AppError("Sign in to continue.", 401, "unauthorized");
      const user = {
        id: authState.userId,
        email: "delivery-mode@example.test",
        name: "Delivery mode founder",
        role: authState.role as "founder",
      };
      original.assertFounder(user);
      return user;
    },
  };
});

import { closeDb, getDb } from "@/lib/db/client";
import { ensureBootstrapUser } from "@/lib/auth/session";
import {
  ensureWorkspaceDefaults,
  getEmailDeliveryMode,
  getWorkspaceSettings,
  setEmailDeliveryMode,
} from "@/lib/services/settings";
import { PUT } from "@/app/api/settings/email-delivery-mode/route";

const ORIGIN = process.env.APP_URL ?? "http://localhost:3100";
let userId = "";

function request(body: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}/api/settings/email-delivery-mode`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

async function currentMode() {
  return (await getWorkspaceSettings()).emailDeliveryMode;
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  userId = (await ensureBootstrapUser({
    email: "delivery-mode@example.test",
    password: crypto.randomUUID(),
    name: "Delivery mode founder",
  })).id;
  authState.userId = userId;
});

beforeEach(async () => {
  authState.role = "founder";
  vi.stubEnv("EMAIL_DELIVERY_MODE", "sandbox");
  await (await getDb()).query(
    `UPDATE workspace_settings SET email_delivery_mode = NULL, updated_by = NULL WHERE id = 'default'`,
  );
  await (await getDb()).query(
    `DELETE FROM audit_log WHERE action = 'email_delivery_mode.changed' AND actor_id = $1`,
    [userId],
  );
});

afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  const db = await getDb();
  await db.query(`UPDATE workspace_settings SET email_delivery_mode = NULL, updated_by = NULL WHERE id = 'default'`);
  await db.query(`DELETE FROM audit_log WHERE actor_id = $1`, [userId]);
  await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await closeDb();
});

describe("workspace email delivery mode", () => {
  it("migration 041 is safe to rerun", async () => {
    const db = await getDb();
    const sql = readFileSync(
      path.join(process.cwd(), "src/db/migrations/041_email_delivery_mode.sql"),
      "utf8",
    );
    await db.exec(sql);
    await db.exec(sql);
    const column = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'workspace_settings' AND column_name = 'email_delivery_mode'`,
    );
    const constraint = await db.query(
      `SELECT conname FROM pg_constraint
       WHERE conname = 'workspace_settings_email_delivery_mode_check'`,
    );
    expect(column.rows).toHaveLength(1);
    expect(constraint.rows).toHaveLength(1);
  });

  it("uses the legacy environment value only while no portal choice is stored", async () => {
    vi.stubEnv("EMAIL_DELIVERY_MODE", "live");
    expect(await getEmailDeliveryMode()).toBe("live");
    expect((await getWorkspaceSettings()).emailDeliveryMode).toBe("live");

    await (await getDb()).query(
      `UPDATE workspace_settings SET email_delivery_mode = 'sandbox' WHERE id = 'default'`,
    );
    expect(await getEmailDeliveryMode()).toBe("sandbox");
  });

  it("sets, audits and reads back a mode without creating or changing an outbound send", async () => {
    const db = await getDb();
    const beforeSends = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM outbound_sends`);

    expect(await currentMode()).toBe("sandbox");
    expect(await setEmailDeliveryMode("live", userId)).toBe("live");
    expect(await getEmailDeliveryMode()).toBe("live");

    const audit = await db.query<{ actor_type: string; actor_id: string; metadata: Record<string, string> }>(
      `SELECT actor_type, actor_id, metadata FROM audit_log
       WHERE action = 'email_delivery_mode.changed' AND actor_id = $1`,
      [userId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_type: "founder",
      actor_id: userId,
      metadata: { from: "sandbox", to: "live" },
    });
    const afterSends = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM outbound_sends`);
    expect(afterSends.rows[0]?.count).toBe(beforeSends.rows[0]?.count);

    await setEmailDeliveryMode("sandbox", userId);
    expect(await getEmailDeliveryMode()).toBe("sandbox");
  });

  it("lets only the founder change the mode through the same-origin API", async () => {
    const response = await PUT(request({ mode: "live" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, data: { mode: "live" } });
    expect(await getEmailDeliveryMode()).toBe("live");

    authState.role = "admin";
    const refused = await PUT(request({ mode: "sandbox" }));
    expect(refused.status).toBe(403);
    expect(await getEmailDeliveryMode()).toBe("live");
  });

  it("rejects signed-out, cross-origin and invalid-mode requests without changing the setting", async () => {
    authState.role = null;
    expect((await PUT(request({ mode: "live" }))).status).toBe(401);

    authState.role = "founder";
    expect((await PUT(request({ mode: "live" }, "https://attacker.example"))).status).toBe(403);
    expect((await PUT(request({ mode: "automatic" }))).status).toBe(400);
    expect(await getEmailDeliveryMode()).toBe("sandbox");
  });
});
