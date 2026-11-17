#!/usr/bin/env node

const APP_ROOT = "/home/growth/app";

async function run() {
  const argv = process.argv.slice(2);
  if ((argv.length !== 0 && !(argv.length === 2 && argv[0] === "undo")) || process.platform !== "linux" || process.env.NODE_ENV !== "production") {
    process.stderr.write("scheduled mailbox sync refused\n");
    process.exitCode = 2;
    return;
  }
  process.chdir(APP_ROOT);
  const { main } = await import("../src/lib/email/scheduled-sync");
  process.exitCode = await main(argv);
}

run().catch(() => {
  process.stderr.write("scheduled mailbox sync failed\n");
  process.exitCode = 1;
});
