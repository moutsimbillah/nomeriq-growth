import { createHash } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { AppError, isEmail, normalizeEmail } from "@/lib/utils";

export async function unsubscribeByToken(
  rawToken: string,
): Promise<{ email: string; alreadySuppressed: boolean }> {
  if (!rawToken || rawToken.length < 20) {
    throw new AppError("This unsubscribe link is not valid.", 404);
  }
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const db = await getDb();
  const tokenResult = await db.query<any>(
    `SELECT * FROM unsubscribe_tokens WHERE token_hash = $1 LIMIT 1`,
    [tokenHash],
  );
  const token = tokenResult.rows[0];
  if (!token) {
    throw new AppError("This unsubscribe link is not valid.", 404);
  }
  const existing = await db.query(
    `SELECT 1 FROM suppressions WHERE normalized_email = $1 AND active = true`,
    [token.normalized_email],
  );
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO suppressions
        (id, normalized_email, email, reason, source, prospect_id, note)
       SELECT $1, $2, pe.email, 'unsubscribe', 'unsubscribe_link', $3,
         'Recipient used the unsubscribe link.'
       FROM prospect_emails pe
       WHERE pe.prospect_id = $3 AND pe.normalized_email = $2
       LIMIT 1
       ON CONFLICT (normalized_email) DO UPDATE SET active = true, reason = 'unsubscribe', updated_at = now()`,
      [crypto.randomUUID(), token.normalized_email, token.prospect_id],
    );
    await tx.query(
      `UPDATE unsubscribe_tokens SET used_at = COALESCE(used_at, now()) WHERE id = $1`,
      [token.id],
    );
    await tx.query(
      `UPDATE prospects SET do_not_contact = true, status = 'lost',
        next_action = 'No further contact — unsubscribed', updated_at = now()
       WHERE id = $1`,
      [token.prospect_id],
    );
    await tx.query(
      `UPDATE drafts SET status = 'cancelled', updated_at = now()
       WHERE prospect_id = $1 AND status IN ('draft', 'approved') AND kind = 'follow_up'`,
      [token.prospect_id],
    );
    await tx.query(
      `INSERT INTO audit_log
        (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'recipient', $2, 'suppression.unsubscribe', 'prospect', $3, $4::jsonb)`,
      [
        crypto.randomUUID(),
        normalizeEmail(token.normalized_email),
        token.prospect_id,
        JSON.stringify({ source: "unsubscribe_link" }),
      ],
    );
  });
  const row = await db.query<{ email: string }>(
    `SELECT email FROM suppressions WHERE normalized_email = $1`,
    [token.normalized_email],
  );
  return {
    email: row.rows[0]?.email || token.normalized_email,
    alreadySuppressed: existing.rows.length > 0,
  };
}

export async function addSuppression(input: {
  email: string;
  reason: "unsubscribe" | "opt_out" | "bounce" | "complaint" | "manual";
  note?: string;
  userId: string;
}) {
  if (!isEmail(input.email)) throw new AppError("Enter a valid email address.");
  const db = await getDb();
  const normalized = normalizeEmail(input.email);
  const prospect = await db.query<{ id: string }>(
    `SELECT prospect_id AS id FROM prospect_emails WHERE normalized_email = $1 LIMIT 1`,
    [normalized],
  );
  await db.query(
    `INSERT INTO suppressions
      (id, normalized_email, email, reason, source, prospect_id, note)
     VALUES ($1, $2, $3, $4, 'founder', $5, $6)
     ON CONFLICT (normalized_email) DO UPDATE SET
       active = true,
       reason = CASE WHEN excluded.reason = 'bounce' THEN suppressions.reason ELSE excluded.reason END,
       note = CASE WHEN excluded.reason = 'bounce' THEN suppressions.note ELSE excluded.note END,
       updated_at = CASE WHEN excluded.reason = 'bounce' THEN suppressions.updated_at ELSE now() END`,
    [
      crypto.randomUUID(),
      normalized,
      input.email.trim(),
      input.reason,
      prospect.rows[0]?.id ?? null,
      input.note?.trim() || null,
    ],
  );
  if (prospect.rows[0]?.id && input.reason !== "bounce") {
    await db.query(
      `UPDATE prospects SET do_not_contact = true, status = 'lost', updated_at = now() WHERE id = $1`,
      [prospect.rows[0].id],
    );
  }
  await db.query(
    `INSERT INTO audit_log
      (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1, 'founder', $2, 'suppression.added', 'email', $3, $4::jsonb)`,
    [
      crypto.randomUUID(),
      input.userId,
      normalized,
      JSON.stringify({ reason: input.reason }),
    ],
  );
}

export async function listSuppressions() {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT * FROM suppressions ORDER BY updated_at DESC LIMIT 200`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    email: row.email,
    reason: row.reason,
    source: row.source,
    note: row.note,
    active: Boolean(row.active),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  }));
}
