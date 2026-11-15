import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueVerifiedBackupReceipt, assertVerifiedBackupReceipt } from "@/lib/email/verified-scheduled-backup";
import { mockScheduledBackupFacts } from "./helpers/scheduled-backup-facts";
import type { BackupReceipt } from "@/lib/email/sync-journal";

let restore: () => void;
beforeEach(() => { restore = mockScheduledBackupFacts(); });
afterEach(() => { restore(); vi.restoreAllMocks(); });
const receipt = (): BackupReceipt => ({ kind: "pg_dump", verified: true,
  path: "/var/backups/growth/deploy-20261114T120000Z.dump", sizeBytes: 2048,
  tableDataCount: 50, mode: "600", verifiedAt: new Date().toISOString() });

describe("non-forgeable scheduled backup verifier", () => {
  it.each([
    { kind: "other" }, { verified: false }, { tableDataCount: "50" },
    { tableDataCount: 49 }, { tableDataCount: 50.5 }, { tableDataCount: Infinity },
    { sizeBytes: "2048" }, { sizeBytes: 2048.5 }, { sizeBytes: 1023 },
    { mode: "644" }, { mode: undefined, fileMode: undefined },
    { mode: "600", fileMode: 0o644 }, { mode: undefined, fileMode: "384" },
    { verifiedAt: 1 }, { verifiedAt: "not-a-date" }, { path: {} },
    { sha256: "not-a-hash" }, { sha256: 1 },
  ])("rejects semantically false metadata at the issuer before OS work: %j", async (fields) => {
    await expect(issueVerifiedBackupReceipt({ ...receipt(), ...fields } as unknown as BackupReceipt)).rejects.toThrow("backup_receipt_invalid");
    expect(fs.lstat).not.toHaveBeenCalled();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });
  it("rejects null and arrays and never promotes unknown caller fields into a capability", async () => {
    for (const value of [null, [], undefined]) await expect(issueVerifiedBackupReceipt(value as unknown as BackupReceipt)).rejects.toThrow("backup_receipt_invalid");
    expect(fs.lstat).not.toHaveBeenCalled();
    const capability = await issueVerifiedBackupReceipt({ ...receipt(), callerMetadata: "synthetic-extra" } as BackupReceipt);
    expect(capability).not.toHaveProperty("callerMetadata");
    expect(() => assertVerifiedBackupReceipt(capability)).not.toThrow();
  });
  it("accepts numeric file mode only after verifying it and emits canonical metadata", async () => {
    const capability = await issueVerifiedBackupReceipt({ ...receipt(), mode: undefined, fileMode: 0o600 });
    expect(capability.mode).toBe("600");
    expect(capability).not.toHaveProperty("fileMode");
    expect(() => assertVerifiedBackupReceipt(capability)).not.toThrow();
  });
  it("binds the verified metadata snapshot despite caller mutation during an OS await", async () => {
    const input = receipt();
    const expected = { ...input };
    const facts = await fs.lstat(input.path);
    vi.mocked(fs.lstat).mockClear();
    vi.mocked(fs.lstat).mockResolvedValueOnce(facts).mockImplementationOnce(async () => {
      Object.assign(input, { path: "/unverified/other.dump", tableDataCount: 0, verified: false });
      return facts;
    });
    const capability = await issueVerifiedBackupReceipt(input);
    expect(capability).toEqual(expected);
    expect(input.path).toBe("/unverified/other.dump");
    expect(() => assertVerifiedBackupReceipt(capability)).not.toThrow();
  });
  it("requires real OS verification even when called directly with a plausible JSON receipt", async () => {
    vi.mocked(fs.lstat).mockRejectedValueOnce(new Error("fixture_file_absent"));
    await expect(issueVerifiedBackupReceipt(receipt())).rejects.toThrow("fixture_file_absent");
    expect(() => assertVerifiedBackupReceipt(receipt())).toThrow("capability");
  });
  it("issues only frozen identity-backed capabilities, never parsed or spread copies", async () => {
    const capability = await issueVerifiedBackupReceipt(receipt());
    expect(Object.isFrozen(capability)).toBe(true);
    expect(() => assertVerifiedBackupReceipt(capability)).not.toThrow();
    expect(() => assertVerifiedBackupReceipt({ ...capability })).toThrow("capability");
    expect(() => assertVerifiedBackupReceipt(JSON.parse(JSON.stringify(capability)))).toThrow("capability");
  });
  it("refuses a failed producer even if it emitted a plausible listing before failure", async () => {
    vi.mocked(childProcess.execFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("fixture_producer_failed"), { stdout: "x TABLE DATA 1\n".repeat(50), status: 1 });
    });
    await expect(issueVerifiedBackupReceipt(receipt())).rejects.toThrow("fixture_producer_failed");
  });
  it("refuses hard links, symlinks and the wrong owner before issuing authority", async () => {
    for (const extra of [{ nlink: 2 }, { mode: 0o120600 }, { uid: 9999 }]) {
      vi.mocked(fs.lstat).mockResolvedValueOnce({ mode: 0o100600, size: 2048, nlink: 1, uid: 1000, ino: 1, mtimeMs: Date.now() - 1000, ...extra } as never);
      await expect(issueVerifiedBackupReceipt(receipt())).rejects.toThrow(/backup_(file|owner)_invalid/);
    }
  });
  it("refuses canonical-path mismatch and an incomplete listing", async () => {
    vi.mocked(fs.realpath).mockResolvedValueOnce("/other/dump" as never);
    await expect(issueVerifiedBackupReceipt(receipt())).rejects.toThrow("backup_not_canonical");
    vi.mocked(childProcess.execFileSync).mockReturnValueOnce("x TABLE DATA 1\n" as never);
    await expect(issueVerifiedBackupReceipt(receipt())).rejects.toThrow("backup_contents_invalid");
  });
  it("refuses stale or future receipt timestamps", async () => {
    for (const offset of [-300001, 10000]) {
      await expect(issueVerifiedBackupReceipt({ ...receipt(), verifiedAt: new Date(Date.now() + offset).toISOString() })).rejects.toThrow("backup_receipt_stale");
    }
  });
  it("rejects an expired capability rather than trusting its issued flag forever", async () => {
    const now = Date.now();
    const capability = await issueVerifiedBackupReceipt(receipt());
    vi.spyOn(Date, "now").mockReturnValue(now + 310000);
    expect(() => assertVerifiedBackupReceipt(capability)).toThrow("capability");
  });
});
