/**
 * Build identity.
 *
 * The values are captured when `next build` runs (see `next.config.ts`) and inlined into the
 * server bundle, so they describe the build that is actually serving traffic — not whatever
 * happens to be checked out in the working tree at request time. That distinction is the whole
 * point: `git rev-parse HEAD` on the server proves only what is on disk, and a checkout that
 * never got built looks identical to a deployed one.
 *
 * Falls back to "unknown" so a build without git (or without the repository) still succeeds.
 */
export type BuildInfo = {
  /** Short commit the running build was compiled from, or "unknown". */
  commit: string;
  /** ISO timestamp of the build, or "unknown". */
  builtAt: string;
};

export function buildInfo(): BuildInfo {
  return {
    commit: process.env.BUILD_COMMIT || "unknown",
    builtAt: process.env.BUILD_TIME || "unknown",
  };
}
