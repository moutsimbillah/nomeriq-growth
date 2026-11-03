import { config } from "dotenv";
import { getDb, closeDb } from "../src/lib/db/client";

config({ path: ".env.local" });

async function main() {
  process.env.AUTO_MIGRATE = "true";
  const db = await getDb();
  const result = await db.query<{ id: string; applied_at: string }>(
    "SELECT id, applied_at FROM _migrations ORDER BY id",
  );
  console.log("Migrations applied:");
  for (const row of result.rows) {
    console.log(`  ${row.id} — ${row.applied_at}`);
  }
  console.log(
    process.env.DATABASE_URL
      ? "Target: remote PostgreSQL / Supabase"
      : "Target: local embedded Postgres (PGlite)",
  );
  await closeDb();
}

main().catch(async (error) => {
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exitCode = 1;
});
