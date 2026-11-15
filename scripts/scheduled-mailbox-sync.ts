#!/usr/bin/env node

const APP_ROOT = "/home/growth/app";

async function run() {
  if (process.argv.length !== 2 || process.platform !== "linux" || process.env.NODE_ENV !== "production") {
    process.stderr.write("scheduled mailbox sync refused\n");
    process.exitCode = 2;
    return;
  }
  process.chdir(APP_ROOT);
  const { main } = await import("../src/lib/email/scheduled-sync");
  process.exitCode = await main([]);
}

run().catch(() => {
  process.stderr.write("scheduled mailbox sync failed\n");
  process.exitCode = 1;
});
