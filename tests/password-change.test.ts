import crypto from "node:crypto";
import fs from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { closeDb, getDb } from "@/lib/db/client";
import { changePassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/services/account";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

const CURRENT_PASSWORD = "CurrentPassw0rd!";

const state = {
  userId: "",
  originalHash: "",
};

async function resetUser(): Promise<void> {
  const db = await getDb();
  await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [state.originalHash, state.userId]);
  await db.query(`DELETE FROM sessions WHERE user_id = $1`, [state.userId]);
  await db.query(`DELETE FROM audit_log WHERE entity_id = $1`, [state.userId]);
}

async function readHash(): Promise<string> {
  const db = await getDb();
  const result = await db.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [
    state.userId,
  ]);
  return result.rows[0]!.password_hash;
}

async function readSessions(): Promise<string[]> {
  const db = await getDb();
  const result = await db.query<{ token_hash: string }>(`SELECT token_hash FROM sessions WHERE user_id = $1`, [
    state.userId,
  ]);
  return result.rows.map((row) => row.token_hash);
}

async function insertSession(tokenHash: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')`,
    [crypto.randomUUID(), state.userId, tokenHash],
  );
}

beforeAll(async () => {
  const db = await getDb();
  await ensureWorkspaceDefaults();

  state.userId = crypto.randomUUID();
  state.originalHash = hashPassword(CURRENT_PASSWORD);

  await db.query(
    `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      state.userId,
      "password@test.nomeriq.com",
      "password@test.nomeriq.com",
      "Password Test",
      state.originalHash,
      "founder",
    ],
  );
});

afterAll(async () => {
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("changePassword", () => {
  it("exports the password minimum length", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(PASSWORD_MAX_LENGTH).toBe(16);
  });

  it("rejects a wrong current password and leaves the stored hash unchanged", async () => {
    await resetUser();

    await expect(
      changePassword({
        userId: state.userId,
        currentPassword: "WrongPassw0rd!23",
        newPassword: "Another!23456789",
        confirmPassword: "Another!23456789",
        currentTokenHash: "caller-session",
      }),
    ).rejects.toMatchObject({ status: 401, code: "invalid_password" });

    expect(await readHash()).toBe(state.originalHash);
  });

  it("rejects a 7-character new password before touching the database", async () => {
    await resetUser();

    await expect(
      changePassword({
        userId: state.userId,
        currentPassword: CURRENT_PASSWORD,
        newPassword: "Short12",
        confirmPassword: "Short12",
        currentTokenHash: "caller-session",
      }),
    ).rejects.toMatchObject({ code: "password_too_short" });

    expect(await readHash()).toBe(state.originalHash);
  });

  it("rejects a 17-character new password before touching the database", async () => {
    await resetUser();

    await expect(
      changePassword({
        userId: state.userId,
        currentPassword: CURRENT_PASSWORD,
        newPassword: "12345678901234567",
        confirmPassword: "12345678901234567",
        currentTokenHash: "caller-session",
      }),
    ).rejects.toMatchObject({ code: "password_too_long" });

    expect(await readHash()).toBe(state.originalHash);
  });

  it("accepts an 8-character password, the bottom of the allowed range", async () => {
    await resetUser();

    const newPassword = "Abcd!234";
    expect(newPassword).toHaveLength(8);

    const result = await changePassword({
      userId: state.userId,
      currentPassword: CURRENT_PASSWORD,
      newPassword,
      confirmPassword: newPassword,
      currentTokenHash: "caller-session",
    });

    expect(result.sessionsRevoked).toBeGreaterThanOrEqual(0);
    expect(verifyPassword(newPassword, await readHash())).toBe(true);
  });

  it("rejects when the two new passwords do not match", async () => {
    await resetUser();

    await expect(
      changePassword({
        userId: state.userId,
        currentPassword: CURRENT_PASSWORD,
        newPassword: "Mismatch!2345678",
        confirmPassword: "Mismatch!2345679",
        currentTokenHash: "caller-session",
      }),
    ).rejects.toMatchObject({ code: "password_mismatch" });

    expect(await readHash()).toBe(state.originalHash);
  });

  it("rejects when the new password equals the current one", async () => {
    await resetUser();

    await expect(
      changePassword({
        userId: state.userId,
        currentPassword: CURRENT_PASSWORD,
        newPassword: CURRENT_PASSWORD,
        confirmPassword: CURRENT_PASSWORD,
        currentTokenHash: "caller-session",
      }),
    ).rejects.toMatchObject({ code: "password_unchanged" });

    expect(await readHash()).toBe(state.originalHash);
  });

  it("revokes every session except the caller's and audits the change", async () => {
    await resetUser();

    const newPassword = "BrandNew!2345678";
    await insertSession("other-session-1");
    await insertSession("other-session-2");
    await insertSession("caller-session");

    const result = await changePassword({
      userId: state.userId,
      currentPassword: CURRENT_PASSWORD,
      newPassword,
      confirmPassword: newPassword,
      currentTokenHash: "caller-session",
    });

    expect(result.sessionsRevoked).toBe(2);

    const storedHash = await readHash();
    expect(storedHash).not.toBe(state.originalHash);
    expect(verifyPassword(newPassword, storedHash)).toBe(true);

    const sessions = await readSessions();
    expect(sessions).toEqual(["caller-session"]);

    const db = await getDb();
    const audit = await db.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_log WHERE entity_id = $1 AND action = 'auth.password_changed'`,
      [state.userId],
    );
    expect(audit.rows).toHaveLength(1);

    const metadata = audit.rows[0]!.metadata;
    expect(Object.keys(metadata)).toEqual(["sessionsRevoked"]);
    expect(metadata.sessionsRevoked).toBe(2);
    expect(JSON.stringify(metadata)).not.toContain(newPassword);
  });

  it("revokes every session when the caller's token hash is empty", async () => {
    await resetUser();

    const newPassword = "RevokeEvery!234";
    await insertSession("only-session");

    const result = await changePassword({
      userId: state.userId,
      currentPassword: CURRENT_PASSWORD,
      newPassword,
      confirmPassword: newPassword,
      currentTokenHash: "",
    });

    expect(result.sessionsRevoked).toBe(1);
    expect(await readSessions()).toEqual([]);
  });
});
