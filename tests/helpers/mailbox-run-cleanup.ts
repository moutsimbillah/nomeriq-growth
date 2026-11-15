import type { DbClient } from "@/lib/db/client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Remove only retained scheduler rows belonging to the supplied synthetic accounts. */
export async function cleanupMailboxRuns(db: DbClient, accountIds: readonly string[]): Promise<void> {
  if (process.env.NODE_ENV !== "test" || process.env.DATABASE_URL?.trim()
    || !process.env.PGLITE_DIR?.startsWith(".data/test-vitest-")) {
    throw new Error("cleanupMailboxRuns is restricted to isolated Vitest PGlite fixtures");
  }
  if (accountIds.length === 0 || accountIds.some((id) => !UUID.test(id))) {
    throw new Error("cleanupMailboxRuns requires non-empty UUID account scope");
  }
  const ids = [...new Set(accountIds)];
  await db.transaction(async tx => {
  await tx.query(
    `DELETE FROM mailbox_sync_journal
      WHERE run_id IN (SELECT id FROM mailbox_sync_runs WHERE account_id = ANY($1::uuid[]))`,
    [ids],
  );
  await tx.query(`DELETE FROM mailbox_sync_leases WHERE account_id = ANY($1::uuid[])`, [ids]);
  await tx.query(`DELETE FROM mailbox_sync_runs WHERE account_id = ANY($1::uuid[])`, [ids]);
  });
}
