/**
 * Vitest configuration.
 *
 * This file deliberately does not import `vitest/config`. Vite resolves an
 * imported TypeScript config by spawning a child process, which is blocked under
 * a confined Windows sandbox (`spawn EPERM`). A dependency-free config loads in
 * that environment. The `threads` pool is also required there, because the
 * default `forks` pool uses `child_process.fork`, which is likewise blocked.
 *
 * The `@/` alias must be percent-decoded: on a workspace path containing a
 * space, an encoded pathname does not resolve.
 */
const srcDir = decodeURIComponent(
  new URL("./src/", import.meta.url).pathname,
).replace(/^\/([A-Za-z]:)/, "$1");

export default {
  resolve: {
    alias: [
      { find: /^@\//, replacement: srcDir.endsWith("/") ? srcDir : `${srcDir}/` },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    pool: "threads",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 45_000,
    hookTimeout: 45_000,
  },
};
