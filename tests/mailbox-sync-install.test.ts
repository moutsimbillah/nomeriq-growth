import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const installer = join(root, "scripts", "install-mailbox-sync.sh");
const storage = join(root, "scripts", "mailbox-sync-storage-check.sh");
const wrapper = join(root, "scripts", "growth-cron-sync.sh");
const bootstrap = join(root, "scripts", "bootstrap-mailbox-sync-installer.sh");

function bash(script: string, env: Record<string, string> = {}) {
  try { return { status: 0, output: execFileSync("bash", ["-c", script], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } }) }; }
  catch (e) { const x = e as { status?: number; stdout?: string; stderr?: string }; return { status: x.status ?? 1, output: `${x.stdout ?? ""}${x.stderr ?? ""}` }; }
}
function source(path: string, body: string) { return bash(`source ${JSON.stringify(path)}; set +e; sudo(){ printf UNEXPECTED_PRIVILEGED_CALL >&2; return 97; }; systemctl(){ printf UNEXPECTED_SERVICE_CALL >&2; return 97; }; ${body}`); }
function storageFixture() {
  const scratch = process.env.TMPDIR;
  if (!scratch) throw new Error("profile scratch required");
  const dir = mkdtempSync(join(scratch, "mailbox-storage-retention-"));
  const posix = execFileSync("bash", ["-c", 'cd "$FIXTURE" && pwd -P'], { env: { ...process.env, FIXTURE: dir }, encoding: "utf8" }).trim();
  const script = join(dir, "storage.sh");
  const body = readFileSync(storage, "utf8").replace("readonly BACKUP_DIR=/var/backups/growth", `readonly BACKUP_DIR="${posix}"`);
  writeFileSync(script, body);
  const fakeStat = `stat(){ if [[ "$1" == -c && "$2" == '%U:%G:%a:%h' ]]; then printf '%s\\n' growth:growth:600:1; return; fi; command stat "$@"; }`;
  return { dir, run: (command: string) => source(script, `${fakeStat}; ${command}`) };
}

function bootstrapFixture() {
  const scratch = process.env.TMPDIR;
  if (!scratch) throw new Error("profile scratch required");
  const dir = mkdtempSync(join(scratch, "mailbox-bootstrap-"));
  const repo = join(dir, "app");
  const stage = join(dir, "staged-installers");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  const repoNative = repo.replace(/\\/g, "/");
  const repoPosix = process.platform === "win32"
    ? execFileSync("bash", ["-c", 'cd "$(cygpath -u "$FIXTURE")" && pwd -P'], { env: { ...process.env, FIXTURE: repoNative }, encoding: "utf8" }).trim()
    : execFileSync("bash", ["-c", 'cd "$FIXTURE" && pwd -P'], { env: { ...process.env, FIXTURE: repo }, encoding: "utf8" }).trim();
  const stagePosix = process.platform === "win32"
    ? execFileSync("bash", ["-c", 'cygpath -u "$FIXTURE"'], { env: { ...process.env, FIXTURE: stage.replace(/\\/g, "/") }, encoding: "utf8" }).trim()
    : stage;
  const installerBytes = "#!/usr/bin/env bash\nprintf 'exact committed installer\\n'\n";
  writeFileSync(join(repo, "scripts", "install-mailbox-sync.sh"), installerBytes);
  let sourceBytes = readFileSync(bootstrap, "utf8");
  const replacements: Array<[string, string]> = [
    ["readonly APP_ROOT=/home/growth/app", `readonly APP_ROOT="${repoPosix}"`],
    ["readonly INSTALLER_ROOT=/home/ubuntu/growth-mailbox-install", `readonly INSTALLER_ROOT="${stagePosix}"`],
    ['git_growth() { sudo -n -u growth -- /usr/bin/git -C "$APP_ROOT" "$@"; }', 'git_growth() { git "$@"; }'],
    ['root_only() { [[ "$(id -u)" == 0 ]] || refuse "root is required"; }', 'root_only() { :; }'],
    ['actual_bootstrap=$(/usr/bin/git hash-object "$script")', 'actual_bootstrap=$(git hash-object "$script")'],
  ];
  for (const [before, after] of replacements) {
    if (!sourceBytes.includes(before)) throw new Error(`bootstrap fixture anchor missing: ${before}`);
    sourceBytes = sourceBytes.replace(before, after);
  }
  sourceBytes = sourceBytes.replaceAll("/usr/bin/git", "git");
  writeFileSync(join(repo, "scripts", "bootstrap-mailbox-sync-installer.sh"), sourceBytes);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "scripts"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Growth Fixture", "-c", "user.email=fixture@example.test", "commit", "-q", "-m", "fixture"], { cwd: repo });
  const release = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const bootstrapPosix = `${repoPosix}/scripts/bootstrap-mailbox-sync-installer.sh`;
  const events = join(dir, "events");
  const harness = `set -euo pipefail
source "$BOOTSTRAP"
git() { if [[ "$1" == hash-object ]]; then if command -v cygpath >/dev/null 2>&1; then command git hash-object "$(cygpath -w "$2")"; else command git hash-object "$2"; fi; else command git -C "$APP_NATIVE" "$@"; fi; }
git_growth() { git "$@"; }
root_only() { :; }
install() { local dest=''; while (($#)); do if [[ "$1" == -d ]]; then dest=$2; break; fi; shift; done; [[ -n "$dest" ]] || return 1; printf 'install:%s\\n' "$dest" >>"$EVENTS"; command mkdir -p "$dest"; }
chown() { printf 'chown:%s\\n' "$*" >>"$EVENTS"; return 0; }
chmod() { printf 'chmod:%s\\n' "$*" >>"$EVENTS"; return 0; }
stat() {
  if [[ "$1" == -c ]]; then
    case "$2" in
      '%U'|'%G') printf 'root\\n' ;;
      '%U:%G') printf 'root:root\\n' ;;
      '%a') if [[ "$3" == */INSTALLER-BLOB-SHA ]]; then printf '644\\n'; else printf '755\\n'; fi ;;
      '%h') printf '1\\n' ;;
      '%U:%G:%a') printf 'root:root:755\\n' ;;
      '%U:%G:%a:%h') printf 'root:root:644:1\\n' ;;
      *) command stat "$@" ;;
    esac
  else command stat "$@"; fi
}
`;
  function run(body: string) {
    return bash(`${harness}${body}`, { BOOTSTRAP: bootstrapPosix, APP_NATIVE: repoNative, RELEASE: release, EVENTS: events });
  }
  return { dir, repo, stage, release, installerBytes, events, run };
}

