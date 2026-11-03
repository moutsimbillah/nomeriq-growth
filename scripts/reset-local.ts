import { config } from "dotenv";
import { resetLocalDatabaseFiles } from "../src/lib/db/client";

config({ path: ".env.local" });

async function main() {
  if (process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is set. This command only resets the local PGlite development database; it refuses to touch a remote database.",
    );
  }
  await resetLocalDatabaseFiles();
  console.log("Local development database removed. Run `npm run db:seed` to rebuild it.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
