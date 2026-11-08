import { closeDb, getDb } from "../src/lib/db/client";
import { scanProspectDuplicates } from "../src/lib/services/duplicate-audit";

// Run only after migration034 via the approved runner. This command never applies migrations.
async function main() {
  if (!process.env.DATABASE_URL?.trim() && !process.env.PGLITE_DIR?.trim()) {
    throw new Error("Specify the intended database explicitly; refusing the default local database.");
  }
  process.env.AUTO_MIGRATE = "false";
  const db = await getDb();
  try {
    const pairs = await db.transaction(async tx => {
      await tx.query("SET TRANSACTION READ ONLY");
      return scanProspectDuplicates(tx);
    });
    console.log(JSON.stringify({ pairs: pairs.length, affectedLeads: new Set(pairs.flatMap(p => [p.prospectId,p.otherProspectId])).size,
      ...(process.argv.includes("--details") ? { matches: pairs } : {}) }, null, 2));
  } finally { await closeDb(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Duplicate audit failed."); process.exitCode=1; });