describe("mailbox operational package", () => {
  it("syntax-checks all new shell bodies and pins the fixed operational surface", () => {
    expect(bash(`for f in ${JSON.stringify(installer)} ${JSON.stringify(storage)} ${JSON.stringify(wrapper)}; do bash -n "$f" || exit; done`).status).toBe(0);
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

  it("stages only the exact committed installer bytes and is idempotent", () => {
    const f = bootstrapFixture();
    try {
      const result = f.run('main "$RELEASE"; main "$RELEASE"');
      expect(result.status, result.output).toBe(0);
      expect(result.output.match(/installer_staged/g)).toHaveLength(2);
      const staged = join(f.stage, f.release, "install-mailbox-sync.sh");
      const marker = join(f.stage, f.release, "INSTALLER-BLOB-SHA");
      const blob = execFileSync("git", ["rev-parse", `${f.release}:scripts/install-mailbox-sync.sh`], { cwd: f.repo, encoding: "utf8" }).trim();
      expect(readFileSync(staged, "utf8")).toBe(f.installerBytes);
      expect(readFileSync(marker, "utf8")).toBe(`${blob}\n`);
      expect(readFileSync(f.events, "utf8").match(/^chmod:/gm)).toHaveLength(2);
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: f.repo, encoding: "utf8" })).toBe("");
      const sourceText = readFileSync(bootstrap, "utf8");
      expect(sourceText).toContain('[[ "$(id -u)" == 0 ]] || refuse "root is required"');
      expect(sourceText).toContain('git_growth show "$release:scripts/$file_name"');
      expect(sourceText).toContain('git_growth status --porcelain --untracked-files=all');
      expect(sourceText).toContain('mv -T -n -- "$tmp" "$stage/$file_name"');
      expect(sourceText).not.toMatch(/rm\s+-rf|systemctl\s+(start|stop|enable|disable)/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("refuses a dirty release checkout before creating the privileged staging directory", () => {
    const f = bootstrapFixture();
    try {
      writeFileSync(join(f.repo, "untracked.txt"), "not part of release");
      const result = f.run('main "$RELEASE"');
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("checkout is dirty");
      expect(existsSync(f.stage)).toBe(false);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("refuses a modified existing installer and leaves its bytes untouched", () => {
    const f = bootstrapFixture();
    try {
      expect(f.run('main "$RELEASE"').status).toBe(0);
      const staged = join(f.stage, f.release, "install-mailbox-sync.sh");
      writeFileSync(staged, "preserve this conflicting file\n");
      const result = f.run('main "$RELEASE"');
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("existing staged installer differs");
      expect(readFileSync(staged, "utf8")).toBe("preserve this conflicting file\n");
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it.each(["installer-only", "marker-only"])("resumes safe partial installer staging (%s)", (partial) => {
    const f = bootstrapFixture();
    try {
      const stage = join(f.stage, f.release);
      mkdirSync(stage, { recursive: true });
      const staged = join(stage, "install-mailbox-sync.sh");
      const marker = join(stage, "INSTALLER-BLOB-SHA");
      const blob = execFileSync("git", ["rev-parse", `${f.release}:scripts/install-mailbox-sync.sh`], { cwd: f.repo, encoding: "utf8" }).trim();
      if (partial === "installer-only") writeFileSync(staged, f.installerBytes);
      else writeFileSync(marker, `${blob}\n`);

      const result = f.run('main "$RELEASE"');
      expect(result.status, result.output).toBe(0);
      expect(readFileSync(staged, "utf8")).toBe(f.installerBytes);
      expect(readFileSync(marker, "utf8")).toBe(`${blob}\n`);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
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

  it("enforces storage headroom and the 3200-backup bound using pure facts", () => {
    const result = source(storage, "for f in '2097152 3200' '2097151 3200' '2097152 3201'; do set -- $f; if check_facts $1 $2; then echo OK; else echo REFUSED; fi; done");
    expect(result.status).toBe(0);
    expect(result.output.match(/^OK$/gm)?.length).toBe(1);
    expect(result.output.match(/^REFUSED$/gm)?.length).toBe(2);
    expect(readFileSync(storage, "utf8")).toContain("target=\"$BACKUP_DIR/deploy-$(date -u +%Y%m%dT%H%M%SZ).dump\"");
  });

  it("prunes only valid backups strictly older than 30 days", () => {
    const f = storageFixture();
    const now = Math.floor(Date.parse("2026-11-17T12:00:00Z") / 1000);
    const expired = join(f.dir, "deploy-20261018T115959Z.dump");
    const boundary = join(f.dir, "deploy-20261018T120000Z.dump");
    const recent = join(f.dir, "deploy-20261117T120000Z.dump");
    const unrelated = join(f.dir, "notes.dump");
    for (const path of [expired, boundary, recent, unrelated]) writeFileSync(path, "fixture");
    try {
      const result = f.run(`prune_expired_backups ${now}`);
      expect(result.status, result.output).toBe(0);
      expect(result.output.trim()).toBe("1");
      expect(existsSync(expired)).toBe(false);
      expect(existsSync(boundary)).toBe(true);
      expect(existsSync(recent)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("rejects malformed timestamps before deleting any eligible backup", () => {
    const f = storageFixture();
    const now = Math.floor(Date.parse("2026-11-17T12:00:00Z") / 1000);
    const expired = join(f.dir, "deploy-20261018T115959Z.dump");
    const malformed = join(f.dir, "deploy-20261340T000000Z.dump");
    writeFileSync(expired, "fixture"); writeFileSync(malformed, "fixture");
    try {
      const result = f.run(`prune_expired_backups ${now}`);
      expect(result.status).not.toBe(0);
      expect(existsSync(expired)).toBe(true);
      expect(existsSync(malformed)).toBe(true);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("fails closed when backup-file enumeration emits a partial listing then fails", () => {
    const f = storageFixture();
    const now = Math.floor(Date.parse("2026-11-17T12:00:00Z") / 1000);
    const expired = join(f.dir, "deploy-20261018T115959Z.dump");
    writeFileSync(expired, "fixture");
    try {
      const partialFind = `find(){ printf '%s\\0' "$BACKUP_DIR/deploy-20261018T115956Z.dump"; return 73; }; `;
      const prune = f.run(`${partialFind} prune_expired_backups ${now}`);
      expect(prune.status).not.toBe(0);
      expect(existsSync(expired)).toBe(true);
      const count = f.run(`${partialFind} backup_count`);
      expect(count.status).not.toBe(0);
      expect(existsSync(expired)).toBe(true);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("fails closed on future or incorrectly protected matching dumps", () => {
    const f = storageFixture();
    const now = Math.floor(Date.parse("2026-11-17T12:00:00Z") / 1000);
    const future = join(f.dir, "deploy-20271117T120000Z.dump");
    const expired = join(f.dir, "deploy-20261018T115959Z.dump");
    writeFileSync(future, "fixture"); writeFileSync(expired, "fixture");
    try {
      const futureResult = f.run(`prune_expired_backups ${now}`);
      expect(futureResult.status).not.toBe(0);
      expect(existsSync(future)).toBe(true);
      expect(existsSync(expired)).toBe(true);
      const unsafe = f.run(`stat(){ if [[ "$1" == -c && "$2" == '%U:%G:%a:%h' ]]; then printf '%s\\n' growth:growth:644:1; return; fi; command stat "$@"; }; prune_expired_backups ${now}`);
      expect(unsafe.status).not.toBe(0);
      expect(existsSync(expired)).toBe(true);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("refuses an empty timestamp-valid dump before pruning any eligible backup", () => {
    const f = storageFixture();
    const now = Math.floor(Date.parse("2026-11-17T12:00:00Z") / 1000);
    const expired = join(f.dir, "deploy-20261018T115959Z.dump");
    const empty = join(f.dir, "deploy-20261018T115958Z.dump");
    writeFileSync(expired, "fixture"); writeFileSync(empty, "");
    try {
      const result = f.run(`prune_expired_backups ${now}`);
      expect(result.status).not.toBe(0);
      expect(existsSync(expired)).toBe(true);
      expect(existsSync(empty)).toBe(true);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
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
