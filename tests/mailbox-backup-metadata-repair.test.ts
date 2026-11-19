import childProcess from "node:child_process";
import { describe, expect, it } from "vitest";
import path from "node:path";
import { userInfo } from "node:os";

const python = process.env.PYTHON ?? "python3";
const harness = path.resolve(process.cwd(), "tests/fixtures/mailbox_backup_repair_cases.py");
const script = path.resolve(process.cwd(), "scripts/repair-mailbox-backup-metadata.py");

describe("Linux mailbox backup metadata repair filesystem harness", () => {
  it.skipIf(process.platform !== "linux" || userInfo().uid !== 0)("executes the actual repair module against real isolated POSIX filesystems", () => {
    const result = childProcess.spawnSync(python, [harness, script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 120_000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
