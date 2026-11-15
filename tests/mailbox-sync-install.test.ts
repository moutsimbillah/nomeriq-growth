import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const installer = join(root, "scripts", "install-mailbox-sync.sh");
const storage = join(root, "scripts", "mailbox-sync-storage-check.sh");
const wrapper = join(root, "scripts", "growth-cron-sync.sh");

function bash(script: string) {
  try { return { status: 0, output: execFileSync("bash", ["-c", script], { cwd: root, encoding: "utf8" }) }; }
  catch (e) { const x = e as { status?: number; stdout?: string; stderr?: string }; return { status: x.status ?? 1, output: `${x.stdout ?? ""}${x.stderr ?? ""}` }; }
}
function source(path: string, body: string) { return bash(`source ${JSON.stringify(path)}; set +e; sudo(){ printf UNEXPECTED_PRIVILEGED_CALL >&2; return 97; }; systemctl(){ printf UNEXPECTED_SERVICE_CALL >&2; return 97; }; ${body}`); }

describe("mailbox operational package", () => {
  it("syntax-checks all new shell bodies and pins the fixed operational surface", () => {
    expect(bash(`bash -n ${JSON.stringify(installer)} ${JSON.stringify(storage)} ${JSON.stringify(wrapper)}`).status).toBe(0);
    const unit = readFileSync(join(root, "scripts/systemd/growth-mailbox-sync.service"), "utf8");
    const timer = readFileSync(join(root, "scripts/systemd/growth-mailbox-sync.timer"), "utf8");
    expect(unit).toContain("ExecStartPre=/usr/local/lib/growth-mailbox-sync/mailbox-sync-storage-check.sh");
    expect(unit).toContain("ExecStart=/usr/local/lib/growth-mailbox-sync/growth-cron-sync.sh");
    expect(unit).toContain("OnFailure=growth-cron-alert.service");
    expect(unit).toContain("TimeoutStartSec=300");
    expect(timer).toContain("OnActiveSec=15min");
    expect(timer).toContain("OnUnitInactiveSec=15min");
    expect(readFileSync(installer, "utf8")).toContain("EXPECTED_DEPLOY_SHA=a8cc605ca1dfe323f1b3b7ce1d123e1ae3f8197268fc9339399b2d37b593f8c6");
  });

  it("rejects wrong release SHA and dirty checkout before any installer write", () => {
    const wrong = source(installer, "root_only(){ :; }; require_installer_trust(){ :; }; git_growth(){ return 1; }; main install 0000000000000000000000000000000000000000");
    expect(wrong.status).not.toBe(0);
    expect(wrong.output).toContain("release SHA is not present");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const dirty = source(installer, `root_only(){ :; }; require_installer_trust(){ :; }; git_growth(){ case "$1 $2" in 'rev-parse --verify') return 0;; 'rev-parse HEAD') printf '${head}';; 'status --porcelain') printf ' M fixture';; *) return 99;; esac; }; main install ${head}`);
    expect(dirty.status).not.toBe(0);
    expect(dirty.output).toMatch(/checkout is dirty|release SHA is not present/);
  });

  it("refuses an unmanaged collision and keeps a different file untouched", () => {
    const result = bash(`source ${JSON.stringify(installer)}; set +e; d=$(mktemp -d); printf old >"$d/target"; printf new >"$d/source"; assert_managed_or_absent "$d/target" "$d/source"; status=$?; printf 'status=%s bytes=%s\\n' "$status" "$(cat "$d/target")"; rm -rf "$d"`);
    expect(result.status).toBe(0);
    expect(result.output).toContain("status=1 bytes=old");
  });

  it("enforces storage headroom and the 1000-backup bound using pure facts", () => {
    const result = source(storage, "for f in '2097152 1000' '2097151 1000' '2097152 1001'; do set -- $f; if check_facts $1 $2; then echo OK; else echo REFUSED; fi; done");
    expect(result.status).toBe(0);
    expect(result.output.match(/^OK$/gm)?.length).toBe(1);
    expect(result.output.match(/^REFUSED$/gm)?.length).toBe(2);
    expect(readFileSync(storage, "utf8")).toContain("target=\"$BACKUP_DIR/deploy-$(date -u +%Y%m%dT%H%M%SZ).dump\"");
  });

  it("keeps backup failure before CLI dispatch in the actual wrapper control flow", () => {
    const result = source(wrapper, `record_failure(){ printf 'FAIL code=%s\\n' "$1"; }; require_wrapper_integrity(){ :; }; require_deploy_integrity(){ :; }; require_cli(){ :; }; take_backup(){ return 1; }; dispatch_cli(){ echo BAD_DISPATCH; }; run_once; printf 'status=%s\\n' "$?"`);
    expect(result.status).toBe(0);
    expect(result.output).not.toContain("BAD_DISPATCH");
    expect(result.output).toContain("backup_failed");
  });

  it("requires first-sync success and loaded alert before enable, and quarantines by rename", () => {
    const text = readFileSync(installer, "utf8");
    expect(text).toContain('trusted_file "$RUNTIME_DIR/first-sync.ok"');
    expect(text).toContain('-p LoadState --value)" == loaded');
    expect(text).toContain('mv -T -n -- "$RUNTIME_DIR" "$dest/runtime"');
    expect(text).toContain('mv -T -n -- "$UNIT_DIR/$unit" "$dest/$unit"');
    expect(text).toContain('unit_is_release_prefix');
    expect(text).not.toContain("rm -rf -- \"$RUNTIME_DIR\"");
  });

  it("does not embed environment files, credentials, deletion, upload, or billing actions", () => {
    const all = readFileSync(installer, "utf8") + readFileSync(storage, "utf8");
    expect(all).not.toMatch(/\.env\.production|DATABASE_URL|password|secret|aws|s3|billing/);
    expect(all).not.toMatch(/rm\s+-rf\s+--\s+\"\$BACKUP_DIR/);
  });
});
