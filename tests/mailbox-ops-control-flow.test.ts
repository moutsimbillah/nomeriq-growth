import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync("scripts/install-mailbox-sync.sh", "utf8");
const sha = "c55480ce357c490c404074b495e3a77d2515465c";
const scratch = process.env.TMPDIR;
if (!scratch) throw new Error("profile scratch required");
const deploymentDoc = readFileSync("docs/MAILBOX-AUTOSYNC-DEPLOYMENT.md", "utf8");

function fixture() {
  const dir = mkdtempSync(join(scratch!, "mailbox-ops-control-"));
  const posix = execFileSync("bash", ["-c", 'cd "$FIXTURE" && pwd -P'], { env: { ...process.env, FIXTURE: dir }, encoding: "utf8" }).trim();
  const locations: Record<string, string> = {
    "readonly APP_ROOT=/home/growth/app": `readonly APP_ROOT="${posix}/app"`,
    "readonly RUNTIME_DIR=/usr/local/lib/growth-mailbox-sync": `readonly RUNTIME_DIR="${posix}/runtime"`,
    "readonly QUARANTINE_ROOT=/usr/local/lib/growth-mailbox-sync-quarantine": `readonly QUARANTINE_ROOT="${posix}/quarantine"`,
    "readonly UNIT_DIR=/etc/systemd/system": `readonly UNIT_DIR="${posix}/units"`,
  };
  let body = source;
  for (const [from, to] of Object.entries(locations)) body = body.replace(from, to);
  // Only fixed filesystem locations are mapped; actual orchestration/guards are unchanged.
  body = body.replaceAll("/var/backups/growth", `${posix}/backups`);
  const script = join(dir, "fixture.sh");
  writeFileSync(script, body);
  for (const child of ["app/node_modules", "units", "backups"]) mkdirSync(join(dir, child), { recursive: true });
  const seed = () => {
    mkdirSync(join(dir, "runtime"));
    writeFileSync(join(dir, "runtime/.managed-mailbox-sync-release"), `release_sha=${sha}\n`);
    writeFileSync(join(dir, "runtime/.install-state"), `release_sha=${sha}\nphase=complete\nservice_installed=1\ntimer_installed=1\n`);
    writeFileSync(join(dir, "runtime/first-sync.ok"), `release_sha=${sha}\nstatus=0\n`);
    for (const unit of ["growth-mailbox-sync.service", "growth-mailbox-sync.timer"]) writeFileSync(join(dir, "units", unit), `original:${unit}`);
  };
  const run = (commands: string) => {
    const driver = `source "$SCRIPT"; set +e
sudo(){ printf UNEXPECTED_SUDO >&2; return 99; }
install(){ printf UNEXPECTED_INSTALL >&2; return 99; }
systemctl(){ printf UNEXPECTED_SYSTEMCTL >&2; return 99; }
root_only(){ return 0; }
require_release(){ return 0; }
require_external_location(){ return 0; }
require_deploy_source(){ return 0; }
require_unit_integrity(){ return 0; }
acquire_quarantine_lock(){ return 0; }
sync(){ return 0; }
git_growth(){ [[ "$1" == show ]] || return 99; case "$2" in *:scripts/systemd/"$SERVICE") printf 'original:%s' "$SERVICE";; *:scripts/systemd/"$TIMER") printf 'original:%s' "$TIMER";; *) return 99;; esac; }
trusted_chain(){ return 0; }
trusted_file(){ [[ -f "$1" && ! -L "$1" ]]; }
fresh_verified_backup(){ printf 'backup\\n' >>"$EVENTS"; return 0; }
${commands}`;
    try { return { status: 0, output: execFileSync("bash", ["-c", driver], { env: { ...process.env, SCRIPT: script, EVENTS: join(dir, "events") }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
    catch (error) { const e = error as { status: number; stdout?: string; stderr?: string }; return { status: e.status, output: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
  };
  const events = () => existsSync(join(dir, "events")) ? readFileSync(join(dir, "events"), "utf8").trim().split("\n") : [];
  return { dir, script, seed, run, events };
}
const fakeService = (failStop = false) => `timer=enabled; timer_active=active; service_active=active
systemctl(){
 case "$1" in
 disable) [[ -f "$UNIT_DIR/$TIMER" ]] || return 44; printf 'disable %s\\n' "$*" >>"$EVENTS"; timer=disabled; timer_active=inactive;;
 stop) [[ -f "$UNIT_DIR/$SERVICE" ]] || return 44; printf 'stop %s\\n' "$*" >>"$EVENTS"; ${failStop ? "return 42" : "service_active=inactive"};;
 is-enabled) if [[ ! -f "$UNIT_DIR/$TIMER" ]]; then printf not-found; return 1; fi; printf '%s' "$timer";;
 is-active) if [[ ! -f "$UNIT_DIR/$2" ]]; then printf inactive; return 3; fi; if [[ "$2" == "$TIMER" ]]; then printf '%s' "$timer_active"; else printf '%s' "$service_active"; fi;;
 daemon-reload) printf 'reload\\n' >>"$EVENTS";;
 *) return 99;; esac
}`;

describe("actual mailbox installer orchestration on mapped disposable paths", () => {
  it("rejects extra arguments before trust checks or installation", () => {
    const f = fixture();
    const r = f.run(`require_installer_trust(){ printf BAD_TRUST >>"$EVENTS"; }; main install ${sha} extra`);
    expect(r.status).not.toBe(0); expect(f.events()).toEqual([]);
  });
  it("stops before every installer write when the backup fails", () => {
    const f = fixture();
    const r = f.run(`systemctl(){ [[ "$1" == show ]] && printf loaded; }; fresh_verified_backup(){ printf backup >>"$EVENTS"; return 1; }; install_runtime ${sha}`);
    expect(r.status).not.toBe(0); expect(f.events()).toEqual(["backup"]);
    expect(r.output).not.toContain("UNEXPECTED_INSTALL"); expect(existsSync(join(f.dir, "runtime"))).toBe(false);
  });
  it("documents quarantine as the only safe retry after a published install failure", () => {
    expect(deploymentDoc).toContain("If `install` exits nonzero after publishing the runtime");
    expect(deploymentDoc).toContain("install-mailbox-sync.sh quarantine <release-sha>");
    expect(deploymentDoc).toContain("Do not retry `install`");
  });
  it("refuses an unmanaged unit before taking a backup or overwriting bytes", () => {
    const f = fixture();
    writeFileSync(join(f.dir, "units/growth-mailbox-sync.service"), "unmanaged-original");
    const r = f.run(`install_runtime ${sha}`);
    expect(r.status).not.toBe(0); expect(f.events()).toEqual([]);
    expect(readFileSync(join(f.dir, "units/growth-mailbox-sync.service"), "utf8")).toBe("unmanaged-original");
  });
  it.each([
    { failedUnit: "growth-mailbox-sync.service", phase: "runtime-published", serviceInstalled: false },
    { failedUnit: "growth-mailbox-sync.timer", phase: "service-installed", serviceInstalled: true },
  ])("records post-publish $failedUnit failure and recovers without a missing-unit call", ({ failedUnit, phase, serviceInstalled }) => {
    const f = fixture();
    const r = f.run(`
      root_only(){ return 0; }; require_release(){ return 0; }; require_deploy_source(){ return 0; };
      trusted_chain(){ return 0; }; chown(){ :; };
      systemctl(){ [[ "$1" == show ]] && printf loaded; };
      fresh_verified_backup(){ printf backup >>"$EVENTS"; return 0; };
      git_growth(){ if [[ "$1" == archive ]]; then tar -cf - -T /dev/null; else printf blob; fi; };
      install(){
        if [[ "$*" == *' -d '* ]]; then command mkdir -p "\${@:8}"; return; fi
        local a=("$@"); local n=\${#a[@]}; local dst=\${a[$((n-1))]};
        [[ "$dst" == *${failedUnit} ]] && return 42;
        command cp "\${a[$((n-2))]}" "$dst";
      };
      install_runtime ${sha}`);
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(f.dir, "runtime/.install-state"), "utf8")).toContain(`phase=${phase}`);
    expect(existsSync(join(f.dir, "units/growth-mailbox-sync.service"))).toBe(serviceInstalled);
    expect(existsSync(join(f.dir, "units/growth-mailbox-sync.timer"))).toBe(false);
    const retry = f.run(`install_runtime ${sha}`);
    expect(retry.status).not.toBe(0);
    expect(retry.output).toContain("quarantine it before retrying");
    const recovered = f.run(`${fakeService()}; git_growth(){ [[ "$1" == show ]] && printf blob; }; install(){ while (( $# > 2 )); do shift; done; command mkdir -p "$@"; }; quarantine ${sha}`);
    expect(recovered.status, recovered.output).toBe(0);
    expect(existsSync(join(f.dir, "runtime"))).toBe(false);
    expect(existsSync(join(f.dir, `quarantine/${sha}/runtime/.install-state`))).toBe(true);
    expect(recovered.output).not.toContain("UNEXPECTED_");
  });
  it("leaves both units and a non-complete marker when daemon-reload fails", () => {
    const f = fixture();
    const r = f.run(`
      root_only(){ return 0; }; require_release(){ return 0; }; require_deploy_source(){ return 0; };
      trusted_chain(){ return 0; }; chown(){ :; }; fresh_verified_backup(){ return 0; };
      systemctl(){ if [[ "$1" == show ]]; then printf loaded; elif [[ "$1" == daemon-reload ]]; then return 43; fi; };
      git_growth(){ if [[ "$1" == archive ]]; then tar -cf - -T /dev/null; else printf blob; fi; };
      install(){
        if [[ "$*" == *' -d '* ]]; then command mkdir -p "\${@:8}"; return; fi
        local a=("$@"); local n=\${#a[@]}; command cp "\${a[$((n-2))]}" "\${a[$((n-1))]}";
      };
      install_runtime ${sha}`);
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(f.dir, "runtime/.install-state"), "utf8")).toContain("phase=timer-installed");
    expect(existsSync(join(f.dir, "units/growth-mailbox-sync.service"))).toBe(true);
    expect(existsSync(join(f.dir, "units/growth-mailbox-sync.timer"))).toBe(true);
  });
  it("refuses an incomplete published runtime instead of treating it as idempotently installed", () => {
    const f = fixture(); f.seed();
    writeFileSync(join(f.dir, "runtime/.install-state"), `release_sha=${sha}\nphase=service-installed\nservice_installed=1\ntimer_installed=0\n`);
    const r = f.run(`install_runtime ${sha}`);
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("quarantine it before retrying");
    expect(f.events()).toEqual([]);
    expect(readFileSync(join(f.dir, "runtime/.install-state"), "utf8")).toContain("phase=service-installed");
  });

  it("quarantines a partial publish without requiring both unit files, then resumes without overwrite", () => {
    const f = fixture(); f.seed();
    const timer = join(f.dir, "units/growth-mailbox-sync.timer");
    const service = join(f.dir, "units/growth-mailbox-sync.service");
    const originalService = readFileSync(service, "utf8");
    writeFileSync(join(f.dir, "runtime/.install-state"), `release_sha=${sha}\nphase=service-installed\nservice_installed=1\ntimer_installed=0\n`);
    execFileSync("node", ["-e", "require('node:fs').unlinkSync(process.argv[1])", timer]);
    const first = f.run(`${fakeService()}; install(){ while (( $# > 2 )); do shift; done; command mkdir -p "$@"; }; quarantine ${sha}`);
    expect(first.status, first.output).toBe(0);
    expect(f.events().some((event) => event.includes("stop growth-mailbox-sync.service"))).toBe(true);
    expect(f.events().some((event) => event.includes("disable growth-mailbox-sync.timer"))).toBe(false);
    const saved = join(f.dir, `quarantine/${sha}`);
    expect(readFileSync(join(saved, "growth-mailbox-sync.service"), "utf8")).toBe(originalService);
    expect(existsSync(join(saved, "growth-mailbox-sync.timer"))).toBe(false);
    expect(existsSync(join(saved, "runtime/.install-state"))).toBe(true);
    const second = f.run(`${fakeService(true)}; quarantine ${sha}`);
    expect(second.status).toBe(0);
    expect(readFileSync(join(saved, "growth-mailbox-sync.service"), "utf8")).toBe(originalService);
    expect(existsSync(join(saved, "runtime/.install-state"))).toBe(true);
  });

  it("preserves artifacts and resumes after interruption between unit and runtime moves", () => {
    const f = fixture(); f.seed();
    const commands = `${fakeService()}; install(){ while (( $# > 2 )); do shift; done; command mkdir -p "$@"; };`;
    const first = f.run(`${commands} mv(){ if [[ "\${@: -2:1}" == "$RUNTIME_DIR" ]]; then return 43; fi; command mv "$@"; }; quarantine ${sha}`);
    expect(first.status).not.toBe(0);
    const saved = join(f.dir, `quarantine/${sha}`);
    expect(existsSync(join(saved, "growth-mailbox-sync.service"))).toBe(true);
    expect(existsSync(join(saved, "growth-mailbox-sync.timer"))).toBe(true);
    expect(existsSync(join(f.dir, "runtime"))).toBe(true);
    const second = f.run(`${commands} quarantine ${sha}`);
    expect(second.status).toBe(0);
    expect(readFileSync(join(saved, ".quarantine-complete"), "utf8")).toBe(`release_sha=${sha}\n`);
    expect(existsSync(join(f.dir, "runtime"))).toBe(false);
  });
  it("resumes after runtime rename followed by daemon-reload failure", () => {
    const f = fixture(); f.seed();
    const commands = `${fakeService()}; install(){ while (( $# > 2 )); do shift; done; command mkdir -p "$@"; };`;
    const first = f.run(`${fakeService().replace("systemctl(){", "original_systemctl(){")}; systemctl(){ [[ "$1" == daemon-reload ]] && return 43; original_systemctl "$@"; }; install(){ while (( $# > 2 )); do shift; done; command mkdir -p "$@"; }; quarantine ${sha}`);
    expect(first.status).not.toBe(0);
    const saved = join(f.dir, `quarantine/${sha}`);
    expect(existsSync(join(saved, "runtime"))).toBe(true);
    expect(existsSync(join(saved, ".quarantine-complete"))).toBe(false);
    const second = f.run(`${commands} quarantine ${sha}`);
    expect(second.status).toBe(0);
    expect(existsSync(join(saved, ".quarantine-complete"))).toBe(true);
  });
  it("rejects unrelated unit bytes before backup or any move", () => {
    const f = fixture(); f.seed();
    writeFileSync(join(f.dir, "units/growth-mailbox-sync.service"), "unmanaged-unit");
    const r = f.run(`${fakeService()}; quarantine ${sha}`);
    expect(r.status).not.toBe(0);
    expect(f.events()).toEqual([]);
    expect(existsSync(join(f.dir, "quarantine"))).toBe(false);
    expect(r.output).not.toContain("UNEXPECTED_");
  });
  it("quarantines truncated unit bytes without executing or validating the corrupt CLI snapshot", () => {
    const f = fixture(); f.seed();
    writeFileSync(join(f.dir, "units/growth-mailbox-sync.timer"), "original:");
    const r = f.run(`${fakeService()}; require_unit_integrity(){ printf BAD_RUNTIME >>"$EVENTS"; return 1; }; install(){ while (( $# > 2 )); do shift; done; command mkdir -p "$@"; }; fresh_verified_backup(){ [[ "$1" == "$ORIGINAL_DEPLOY" ]] || return 99; printf 'backup\\n' >>"$EVENTS"; }; quarantine ${sha}`);
    expect(r.status).toBe(0);
    expect(readFileSync(join(f.dir, `quarantine/${sha}/growth-mailbox-sync.timer`), "utf8")).toBe("original:");
    expect(f.events()).not.toContain("BAD_RUNTIME");
  });
  it("refuses same-release reinstall after quarantine without any forward write", () => {
    const f = fixture(); f.seed();
    const first = f.run(`${fakeService()}; install(){ while (( $# > 2 )); do shift; done; command mkdir -p "$@"; }; quarantine ${sha}`);
    expect(first.status).toBe(0);
    const retry = f.run(`install_runtime ${sha}`);
    expect(retry.status).not.toBe(0);
    expect(retry.output).toContain("quarantined release cannot be reinstalled");
    expect(existsSync(join(f.dir, "runtime"))).toBe(false);
  });
  it("refuses enablement without a successful initial sync", () => {
    const f = fixture(); const r = f.run(`enable_timer ${sha}`);
    expect(r.status).not.toBe(0); expect(f.events()).toEqual([]);
    expect(r.output).toContain("first successful sync is required");
    expect(r.output).not.toContain("UNEXPECTED_SYSTEMCTL");
  });
  it("refuses missing schema before backup and timer activation", () => {
    const f = fixture(); f.seed();
    const r = f.run(`require_migration_035(){ printf schema >>"$EVENTS"; return 1; }; enable_timer ${sha}`);
    expect(r.status).not.toBe(0); expect(f.events()).toEqual(["schema"]);
    expect(r.output).not.toContain("UNEXPECTED_SYSTEMCTL");
  });
  it("can disable an enabled active job without requiring an unchanged checkout", () => {
    const f = fixture(); f.seed();
    const r = f.run(`${fakeService()}; require_release(){ printf BAD_RELEASE >>"$EVENTS"; return 1; }; disable_timer ${sha}`);
    expect(r.status).toBe(0);
    expect(f.events()).toEqual(["backup", "disable disable --now growth-mailbox-sync.timer", "stop stop growth-mailbox-sync.service"]);
    expect(existsSync(join(f.dir, "runtime/.managed-mailbox-sync-release"))).toBe(true);
  });
  it("does not stop or move anything after a failed backup", () => {
    const f = fixture(); f.seed();
    const r = f.run(`${fakeService()}; fresh_verified_backup(){ printf backup >>"$EVENTS"; return 1; }; quarantine ${sha}`);
    expect(r.status).not.toBe(0); expect(f.events()).toEqual(["backup"]);
    expect(existsSync(join(f.dir, "runtime/.managed-mailbox-sync-release"))).toBe(true);
  });
  it("never moves units or runtime after a service-stop failure", () => {
    const f = fixture(); f.seed();
    const r = f.run(`${fakeService(true)}; quarantine ${sha}`);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(f.dir, "runtime/.managed-mailbox-sync-release"))).toBe(true);
    expect(readFileSync(join(f.dir, "units/growth-mailbox-sync.service"), "utf8")).toBe("original:growth-mailbox-sync.service");
    expect(existsSync(join(f.dir, "quarantine"))).toBe(false);
    expect(f.events()).toContain("stop stop growth-mailbox-sync.service");
    expect(r.output).not.toContain("UNEXPECTED_");
  });
  it("preserves the exact runtime and both units by rename after successful stop", () => {
    const f = fixture(); f.seed();
    const r = f.run(`${fakeService()}; install(){ while (( $# > 2 )); do shift; done; command mkdir -p "$@"; }; quarantine ${sha}`);
    expect(r.status).toBe(0);
    const saved = join(f.dir, `quarantine/${sha}`);
    expect(readFileSync(join(saved, "runtime/.managed-mailbox-sync-release"), "utf8")).toBe(`release_sha=${sha}\n`);
    for (const unit of ["growth-mailbox-sync.service", "growth-mailbox-sync.timer"]) expect(readFileSync(join(saved, unit), "utf8")).toBe(`original:${unit}`);
    expect(existsSync(join(f.dir, "runtime"))).toBe(false);
    expect(f.events().at(-1)).toBe("reload");
  });
});
