import { randomUUID } from "node:crypto";

import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/utils";

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 16;

export async function changePassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  /** Hash of the caller's current session token, or "" if it could not be read. */
  currentTokenHash: string;
}): Promise<{ sessionsRevoked: number }> {
  const { userId, currentPassword, newPassword, confirmPassword, currentTokenHash } = input;

  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    throw new AppError(`Use at least ${PASSWORD_MIN_LENGTH} characters.`, 400, "password_too_short");
  }

  if (newPassword.length > PASSWORD_MAX_LENGTH) {
    throw new AppError(`Use at most ${PASSWORD_MAX_LENGTH} characters.`, 400, "password_too_long");
  }

  if (newPassword !== confirmPassword) {
    throw new AppError("The two new passwords do not match.", 400, "password_mismatch");
  }

  if (newPassword === currentPassword) {
    throw new AppError("Choose a password different from your current one.", 400, "password_unchanged");
  }

  const db = await getDb();

  const existing = await db.query<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = $1 AND is_active = true`,
    [userId],
  );

  const row = existing.rows[0];
  if (!row) throw new AppError("Account not found.", 404);

  if (!verifyPassword(currentPassword, row.password_hash)) {
    throw new AppError("Your current password is incorrect.", 401, "invalid_password");
  }

  await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hashPassword(newPassword), userId]);

  const revoked = await db.query(
    `DELETE FROM sessions WHERE user_id = $1 AND ($2 = '' OR token_hash <> $2)`,
    [userId, currentTokenHash],
  );
  const sessionsRevoked = revoked.rowCount ?? 0;

  await db.query(
    `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1, 'founder', $2, 'auth.password_changed', 'user', $3, $4::jsonb)`,
    [randomUUID(), userId, userId, JSON.stringify({ sessionsRevoked })],
  );

  return { sessionsRevoked };
}
