import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";

import { POST as registerRoute } from "@/app/api/oauth/register/route";
import {
  OAUTH_REGISTRATIONS_PER_HOUR,
  checkOAuthRegistrationRateLimit,
  resetOAuthRegistrationLimits,
} from "@/lib/auth/request";
import { closeDb, getDb } from "@/lib/db/client";
import {
  OAUTH_PENDING_CLIENT_LIMIT,
  assertClientCapacity,
  countPendingClients,
} from "@/lib/oauth/server";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

async function clearClients(): Promise<void> {
  const db = await getDb();
  await db.query(`DELETE FROM oauth_clients`);
}

function registrationRequest(ip: string, name = "Test connector"): Request {
  return new Request("http://localhost:3100/api/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    }),
  });
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  await clearClients();
});

afterAll(async () => {
  await clearClients();
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("connector registration rate limit", () => {
  it("allows the hourly budget and refuses the next one", () => {
    resetOAuthRegistrationLimits();
    const ip = "203.0.113.10";

    for (let i = 0; i < OAUTH_REGISTRATIONS_PER_HOUR; i += 1) {
      expect(() => checkOAuthRegistrationRateLimit(ip)).not.toThrow();
    }

    expect(() => checkOAuthRegistrationRateLimit(ip)).toThrow(/too many connector registrations/i);
    try {
      checkOAuthRegistrationRateLimit(ip);
    } catch (error) {
      expect((error as { code?: string; status?: number }).code).toBe("rate_limited");
      expect((error as { status?: number }).status).toBe(429);
    }
  });

  it("gives each address its own window", () => {
    resetOAuthRegistrationLimits();

    for (let i = 0; i < OAUTH_REGISTRATIONS_PER_HOUR; i += 1) {
      checkOAuthRegistrationRateLimit("198.51.100.7");
    }

    expect(() => checkOAuthRegistrationRateLimit("198.51.100.7")).toThrow();
    // A different address has not spent anything.
    expect(() => checkOAuthRegistrationRateLimit("198.51.100.8")).not.toThrow();
  });

  it("is refused through the real route, not just the helper", async () => {
    resetOAuthRegistrationLimits();
    await clearClients();
    const ip = "192.0.2.55";

    const statuses: number[] = [];
    for (let i = 0; i < OAUTH_REGISTRATIONS_PER_HOUR + 1; i += 1) {
      const response = await registerRoute(registrationRequest(ip, `Flood ${i}`));
      statuses.push(response.status);
    }

    expect(statuses.slice(0, OAUTH_REGISTRATIONS_PER_HOUR).every((s) => s === 201)).toBe(true);
    expect(statuses[OAUTH_REGISTRATIONS_PER_HOUR]).toBe(429);

    const last = await registerRoute(registrationRequest(ip));
    const body = (await last.json()) as { code?: string };
    expect(body.code).toBe("rate_limited");
  });
});

describe("unapproved client cap", () => {
  it("counts only clients no token was ever issued for", async () => {
    await clearClients();
    const db = await getDb();

    for (let i = 0; i < 3; i += 1) {
      await db.query(
        `INSERT INTO oauth_clients (id, client_id, client_secret, client_name, redirect_uris, last_used_at)
         VALUES ($1, $2, 'x', $3, '[]'::jsonb, $4)`,
        [crypto.randomUUID(), `nq_pending_${i}`, `pending ${i}`, null],
      );
    }
    await db.query(
      `INSERT INTO oauth_clients (id, client_id, client_secret, client_name, redirect_uris, last_used_at)
       VALUES ($1, 'nq_approved', 'x', 'approved', '[]'::jsonb, now())`,
      [crypto.randomUUID()],
    );

    expect(await countPendingClients()).toBe(3);
    await expect(assertClientCapacity()).resolves.toBeUndefined();
  });

  it("refuses registration once the pending cap is reached, and frees up when one is approved", async () => {
    await clearClients();
    const db = await getDb();

    for (let i = 0; i < OAUTH_PENDING_CLIENT_LIMIT; i += 1) {
      await db.query(
        `INSERT INTO oauth_clients (id, client_id, client_secret, client_name, redirect_uris)
         VALUES ($1, $2, 'x', $3, '[]'::jsonb)`,
        [crypto.randomUUID(), `nq_pending_${i}`, `pending ${i}`],
      );
    }

    expect(await countPendingClients()).toBe(OAUTH_PENDING_CLIENT_LIMIT);
    await expect(assertClientCapacity()).rejects.toMatchObject({
      code: "client_capacity_reached",
      status: 429,
    });

    // The route refuses too, so the cap is not merely advisory.
    resetOAuthRegistrationLimits();
    const refused = await registerRoute(registrationRequest("192.0.2.99", "One too many"));
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { code?: string }).code).toBe("client_capacity_reached");

    // Approving any one connector (a token was issued) frees a slot.
    await db.query(
      `UPDATE oauth_clients SET last_used_at = now() WHERE client_id = 'nq_pending_0'`,
    );
    expect(await countPendingClients()).toBe(OAUTH_PENDING_CLIENT_LIMIT - 1);
    await expect(assertClientCapacity()).resolves.toBeUndefined();
  });
});