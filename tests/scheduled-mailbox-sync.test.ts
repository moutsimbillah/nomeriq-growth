import { describe, expect, it, vi } from "vitest";
import { beforeEach, afterEach } from "vitest";
import { mockScheduledBackupFacts } from "./helpers/scheduled-backup-facts";
import { parseScheduledReceipt, runScheduledMailboxSync, type ScheduledSyncDeps } from "@/lib/email/scheduled-sync";

const receiptNow = new Date();
let restoreFacts: () => void;
beforeEach(() => { restoreFacts = mockScheduledBackupFacts(); });
afterEach(() => restoreFacts());
const receipt = parseScheduledReceipt(JSON.stringify({
  kind: "pg_dump", verified: true,
  path: "/var/backups/growth/deploy-20261114T120000Z.dump",
  sizeBytes: 2048, tableDataCount: 50,
  verifiedAt: receiptNow.toISOString(), mode: "600",
}));

function deps(overrides: Partial<ScheduledSyncDeps> = {}): ScheduledSyncDeps {
  return {
    platform: "linux", now: () => receiptNow.getTime(), readStdin: async () => "",
    readFile: async () => "", lstat: async () => ({ mode: 0o100600, size: 2048, nlink: 1, uid: 1000, mtimeMs: receiptNow.getTime() }),
    realpath: async (file) => file,
    execFile: async () => ({ stdout: Array.from({ length: 50 }, (_, i) => `x TABLE DATA ${i}`).join("\n"), stderr: "" }),
    initializeDb: vi.fn(async () => { throw new Error("DB MUST NOT INITIALIZE"); }),
    appRoot: "/test",
    currentUid: () => 1000,
    ...overrides,
  };
}

describe("private scheduled mailbox CLI integration", () => {
  it("rejects malformed and secret-bearing receipts without exposing input", () => {
    expect(() => parseScheduledReceipt("not-json")).toThrow("receipt_malformed");
    expect(() => parseScheduledReceipt(JSON.stringify({ ...receipt, path: "/tmp/secret" }))).toThrow("receipt_invalid");
  });

  it("verifies the filesystem before database initialization", async () => {
    const initialize = vi.fn();
    await expect(runScheduledMailboxSync(receipt, deps({
      lstat: async () => { throw new Error("symlink"); },
      initializeDb: initialize as ScheduledSyncDeps["initializeDb"],
    }))).rejects.toThrow("symlink");
    expect(initialize).not.toHaveBeenCalled();
  });

  it("rejects a producer listing whose count is not the exact receipt", async () => {
    const initialize = vi.fn();
    await expect(runScheduledMailboxSync(receipt, deps({
      execFile: async () => ({ stdout: "x TABLE DATA 1\n", stderr: "private provider text" }),
      initializeDb: initialize as ScheduledSyncDeps["initializeDb"],
    }))).rejects.toThrow("backup_contents_invalid");
    expect(initialize).not.toHaveBeenCalled();
  });

  it("dispatches one scheduled incremental account and reads back completion", async () => {
    let status = "running";
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("information_schema")) return { rows: [{ exists: true }], rowCount: 1 };
        if (sql.includes("workspace_settings")) return { rows: [{ id: "default" }], rowCount: 1 };
        if (sql.includes("FROM email_accounts")) return { rows: [{ id: "acct-1", status: "connected" }], rowCount: 1 };
        if (sql.includes("FROM mailbox_sync_runs")) return { rows: [{ status }], rowCount: 1 };
        if (sql.includes("FROM mailbox_sync_state")) return { rows: [{ folder: "INBOX" }, { folder: "Sent" }], rowCount: 2 };
        return { rows: [], rowCount: 0 };
      }),
      exec: vi.fn(), transaction: vi.fn(), close: vi.fn(),
    } as never;
    const result = await runScheduledMailboxSync(receipt, deps({
      initializeDb: async () => db,
      startRun: async () => ({ id: "run-1", accountId: "acct-1", mode: "scheduled", fence: 1, leaseOwner: "owner-1" }),
      syncAccount: async (_accountId, options) => {
        expect(options?.mode).toBe("incremental");
        expect(options?.executionContext?.mode).toBe("scheduled");
        return { accountId: "acct-1", imported: 2, skipped: 1, errors: [], historyIncomplete: false, folders: [] };
      },
      finishRun: async () => { status = "completed"; },
    }));
    expect(result).toMatchObject({ accountId: "acct-1", runId: "run-1", imported: 2, skipped: 1, folders: 2 });
  });
});
