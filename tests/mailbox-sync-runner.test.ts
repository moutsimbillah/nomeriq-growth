import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveScratchDir } from "./helpers/scratch";

const wrapper = join(process.cwd(), "scripts", "growth-cron-sync.sh");
const scratch = resolveScratchDir();

function bash(body: string, env: Record<string, string> = {}) {
  try {
    return { status: 0, output: execFileSync("bash", ["-c", body], { encoding: "utf8", env: { ...process.env, WRAPPER: wrapper, ...env }, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function harness(body: string) {
  return `set +e
source "$WRAPPER"
python3_cmd() { command -v python3; }
set +e
marker=$(mktemp)
record_failure() { printf '%s\\n' "$1" >>"$marker"; printf 'FAIL code=%s\\n' "$1"; }
require_wrapper_integrity() { return 0; }
require_deploy_integrity() { return 0; }
require_cli() { return 0; }
${body}`;
}

function mappedWrapper() {
  const dir = mkdtempSync(join(scratch, "growth-wrapper-map-"));
  const run = join(dir, "run").replaceAll("\\", "/");
  const source = readFileSync(wrapper, "utf8")
    .replaceAll('readonly RUNTIME_LOCK_DIR=/run/growth-mailbox-sync', `readonly RUNTIME_LOCK_DIR="${run}/growth-mailbox-sync"`)
    .replaceAll('local root=/run dir=$RUNTIME_LOCK_DIR', `local root="${run}" dir=$RUNTIME_LOCK_DIR`);
  const copy = join(dir, "wrapper.sh");
  writeFileSync(copy, source);
  return { dir, run, copy };
}

const validReceipt = (path = "/var/backups/growth/deploy-20261114T120000Z.dump", mode = "600") =>
  `dump: ${path}\nsize: 2048 bytes\nmode: ${mode}\ntable-data entries: 50\n`;

describe("scheduled mailbox backup wrapper", () => {
  it("uses fixed production paths and no HTTP, scheduler, npm, or environment-source path", () => {
    const source = readFileSync(wrapper, "utf8");
    expect(source).toContain("readonly SNAPSHOT=\"$RUNTIME/app\"");
    expect(source).toContain("readonly CLI=\"$SNAPSHOT/scripts/scheduled-mailbox-sync.ts\"");
    expect(source).toContain("readonly DEPLOY=\"$RUNTIME/deploy.sh\"");
    expect(source).toContain("a8cc605ca1dfe323f1b3b7ce1d123e1ae3f8197268fc9339399b2d37b593f8c6");
    expect(source).toContain('bash "$DEPLOY" dump');
    expect(source).toContain('env -i HOME=/home/growth USER=growth LOGNAME=growth PATH=/usr/bin:/bin NODE_ENV=production TSX_DISABLE_CACHE=1');
    expect(source).toContain('"$NODE" "$TSX" --tsconfig "$CONFIG" "$CLI"');
    expect(source).not.toMatch(/npm exec|\.growth\.env|curl|wget|systemctl (?:start|stop|restart|enable|disable|mask)|crontab|ssh/);
    expect(source).not.toContain("pg_dump ");
  });

  it("accepts only the canonical receipt path and raw mode 600", () => {
    const result = bash(harness(`
for r in \
  '${validReceipt()}' \
  '${validReceipt('/var/backups/growth/other.dump')}' \
  '${validReceipt('/var/backups/growth/deploy-20261114T120000Z.dump/../x.dump')}' \
  '${validReceipt('/var/backups/growth/deploy-20261114T120000Z.dump"x')}' \
  '${validReceipt('/var/backups/growth/deploy-20261114T120000Z.dump\\nX')}' \
  '${validReceipt('/var/backups/growth/deploy-20261114T120000Z.dump', '640')}'; do
  if parse_receipt "$r"; then printf 'ACCEPT\\n'; else printf 'REJECT\\n'; fi
done
parse_receipt '${validReceipt()}'
json=$(verified_receipt_json)
printf 'JSON=%s\\n' "$json"
`));
    expect(result.status).toBe(0);
    expect((result.output.match(/ACCEPT/g) ?? []).length).toBe(1);
    expect((result.output.match(/REJECT/g) ?? []).length).toBe(5);
    const json = result.output.match(/JSON=(.*)/)?.[1];
    expect(json).toBeTruthy();
    expect(JSON.parse(json!)).toMatchObject({ mode: "600", path: "/var/backups/growth/deploy-20261114T120000Z.dump" });
  });

  it("preserves backup, verification, and CLI ordering and passes only structured receipt", () => {
    const result = bash(harness(`
order=$(mktemp)
raw_take_backup() { printf '${validReceipt()}'; printf 'backup\\n' >>"$order"; }
verify_backup() { printf 'verify\\n' >>"$order"; return 0; }
dispatch_cli() { printf 'cli\\n' >>"$order"; [[ "$1" == '{"kind":"pg_dump","verified":true,"mode":"600","path":"/var/backups/growth/deploy-20261114T120000Z.dump",'* ]] || return 1; printf '{"status":"completed","runId":"123e4567-e89b-42d3-a456-426614174000"}\\n'; }
run_once
printf 'order=%s\\n' "$(tr '\\n' , <"$order")"
`));
    expect(result.status).toBe(0);
    expect(result.output).toContain("SUCCESS backup=1 verified=1 cli_exit=0 run_id=123e4567-e89b-42d3-a456-426614174000");
    expect(result.output).toContain("order=backup,verify,cli,");
  });

  it("forwards only a valid run-start breadcrumb from the private CLI", () => {
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const result = bash(harness(`
sudo() {
  printf 'RUN_STARTED run_id=${runId}\\n'
  printf 'private provider diagnostic\\n' >&2
  printf '{"status":"completed","runId":"${runId}"}\\n'
}
events=$(mktemp)
output=$(dispatch_cli '{}' 2>"$events")
printf 'JSON=%s\\n' "$output"
printf 'JOURNAL=%s\\n' "$(tr '\\n' , <"$events")"
`));
    expect(result.status).toBe(0);
    expect(result.output).toContain(`JOURNAL=RUN_STARTED run_id=${runId}`);
    expect(result.output).toContain(`JSON={"status":"completed","runId":"${runId}"}`);
    expect(result.output).not.toContain("private provider diagnostic");
  });

  it("refuses malformed run-start breadcrumbs before forwarding CLI results", () => {
    const result = bash(harness(`
sudo() {
  printf 'RUN_STARTED run_id=not-a-uuid\\n'
  printf '{"status":"completed","runId":"123e4567-e89b-42d3-a456-426614174000"}\\n'
}
if output=$(dispatch_cli '{}'); then printf 'BAD_ACCEPT\\n'; else printf 'REFUSED\\n'; fi
`));
    expect(result.status).toBe(0);
    expect(result.output).toContain("REFUSED");
    expect(result.output).not.toContain("BAD_ACCEPT");
    expect(result.output).not.toContain("not-a-uuid");
  });

  it.each([
    ["timer enabled", "enabled", "inactive", "inactive", "timer_not_disabled"],
    ["timer active", "disabled", "active", "inactive", "timer_active"],
    ["service active", "disabled", "inactive", "active", "service_active"],
  ])("refuses undo while the %s", (_label, enabled, timerActive, serviceActive, refusal) => {
    const result = bash(harness(`
systemctl() {
  case "$1 $2" in
    'is-enabled growth-mailbox-sync.timer') printf '%s\\n' "$TIMER_ENABLED" ;;
    'is-active growth-mailbox-sync.timer') printf '%s\\n' "$TIMER_ACTIVE" ;;
    'is-active growth-mailbox-sync.service') printf '%s\\n' "$SERVICE_ACTIVE" ;;
    *) return 1 ;;
  esac
}
raw_take_backup() { printf 'BACKUP_SHOULD_NOT_RUN\\n'; }
dispatch_cli() { printf 'CLI_SHOULD_NOT_RUN\\n'; }
undo_once '123e4567-e89b-42d3-a456-426614174000'
status=$?
printf 'STATUS=%s\\n' "$status"
`), { TIMER_ENABLED: enabled, TIMER_ACTIVE: timerActive, SERVICE_ACTIVE: serviceActive });
    expect(result.status).toBe(0);
    expect(result.output).toContain(`FAIL code=${refusal}`);
    expect(result.output).toContain("STATUS=1");
    expect(result.output).not.toContain("BACKUP_SHOULD_NOT_RUN");
    expect(result.output).not.toContain("CLI_SHOULD_NOT_RUN");
  });

  it("requires fresh verified backup and exact run ID before invoking scheduled undo", () => {
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const result = bash(harness(`
events=$(mktemp)
systemctl() {
  printf 'check:%s:%s\\n' "$1" "$2" >>"$events"
  case "$1 $2" in
    'is-enabled growth-mailbox-sync.timer') printf 'disabled\\n' ;;
    'is-active growth-mailbox-sync.timer'|'is-active growth-mailbox-sync.service') printf 'inactive\\n' ;;
    *) return 1 ;;
  esac
}
raw_take_backup() { printf 'backup\\n' >>"$events"; printf '${validReceipt()}'; }
verify_backup() { printf 'verify\\n' >>"$events"; return 0; }
dispatch_cli() {
  printf 'cli:%s:%s\\n' "$2" "$3" >>"$events"
  [[ "$2" == undo && "$3" == '${runId}' ]] || return 1
  printf '{"status":"undone","runId":"${runId}","journalRows":4}\\n'
}
undo_once '${runId}'
status=$?
printf 'STATUS=%s\\n' "$status"
printf 'ORDER=%s\\n' "$(tr '\\n' , <"$events")"
`));
    expect(result.status).toBe(0);
    expect(result.output).toContain(`UNDO_SUCCESS status=undone run_id=${runId} journal_rows=4 backup=1 verified=1`);
    expect(result.output).toContain("STATUS=0");
    expect(result.output).toContain(`ORDER=check:is-enabled:growth-mailbox-sync.timer,check:is-active:growth-mailbox-sync.timer,check:is-active:growth-mailbox-sync.service,backup,verify,cli:undo:${runId},`);
  });

  it("reports a guarded data conflict instead of claiming undo succeeded", () => {
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const result = bash(harness(`
systemctl() { case "$1 $2" in 'is-enabled growth-mailbox-sync.timer') printf 'disabled\\n';; *) printf 'inactive\\n';; esac; }
raw_take_backup() { printf '${validReceipt()}'; }
verify_backup() { return 0; }
dispatch_cli() { printf '{"status":"conflict","runId":"${runId}","journalRows":4}\\n'; return 1; }
undo_once '${runId}'
status=$?
printf 'STATUS=%s\\n' "$status"
`));
    expect(result.status).toBe(0);
    expect(result.output).toContain(`UNDO_CONFLICT run_id=${runId} journal_rows=4`);
    expect(result.output).toContain("STATUS=1");
    expect(result.output).not.toContain("UNDO_SUCCESS");
  });

  it("rejects malformed undo results and journal row counts", () => {
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const result = bash(harness(`
for payload in '{"status":"undone","runId":"${runId}"}' '{"status":"undone","runId":"${runId}","journalRows":-1}' '{"status":"undone","runId":"${runId}","journalRows":true}' '{"status":"failed","runId":"${runId}","journalRows":4}'; do
  if printf '%s' "$payload" | parse_undo_cli_result >/dev/null; then printf 'BAD_ACCEPT\\n'; else printf 'REFUSED\\n'; fi
done
`));
    expect(result.status).toBe(0);
    expect(result.output.match(/REFUSED/g)).toHaveLength(4);
    expect(result.output).not.toContain("BAD_ACCEPT");
  });

  it("does not dispatch after backup or receipt failure", () => {
    for (const fake of ["backup", "receipt"]) {
      const result = bash(harness(`raw_take_backup() { ${fake === "backup" ? "return 1" : "printf 'not a receipt\\n'"}; }
dispatch_cli() { printf 'CLI_SHOULD_NOT_RUN\\n'; }
run_once
printf 'marker=%s\\n' "$(cat "$marker")"`));
      expect(result.output).not.toContain("CLI_SHOULD_NOT_RUN");
      expect(result.output).toMatch(/marker=(backup_failed|backup_receipt_invalid)/);
    }
  });

  it("rejects a failed producer even when a partial listing contains 50 data lines", () => {
    const result = bash(harness(`BACKUP_TABLE_DATA=50
    partial=$(printf 'TABLE DATA\\n%.0s' $(seq 1 50))
    if validate_backup_listing "$partial" 1; then printf 'BAD_ACCEPT\\n'; else printf 'REFUSED_PARTIAL_PRODUCER\\n'; fi
    `));
        expect(result.status).toBe(0);
        expect(result.output).toContain("REFUSED_PARTIAL_PRODUCER");
    const source = readFileSync(wrapper, "utf8");
    expect(source).toContain("producer_status");
    expect(source).toContain('[[ "$producer_status" == 0 ]] || return 1');
    expect(source).not.toContain("grep -c 'TABLE DATA' || true");
  });

  it("enforces invocation, future, and 300-second backup age bounds", () => {
    const result = bash(harness(`
for t in '100 100 200' '99 100 200' '201 100 200' '100 100 401' '100 100 400'; do
  set -- $t
  if validate_backup_time "$1" "$2" "$3"; then printf 'TIME_OK_%s\\n' "$t"; else printf 'TIME_REJECT_%s\\n' "$t"; fi
done
`));
    expect(result.status).toBe(0);
    expect(result.output).toContain("TIME_OK_100 100 200");
    expect(result.output).toContain("TIME_OK_100 100 400");
    expect(result.output).toContain("TIME_REJECT_100 100 401");
    expect(result.output).toContain("TIME_REJECT_99 100 200");
    expect(result.output).toContain("TIME_REJECT_201 100 200");
  });

  it("requires bounded mtime, canonical realpath, secure manifest, and safe marker handling", () => {
    const source = readFileSync(wrapper, "utf8");
    expect(source).toContain("MAX_BACKUP_AGE=300");
    expect(source).toContain('[[ "$real_path" == "$path" ]]');
    expect(source).toContain("secure_dir_chain /var/backups");
    expect(source).toContain("stat -c '%U' \"$BACKUPS\"");
    expect(source).toContain("== growth");
    expect(source).toContain("== 700");
    expect(source).toContain('$SNAPSHOT/node_modules/tsx/dist/cli.mjs');
    expect(source).toContain('stat -c \'%h\' "$FAILURE_MARKER"');
    expect(source).not.toContain('! -L "$TSX"');
    expect(source).toContain("SHA256SUMS");
    expect(source).toContain("! -L");
    expect(source).toContain("failure_marker_safe");
    expect(source).toContain('ln "$tmp" "$FAILURE_MARKER"');
    expect(source).not.toContain('mkdir -p "$(dirname "$FAILURE_MARKER")"');
  });

  // Windows cannot establish Linux UID/GID/mode facts. Only those OS facts are
  // injected here; mkdir, file/type checks and the production decision run for real.
  it.each([
    ["absent", 0, 1], ["existing", 0, 0],
    ["parent-owner", 2, 0], ["parent-group", 2, 0], ["parent-mode", 2, 0], ["parent-type", 2, 0],
    ["target-owner", 2, 0], ["target-group", 2, 0], ["target-mode", 2, 0], ["target-type", 2, 0],
    ["caller-owner", 2, 0], ["caller-group", 2, 0],
    ["lock-owner", 2, 0], ["lock-group", 2, 0], ["lock-mode", 2, 0], ["lock-links", 2, 0],
  ])("checks runtime filesystem case %s without repairing existing state", (scenario, expected, creates) => {
    const mapped = mappedWrapper();
    const result = bash(harness(`
command mkdir "$TEST_RUN"
case "$CASE" in
  parent-type) command rmdir "$TEST_RUN"; printf sentinel > "$TEST_RUN" ;;
  absent|parent-*|caller-*) : ;;
  target-type) printf sentinel > "$RUNTIME_LOCK_DIR" ;;
  *) command mkdir "$RUNTIME_LOCK_DIR" ;;
esac
case "$CASE" in lock-*) printf sentinel > "$LOCKFILE" ;; esac
CREATE_LOG="$TEST_RUN/../creates.log"
: > "$CREATE_LOG"
mkdir(){ printf 'mkdir\\n' >> "$CREATE_LOG"; command mkdir "$@"; }
chmod(){ echo UNEXPECTED_REPAIR; return 99; }
chown(){ echo UNEXPECTED_REPAIR; return 99; }
id(){
  case "$1:$CASE" in -u:caller-owner|-g:caller-group) echo 1;; *) echo 0;; esac
}
stat(){
  [[ "$1" == -c ]] || return 99
  if [[ "$3" == "$TEST_RUN" ]]; then
    case "$CASE" in
      parent-owner) echo '1:0:755:directory';;
      parent-group) echo '0:1:755:directory';;
      parent-mode) echo '0:0:777:directory';;
      *) echo '0:0:755:directory';;
    esac
  elif [[ "$3" == "$RUNTIME_LOCK_DIR" ]]; then
    case "$2:$CASE" in
      %u:target-owner|%g:target-group) echo 1;;
      %u:*|%g:*) echo 0;;
      %a:target-mode) echo 755;;
      %a:*) echo 700;;
      %F:*) command stat -c %F "$3";;
      *) return 99;;
    esac
  elif [[ "$3" == "$LOCKFILE" ]]; then
    case "$CASE" in
      lock-owner) echo '1:0:600:1';; lock-group) echo '0:1:600:1';;
      lock-mode) echo '0:0:644:1';; lock-links) echo '0:0:600:2';;
      *) echo '0:0:600:1';;
    esac
  else return 99; fi
}
flock(){ echo FLOCK_REACHED; return 0; }
if acquire_lock; then status=0; else status=$?; fi
calls=$(grep -c '^mkdir$' "$CREATE_LOG")
printf 'STATUS=%s CREATES=%s\\n' "$status" "$calls"
case "$CASE" in lock-*) [[ "$(cat "$LOCKFILE")" == sentinel ]] || echo MUTATED;; esac
`), { WRAPPER: mapped.copy, TEST_RUN: mapped.run, CASE: String(scenario) });
    expect(result.status).toBe(0);
    expect(result.output).toContain(`STATUS=${expected} CREATES=${creates}`);
    expect(result.output).not.toMatch(/MUTATED|UNEXPECTED_REPAIR/);
    expect(result.output.includes("FLOCK_REACHED")).toBe(expected === 0);
  });

  it.each([[2, "runtime_path_invalid"], [1, "lock_busy"]])("maps lock status %s without starting a writer", (status, code) => {
    const result = bash(harness(`
acquire_lock(){ return "$LOCK_STATUS"; }
run_once(){ echo UNEXPECTED_WRITE; }
if main; then echo BAD_SUCCESS; else echo REFUSED; fi
`), { LOCK_STATUS: String(status) });
    expect(result.output).toContain(`FAIL code=${code}`);
    expect(result.output).toContain("REFUSED");
    expect(result.output).not.toMatch(/BAD_SUCCESS|UNEXPECTED_WRITE/);
  });

  it("reports the real main failure status and refuses unknown arguments", () => {
    const result = bash(harness(`require_wrapper_integrity() { return 0; }
require_deploy_integrity() { return 0; }
require_cli() { return 0; }
acquire_lock() { return 0; }
run_once() { return 7; }
main; status=$?; printf 'STATUS=%s\\n' "$status"
main unexpected; status=$?; printf 'ARGS_STATUS=%s\\n' "$status"`));
    expect(result.status).toBe(0);
    expect(result.output).toContain("STATUS=7");
    expect(result.output).toContain("ARGS_STATUS=1");
  });

  it("documents mocked serialization because Windows bash cannot prove cross-process flock", () => {
    const dir = mkdtempSync(join(scratch, "growth-lock-"));
    const runner = join(dir, "runner.sh");
    writeFileSync(runner, `source "$WRAPPER"
require_wrapper_integrity(){ return 0; }; require_deploy_integrity(){ return 0; }; require_cli(){ return 0; }
acquire_lock(){ mkdir "$LOCK_PATH.d" 2>/dev/null; }
record_failure(){ printf 'failure:%s\\n' "$1" >>"$LOG_PATH"; }
take_backup(){ printf 'backup\\n' >>"$LOG_PATH"; sleep 0.2; printf '${validReceipt()}'; }
verify_backup(){ return 0; }; dispatch_cli(){ return 0; }
main
`);
    const result = bash(`bash "$RUNNER" & bash "$RUNNER" & wait; cat "$LOG_PATH"`, { RUNNER: runner, LOCK_PATH: join(dir, "lock"), LOG_PATH: join(dir, "events") });
    expect((result.output.match(/^backup$/gm) ?? []).length).toBe(1);
    expect(result.output).toContain("failure:lock_busy");
  });
});

// One verified dump per UTC day. Windows cannot express a dump's POSIX facts (owner, group, mode,
// link count), has no pg_restore, and has no trusted /var/backups ancestor chain, so only those
// facts are substituted below: the discovery glob, the strict name pattern, the producer receipt
// parsing, the UTC-day rule, the take-or-reuse decision, the refusal codes and the re-stamp all run
// as written. The same functions were also run against real POSIX files with real modes in an
// isolated Linux matrix, which is reported separately from this suite.
const dumpName = (clock: string) =>
  `deploy-${execFileSync("bash", ["-c", "date -u +%Y%m%d"], { encoding: "utf8" }).trim()}T${clock}Z.dump`;

function dayFixture() {
  const dir = mkdtempSync(join(scratch, "growth-day-backup-"));
  const backups = join(dir, "backups");
  mkdirSync(backups);
  const backupDir = execFileSync("bash", ["-c", 'cd "$F" && pwd -P'], { encoding: "utf8", env: { ...process.env, F: backups } }).trim();
  const copy = join(dir, "wrapper.sh");
  writeFileSync(copy, readFileSync(wrapper, "utf8").replaceAll("/var/backups/growth", backupDir));
  return { dir, backups, backupDir, copy };
}

// The producer boundary and the process/OS fact boundaries. Every other line runs unchanged.
function dayFacts(tableData: string) {
  return `export TABLE_DATA=${tableData}
stat() {
  if [[ "$1" != -c ]]; then command stat "$@"; return $?; fi
  if [[ "\${3:-}" == "$BACKUPS" ]]; then
    case "$2" in '%U') printf 'growth\\n'; return 0;; '%a') printf '700\\n'; return 0;; esac
  elif [[ "\${3:-}" == "$BACKUPS"/* ]]; then
    case "$2" in
      '%U') printf '%s\\n' "$FILE_OWNER"; return 0;;
      '%G') printf '%s\\n' "$FILE_GROUP"; return 0;;
      '%a') printf '%s\\n' "$FILE_MODE"; return 0;;
      '%F') printf 'regular file\\n'; return 0;;
      '%h') printf '%s\\n' "$FILE_NLINK"; return 0;;
      '%s') printf '%s\\n' "$FILE_SIZE"; return 0;;
      '%Y') if [[ "$FILE_MTIME" == real ]]; then command stat -c '%Y' "$3"; else printf '%s\\n' "$FILE_MTIME"; fi; return 0;;
    esac
  fi
  command stat "$@"
}
pg_restore() {
  local i
  for ((i = 0; i < TABLE_DATA; i++)); do printf '1; 0 0 TABLE DATA public t growth\\n'; done
}
secure_dir_chain() { printf 'chain\\n' >>"$events"; return 0; }
touch() { printf 'stamp\\n' >>"$events"; command touch "$@"; }
take_backup() {
  printf 'take\\n' >>"$events"
  local name="$BACKUPS/deploy-$(date -u +%Y%m%dT%H%M%SZ).dump"
  printf 'x%.0s' {1..2048} >"$name" || return 1
  printf 'dump: %s\\nsize: %s bytes\\nmode: 600\\ntable-data entries: %s\\n' "$name" 2048 "$TABLE_DATA"
}`;
}

function dayHarness(fixture: { copy: string }, tableData: string, body: string) {
  return `set +e
source "$WRAPPER"
set +e
python3_cmd() { command -v python3; }
marker=$(mktemp)
events=$(mktemp)
record_failure() { printf '%s\\n' "$1" >>"$marker"; printf 'FAIL code=%s\\n' "$1"; }
require_wrapper_integrity() { return 0; }
require_deploy_integrity() { return 0; }
require_cli() { return 0; }
FILE_OWNER=\${FILE_OWNER:-growth}
FILE_GROUP=\${FILE_GROUP:-growth}
FILE_MODE=\${FILE_MODE:-600}
FILE_NLINK=\${FILE_NLINK:-1}
FILE_SIZE=\${FILE_SIZE:-2048}
FILE_MTIME=\${FILE_MTIME:-real}
${dayFacts(tableData)}
${body}`;
}

describe("scheduled mailbox backup: one verified dump per UTC day", () => {
  it("takes and verifies the day's first dump when the UTC date has none", () => {
    const f = dayFixture();
    try {
      const result = bash(dayHarness(f, "52", `
receiptfile=$(mktemp)
dispatch_cli() { printf 'cli\\n' >>"$events"; printf '%s' "$1" >"$receiptfile"; printf '{"status":"completed","runId":"123e4567-e89b-42d3-a456-426614174000"}\\n'; }
run_once
printf 'status=%s\\n' "$?"
printf 'RECEIPT=%s\\n' "$(cat "$receiptfile")"
printf 'events=%s\\n' "$(tr '\\n' , <"$events")"
`), { WRAPPER: f.copy });
      expect(result.status).toBe(0);
      expect(result.output).toContain("BACKUP verified=1 reused=0");
      expect(result.output).toContain("SUCCESS backup=1 verified=1 cli_exit=0 run_id=123e4567-e89b-42d3-a456-426614174000 reused=0");
      expect(result.output).toContain('RECEIPT={"kind":"pg_dump","verified":true,"mode":"600",');
      expect(result.output).toContain('"reused":false}');
      expect(result.output).toContain("events=take,chain,cli,");
      const dumps = readdirSync(f.backups).filter((name) => /^deploy-\d{8}T\d{6}Z\.dump$/.test(name));
      expect(dumps).toHaveLength(1);
      expect(readFileSync(join(f.backups, dumps[0])).length).toBe(2048);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("reuses and re-verifies the day's dump and takes no new dump", () => {
    const f = dayFixture();
    const dayStart = Math.floor(Date.now() / 1000 / 86400) * 86400;
    const existing = join(f.backups, dumpName("000500"));
    try {
      writeFileSync(existing, "x".repeat(2048));
      // The day's dump is hours old: only the UTC day, never the 300-second window, may accept it.
      utimesSync(existing, dayStart, dayStart);
      const result = bash(dayHarness(f, "52", `
receiptfile=$(mktemp)
take_backup() { printf 'TAKE_SHOULD_NOT_RUN\\n'; return 0; }
dispatch_cli() { printf 'cli\\n' >>"$events"; printf '%s' "$1" >"$receiptfile"; printf '{"status":"completed","runId":"123e4567-e89b-42d3-a456-426614174000"}\\n'; }
run_once
printf 'status=%s\\n' "$?"
printf 'RECEIPT=%s\\n' "$(cat "$receiptfile")"
printf 'events=%s\\n' "$(tr '\\n' , <"$events")"
`), { WRAPPER: f.copy });
      expect(result.status).toBe(0);
      expect(result.output).not.toContain("TAKE_SHOULD_NOT_RUN");
      expect(result.output).toContain(`BACKUP verified=1 reused=1 path=${f.backupDir}/deploy-`);
      expect(result.output).toContain("SUCCESS backup=1 verified=1 cli_exit=0 run_id=123e4567-e89b-42d3-a456-426614174000 reused=1");
      expect(result.output).toContain('"reused":true}');
      expect(result.output).toContain("events=chain,stamp,cli,");
      const dumps = readdirSync(f.backups);
      expect(dumps).toEqual([dumpName("000500")]);
      // The reused dump was re-stamped so the private CLI's own 300-second file-age rule holds:
      // only the modification time moved, and the file is still the day's own bytes.
      const after = statSync(existing);
      expect(after.size).toBe(2048);
      expect(Date.now() - after.mtimeMs).toBeLessThan(60_000);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it.each([
    ["wrong mode", { FILE_MODE: "644" }],
    ["zero size", { FILE_SIZE: "0" }],
    ["below the table-data floor", {}, "49"],
    ["not today's timestamp", { FILE_MTIME: String(Math.floor(Date.now() / 1000) - 172800) }],
    ["wrong owner", { FILE_OWNER: "root" }],
    ["hard-linked", { FILE_NLINK: "2" }],
  ])("refuses and writes nothing when the day's dump is %s", (_label, env, tableData = "52") => {
    const f = dayFixture();
    const existing = join(f.backups, dumpName("060000"));
    try {
      writeFileSync(existing, "x".repeat(2048));
      const before = statSync(existing);
      const result = bash(dayHarness(f, tableData, `
take_backup() { printf 'TAKE_SHOULD_NOT_RUN\\n'; return 0; }
dispatch_cli() { printf 'CLI_SHOULD_NOT_RUN\\n'; }
run_once
printf 'status=%s\\n' "$?"
printf 'marker=%s\\n' "$(cat "$marker")"
`), { WRAPPER: f.copy, ...env });
      expect(result.status).toBe(0);
      expect(result.output).toContain("FAIL code=backup_reuse_invalid");
      expect(result.output).toContain("status=1");
      expect(result.output).toContain("marker=backup_reuse_invalid");
      expect(result.output).not.toMatch(/TAKE_SHOULD_NOT_RUN|CLI_SHOULD_NOT_RUN|SUCCESS/);
      const after = statSync(existing);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(readdirSync(f.backups)).toEqual([dumpName("060000")]);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("refuses a matching entry that is not a plain file and writes nothing", () => {
    const f = dayFixture();
    try {
      mkdirSync(join(f.backups, dumpName("070000")));
      const result = bash(dayHarness(f, "52", `
take_backup() { printf 'TAKE_SHOULD_NOT_RUN\\n'; return 0; }
dispatch_cli() { printf 'CLI_SHOULD_NOT_RUN\\n'; }
run_once
printf 'status=%s\\n' "$?"
printf 'marker=%s\\n' "$(cat "$marker")"
`), { WRAPPER: f.copy });
      expect(result.status).toBe(0);
      expect(result.output).toContain("FAIL code=backup_day_unsafe");
      expect(result.output).toContain("marker=backup_day_unsafe");
      expect(result.output).not.toMatch(/TAKE_SHOULD_NOT_RUN|CLI_SHOULD_NOT_RUN/);
      expect(statSync(join(f.backups, dumpName("070000"))).isDirectory()).toBe(true);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("reuses the newest dump of the day when the day holds several", () => {
    const f = dayFixture();
    try {
      const older = join(f.backups, dumpName("010000"));
      const newer = join(f.backups, dumpName("230000"));
      writeFileSync(older, "x".repeat(2048));
      writeFileSync(newer, "x".repeat(2048));
      const result = bash(dayHarness(f, "52", `
take_backup() { printf 'TAKE_SHOULD_NOT_RUN\\n'; return 0; }
printf 'candidate=%s\\n' "$(existing_today_backup)"
`), { WRAPPER: f.copy });
      expect(result.status).toBe(0);
      expect(result.output).toContain(`candidate=${f.backupDir}/${dumpName("230000")}`);
      expect(readdirSync(f.backups).sort()).toEqual([dumpName("010000"), dumpName("230000")].sort());
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("keeps a manual undo on a fresh dump even when the UTC day already has one", () => {
    const f = dayFixture();
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    try {
      writeFileSync(join(f.backups, dumpName("020000")), "x".repeat(2048));
      const result = bash(dayHarness(f, "52", `
receiptfile=$(mktemp)
systemctl() { case "$1 $2" in 'is-enabled growth-mailbox-sync.timer') printf 'disabled\\n';; *) printf 'inactive\\n';; esac; }
dispatch_cli() { printf 'cli:%s:%s\\n' "$2" "$3" >>"$events"; printf '%s' "$1" >"$receiptfile"; printf '{"status":"undone","runId":"${runId}","journalRows":4}\\n'; }
undo_once '${runId}'
printf 'status=%s\\n' "$?"
printf 'RECEIPT=%s\\n' "$(cat "$receiptfile")"
printf 'events=%s\\n' "$(tr '\\n' , <"$events")"
`), { WRAPPER: f.copy });
      expect(result.status).toBe(0);
      expect(result.output).toContain(`UNDO_SUCCESS status=undone run_id=${runId} journal_rows=4 backup=1 verified=1`);
      expect(result.output).toContain("events=");
      expect(result.output).toMatch(/events=[^\\n]*take,/);
      expect(result.output).toContain('"reused":false}');
      expect(result.output).not.toContain('"reused":true}');
      const dumps = readdirSync(f.backups).filter((name) => /^deploy-\d{8}T\d{6}Z\.dump$/.test(name));
      expect(dumps).toHaveLength(2);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("accepts a dump timestamp only on the current UTC date", () => {
    const result = bash(harness(`
now=1700000000
day=$((now / 86400 * 86400))
for t in "$now $now" "$day $now" "$((day - 1)) $now" "$((now + 1)) $now" "$((day + 86400)) $now" ""; do
  set -- $t
  if validate_backup_is_today "\${1:-}" "\${2:-}"; then printf 'OK %s\\n' "\${1:-empty}"; else printf 'NO %s\\n' "\${1:-empty}"; fi
done`));
    expect(result.status).toBe(0);
    expect(result.output).toContain("OK 1700000000");
    expect(result.output.match(new RegExp(`OK ${1700000000 - (1700000000 % 86400)}`, "g"))).toHaveLength(1);
    expect(result.output.match(/^NO /gm)).toHaveLength(4);
  });
});
