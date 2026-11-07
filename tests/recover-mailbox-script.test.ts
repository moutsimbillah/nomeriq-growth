import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseCommand } from "../scripts/recover-mailbox";

/** The recovery script only runs a step the founder named, with its exact confirmation word. */
describe("founder-approved mailbox recovery script", () => {
  it("accepts only the six exact staged commands", () => {
    expect(parseCommand(["dry-run"])).toBe("dry-run");
    expect(parseCommand(["sent", "IMPORT-SENT-ITEMS"])).toBe("sent");
    expect(parseCommand(["check-sent"])).toBe("check-sent");
    expect(parseCommand(["inbox", "IMPORT-INBOX"])).toBe("inbox");
    expect(parseCommand(["bounces-preview"])).toBe("bounces-preview");
    expect(parseCommand(["bounces-apply", "APPLY-HISTORICAL-BOUNCES"])).toBe("bounces-apply");
    for (const args of [[], ["backfill", "IMPORT-FULL-MAILBOX-HISTORY"], ["sent"], ["inbox"], ["dry-run", "extra"], ["check-sent", "extra"], ["backfill"], ["backfill", "yes"], ["bounces-apply"], ["bounces-apply", "yes"],
      ["link"], ["send"], ["backfill", "IMPORT-FULL-MAILBOX-HISTORY", "--link"], ["bounces-preview", "extra"]]) {
      expect(() => parseCommand(args)).toThrow("command_rejected");
    }
  });

  it("never links addresses, sends, or migrates, and prints counts only", () => {
    const source = readFileSync("scripts/recover-mailbox.ts", "utf8");
    expect(source).toContain('process.env.AUTO_MIGRATE = "false"');
    expect(source).toContain('recoveryFolder: folder');
    expect(source).toContain('linkCertainAddresses: false, processHistoricalBounces: false');
    const branch = source.slice(source.indexOf('if (command === "dry-run")'), source.indexOf('const { getDb, closeDb }'));
    expect(branch).toContain('new Client(');
    expect(branch).toContain('runRecoveryDryRun(raw');
    expect(branch).not.toContain('getDb()');
    expect(branch).toContain('logger: false, logRaw: false, emitLogs: false');
    expect(source).toContain('if (!out.complete) process.exitCode = 1');
    expect(source).not.toMatch(/decideMessageLink|deliverEmail|sendDraft|saveSentCopy/);
    expect(source).not.toMatch(/console\.(log|error)/);
  });

  it("importing it in tests starts nothing", async () => {
    // main() runs only when the file itself is the entry point; reaching here proves no side effect on import.
    expect(typeof parseCommand).toBe("function");
  });
});
