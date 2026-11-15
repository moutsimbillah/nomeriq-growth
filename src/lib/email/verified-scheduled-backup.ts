import type { BackupReceipt } from "./sync-journal";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";

const verifiedReceipts = new WeakSet<object>();
const issuedAt = new WeakMap<object, number>();

/**
 * The receipt object returned by the filesystem/listing verifier is a capability, not a JSON fact.
 * Keeping identity in a closed WeakSet means parsing, spreading, or deserializing the public shape
 * cannot grant the scheduled-run capability.
 */
export async function issueVerifiedBackupReceipt(input: BackupReceipt): Promise<BackupReceipt> {
  // No caller-supplied filesystem/process dependencies: importing this issuer cannot
  // turn a JSON assertion into authority. Tests mock only the actual OS boundary.
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("backup_receipt_invalid");
  // Own the primitive metadata before the first await; callers cannot change what was verified.
  const receipt = Object.freeze({ kind: input.kind, verified: input.verified, path: input.path,
    sizeBytes: input.sizeBytes, tableDataCount: input.tableDataCount, verifiedAt: input.verifiedAt,
    mode: input.mode, fileMode: input.fileMode, sha256: input.sha256 });
  if (receipt.kind !== "pg_dump" || receipt.verified !== true
    || typeof receipt.path !== "string" || !/^\/var\/backups\/growth\/deploy-\d{8}T\d{6}Z\.dump$/.test(receipt.path)
    || !Number.isSafeInteger(receipt.sizeBytes) || receipt.sizeBytes < 1024
    || !Number.isSafeInteger(receipt.tableDataCount) || receipt.tableDataCount < 50
    || typeof receipt.verifiedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(receipt.verifiedAt)
    || !Number.isFinite(Date.parse(receipt.verifiedAt))
    || new Date(receipt.verifiedAt).toISOString().slice(0, 19) !== receipt.verifiedAt.slice(0, 19)
    || (receipt.mode !== "600" && receipt.fileMode !== 0o600)
    || (receipt.mode !== undefined && receipt.mode !== "600")
    || (receipt.fileMode !== undefined && receipt.fileMode !== 0o600)
    || (receipt.sha256 !== undefined && (typeof receipt.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.sha256)))) throw new Error("backup_receipt_invalid");
  const before = await fs.lstat(receipt.path);
  const uid = process.getuid?.();
  const age = Date.now() - Date.parse(receipt.verifiedAt);
  const mtimeAge = Date.now() - before.mtimeMs;
  if (!Number.isSafeInteger(uid) || !uid || before.uid !== uid) throw new Error("backup_owner_invalid");
  if ((before.mode & constants.S_IFMT) !== constants.S_IFREG || before.nlink !== 1
    || (before.mode & 0o777) !== 0o600 || before.size < 1024 || before.size !== receipt.sizeBytes) throw new Error("backup_file_invalid");
  if (!Number.isFinite(age) || age < 0 || age > 300_000 || mtimeAge < 0 || mtimeAge > 300_000
    || before.mtimeMs > Date.parse(receipt.verifiedAt) + 1000) throw new Error("backup_receipt_stale");
  if (await fs.realpath(receipt.path) !== receipt.path) throw new Error("backup_not_canonical");
  const listing = childProcess.execFileSync("pg_restore", ["--list", receipt.path], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const count = listing.split(/\r?\n/).filter(line => /\bTABLE DATA\b/.test(line) && !line.trimStart().startsWith(";")).length;
  if (count < 50 || count !== receipt.tableDataCount) throw new Error("backup_contents_invalid");
  if (receipt.sha256 && createHash("sha256").update(await fs.readFile(receipt.path)).digest("hex") !== receipt.sha256) throw new Error("backup_hash_invalid");
  const after = await fs.lstat(receipt.path);
  if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs
    || after.mode !== before.mode || after.uid !== before.uid || after.nlink !== before.nlink) throw new Error("backup_changed_during_verification");
  const capability: BackupReceipt = Object.freeze({ kind: "pg_dump", verified: true,
    path: receipt.path, sizeBytes: receipt.sizeBytes, tableDataCount: receipt.tableDataCount,
    verifiedAt: receipt.verifiedAt, mode: "600",
    ...(receipt.sha256 ? { sha256: receipt.sha256 } : {}) });
  verifiedReceipts.add(capability);
  issuedAt.set(capability, Date.now());
  return capability;
}

export function assertVerifiedBackupReceipt(receipt: BackupReceipt | undefined): void {
  const created = receipt ? issuedAt.get(receipt) : undefined;
  if (!receipt || !verifiedReceipts.has(receipt) || created === undefined || Date.now() < created || Date.now() - created > 300_000) {
    throw new Error("scheduled mailbox runs require an actual verified backup receipt capability");
  }
}
