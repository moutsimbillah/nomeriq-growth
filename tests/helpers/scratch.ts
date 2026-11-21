import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One shared resolver for the scratch directory the mailbox fixtures build in.
 *
 * `TMPDIR` used to be read directly at module scope, and these suites threw when
 * it was unset. That made them green only in a shell (an agent profile) that
 * happens to export `TMPDIR`, and red on a clean CI runner — a harness
 * assumption, not a product requirement, so it may not fail the suite any more.
 * `TMPDIR` stays a supported override; when it is absent or blank the OS temp
 * directory (`os.tmpdir()`) is used instead.
 *
 * What the fixtures genuinely require of the resolved directory is small and
 * real: it must exist, be a directory, be writable, and be able to host a
 * same-directory rename. Every fixture keeps its pending file and its rename
 * target as siblings inside one `mkdtempSync` directory, and the code under test
 * publishes with `mv -T -n` — a no-replace rename that refuses a cross-device
 * move. Because both ends of that rename always live in the same fixture
 * directory, the rename stays on one device wherever the scratch lives; the
 * scratch itself is never renamed across, so it does not have to share the
 * repository's device. The real requirement is therefore verified functionally
 * (the probe below) rather than asserted as scratch-device === repo-device,
 * which on a Windows host legitimately differs (repo on one drive, os.tmpdir()
 * on another) and would otherwise reject a perfectly usable scratch for the
 * wrong reason. The repo path and device are named in the failure message for
 * diagnosis.
 */

let cached: string | undefined;

/** Resolve (once) a scratch directory the mailbox fixtures can build in. */
export function resolveScratchDir(): string {
  if (cached === undefined) cached = assertUsableScratch(configuredScratch());
  return cached;
}

function configuredScratch(): string {
  const configured = process.env.TMPDIR?.trim();
  return configured ? configured : tmpdir();
}

function assertUsableScratch(dir: string): string {
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    throw new Error(
      `test scratch directory does not exist: ${dir} (set TMPDIR to a real directory, or leave it unset and provide a working os.tmpdir())`,
    );
  }
  if (!stat.isDirectory()) throw new Error(`test scratch path is not a directory: ${dir}`);

  // Prove writability and the same-directory no-replace rename the fixtures rely
  // on, instead of trusting TMPDIR or os.tmpdir() blindly.
  const probe = mkdtempSync(join(dir, "mailbox-scratch-probe-"));
  try {
    const pending = join(probe, ".pending.probe");
    writeFileSync(pending, "probe\n");
    renameSync(pending, join(probe, "published"));
  } catch (error) {
    const repo = process.cwd();
    throw new Error(
      "test scratch directory must let the mailbox fixtures create and rename files on one " +
        `filesystem: the code under test publishes with \`mv -T -n\`, which refuses a cross-device move. ` +
        `scratch=${dir} (device ${stat.dev}) repo=${repo} (device ${deviceOf(repo)}) failed at: ${(error as Error).message}`,
    );
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
  return dir;
}

function deviceOf(path: string): string {
  try {
    return String(statSync(path).dev);
  } catch {
    return "unavailable";
  }
}
