import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const source = readFileSync("scripts/deploy.sh", "utf8");
const functions = source.slice(source.indexOf("checkout() {"), source.indexOf("\nrestart() {"));
function run(action: "prepare" | "build", options: { backup?: number; dependencies?: number; migration?: number } = {}) {
  // Execute only the actual orchestration functions; every external operation is replaced by a
  // shell function. No sudo, network, database, service, checkout or .next write is executed.
  const input = `set -eu
APP=synthetic-unused-path
say() { printf '%s\\n' "$1"; }
dump() { printf 'BACKUP_VERIFIED\\n'; return ${options.backup ?? 0}; }
git_as_growth() { printf 'GIT:%s\\n' "$1"; }
as_growth() {
  case "$1" in
    *'rev-parse'*) printf 'synthetic-sha\\n' ;;
    *'diff --quiet'*) return ${options.dependencies ?? 0} ;;
    *'status --porcelain'*) printf '0\\n' ;;
    *'diff --name-only'*) : ;;
    *) printf 'EXEC:%s\\n' "$1" ;;
  esac
}
require_migrations_applied() { printf 'LEDGER_CHECK\\n'; return ${options.migration ?? 0}; }
${functions}
${action}
`;
  return spawnSync("bash", ["--noprofile", "--norc", "-s"], { input, encoding: "utf8" });
}
it("the deployment script is valid shell syntax", () => {
  const result = spawnSync("bash", ["-n"], { input: source, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
});
it("prepare verifies the backup and stages source without building or restarting", () => {
  const result = run("prepare");
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.indexOf("BACKUP_VERIFIED")).toBeLessThan(result.stdout.indexOf("GIT:fetch"));
  expect(result.stdout).toContain("PREPARED commit=synthetic-sha");
  expect(result.stdout).not.toContain("EXEC:");
  expect(result.stdout).not.toContain("BUILD_DONE");
});
it("a failed backup prevents every checkout action", () => {
  const result = run("prepare", { backup: 8 });
  expect(result.status).toBe(8);
  expect(result.stdout).not.toContain("GIT:");
});
it("prepare refuses a dependency change before resetting the checkout", () => {
  const result = run("prepare", { dependencies: 1 });
  expect(result.status).toBe(7);
  expect(result.stdout).not.toContain("GIT:reset");
});
it("build refuses missing migrations before writing the build directory", () => {
  const result = run("build", { migration: 4 });
  expect(result.status).toBe(4);
  expect(result.stdout).toContain("LEDGER_CHECK");
  expect(result.stdout).not.toContain("EXEC:");
  expect(result.stdout).not.toContain("BUILD_DONE");
});
