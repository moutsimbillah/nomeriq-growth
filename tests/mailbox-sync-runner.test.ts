import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const wrapper = join(process.cwd(), "scripts", "growth-cron-sync.sh");
const scratch = process.env.TMPDIR;
if (!scratch) throw new Error("TMPDIR must be the active growth-profile scratch directory");

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
set +e
marker=$(mktemp)
record_failure() { printf '%s\\n' "$1" >>"$marker"; printf 'FAIL code=%s\\n' "$1"; }
require_wrapper_integrity() { return 0; }
require_deploy_integrity() { return 0; }
require_cli() { return 0; }
${body}`;
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
    expect(source).not.toMatch(/npm exec|\.growth\.env|curl|wget|systemctl|crontab|ssh/);
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
dispatch_cli() { printf 'cli\\n' >>"$order"; [[ "$1" == '{"kind":"pg_dump","verified":true,"mode":"600","path":"/var/backups/growth/deploy-20261114T120000Z.dump",'* ]]; }
run_once
printf 'order=%s\\n' "$(tr '\\n' , <"$order")"
`));
    expect(result.status).toBe(0);
    expect(result.output).toContain("SUCCESS backup=1 verified=1 cli_exit=0");
    expect(result.output).toContain("order=backup,verify,cli,");
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

  it("propagates the real main failure status and refuses unknown arguments", () => {
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
    const dir = mkdtempSync(join(scratch!, "growth-lock-"));
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
