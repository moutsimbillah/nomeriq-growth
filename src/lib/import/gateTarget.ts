/**
 * Refuse to point the application's own code at anything but the dry-run copy.
 *
 * Learned the hard way: a host-and-port rewrite of the live connection string left the database name intact,
 * so the gate test ran against the live database inside its rolled-back transaction. Rewriting the host is
 * not choosing a target. This guard makes that impossible rather than unlikely, and the gate test calls it
 * before it opens a connection.
 */

export const DRY_RUN_DATABASE = "growth_import_dryrun";
const LIVE_DATABASE = "growth";

export function databaseNameOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\/+/, "").trim();
  } catch {
    return "";
  }
}

export function assertDryRunTarget(url: string | undefined | null): string {
  if (!url || !url.trim()) {
    throw new Error("legacy gate: no connection string given, refusing to run");
  }
  const name = databaseNameOf(url);
  if (name === LIVE_DATABASE) {
    throw new Error(
      `legacy gate: refusing to run against the live database "${LIVE_DATABASE}"`,
    );
  }
  if (name !== DRY_RUN_DATABASE) {
    throw new Error(
      `legacy gate: refusing to run against "${name || "(no database named)"}"; expected ${DRY_RUN_DATABASE}`,
    );
  }
  return url;
}
