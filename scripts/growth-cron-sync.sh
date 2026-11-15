#!/usr/bin/env bash
# Root entry point for the future scheduled mailbox sync.
# This file is deliberately fail-closed: it never enables a route or a timer.
set -euo pipefail

readonly APP=/home/growth/app
readonly RUNTIME=/usr/local/lib/growth-mailbox-sync
readonly SNAPSHOT="$RUNTIME/app"
readonly DEPLOY="$RUNTIME/deploy.sh"
readonly DEPLOY_SHA256=a8cc605ca1dfe323f1b3b7ce1d123e1ae3f8197268fc9339399b2d37b593f8c6
readonly BACKUPS=/var/backups/growth
readonly CLI="$SNAPSHOT/scripts/scheduled-mailbox-sync.ts"
readonly TSX="$SNAPSHOT/node_modules/.bin/tsx"
readonly TSX_TARGET="$SNAPSHOT/node_modules/tsx/dist/cli.mjs"
readonly CONFIG="$SNAPSHOT/tsconfig.json"
readonly NODE=/usr/bin/node
readonly LOCKFILE=/run/growth-mailbox-sync/lock
readonly FAILURE_MARKER=/var/lib/growth/scheduled-mailbox-sync.failure
readonly MIN_SIZE=1024
readonly MIN_TABLE_DATA=50
readonly MAX_BACKUP_AGE=300

LOCK_FD=9
INVOCATION_EPOCH=0
BACKUP_PATH=''
BACKUP_SIZE=0
BACKUP_MODE=''
BACKUP_TABLE_DATA=0
BACKUP_RECEIPT=''

# All failure output is a fixed code. Command diagnostics are intentionally discarded.
record_failure() {
  local code=$1 tmp
  logger -t growth-scheduled-mailbox-sync "failure_code=$code" >/dev/null 2>&1 || true
  if failure_marker_safe; then
    if [[ -e "$FAILURE_MARKER" ]]; then
      # Never follow, replace, chown, or chmod an unsafe existing target.
      if [[ -f "$FAILURE_MARKER" && ! -L "$FAILURE_MARKER" ]]; then
        printf '%s\n' "$code" >"$FAILURE_MARKER" 2>/dev/null || true
      fi
    else
      umask 077
      tmp=$(mktemp "$FAILURE_MARKER.tmp.XXXXXX" 2>/dev/null) || tmp=''
      if [[ -n "$tmp" ]]; then
        printf '%s\n' "$code" >"$tmp" 2>/dev/null || true
        chown root:root "$tmp" >/dev/null 2>&1 || true
        chmod 600 "$tmp" >/dev/null 2>&1 || true
        # A hard-link publish is atomic and cannot clobber a concurrent marker.
        ln "$tmp" "$FAILURE_MARKER" 2>/dev/null || true
        rm -f -- "$tmp" 2>/dev/null || true
      fi
    fi
  fi
  printf 'FAIL code=%s\n' "$code"
}

fail() {
  record_failure "$1"
  return 1
}

secure_existing_path() {
  local path=$1 owner mode kind
  [[ -e "$path" && ! -L "$path" ]] || return 1
  owner=$(stat -c '%U' "$path" 2>/dev/null) || return 1
  mode=$(stat -c '%a' "$path" 2>/dev/null) || return 1
  kind=$(stat -c '%F' "$path" 2>/dev/null) || return 1
  [[ "$owner" == root && "$mode" =~ ^[0-7][0145][0145]$ && "$kind" == "directory" ]] || return 1
}

secure_dir_chain() {
  local path=$1 part current=/
  [[ "$path" == /* ]] || return 1
  IFS=/ read -r -a parts <<<"${path#/}"
  for part in "${parts[@]}"; do
    [[ -n "$part" ]] || continue
    current="$current$part"
    secure_existing_path "$current" || return 1
    current="$current/"
  done
}

failure_marker_safe() {
  local parent=/var/lib/growth owner mode kind nlink
  secure_dir_chain "$parent" || return 1
  if [[ -e "$FAILURE_MARKER" || -L "$FAILURE_MARKER" ]]; then
    [[ -f "$FAILURE_MARKER" && ! -L "$FAILURE_MARKER" ]] || return 1
    owner=$(stat -c '%U' "$FAILURE_MARKER" 2>/dev/null) || return 1
    mode=$(stat -c '%a' "$FAILURE_MARKER" 2>/dev/null) || return 1
    kind=$(stat -c '%F' "$FAILURE_MARKER" 2>/dev/null) || return 1
    nlink=$(stat -c '%h' "$FAILURE_MARKER" 2>/dev/null) || return 1
    [[ "$owner" == root && "$mode" == 600 && "$kind" == "regular file" && "$nlink" == 1 ]] || return 1
  fi
}

require_wrapper_integrity() {
  local script manifest parent base line expected actual owner mode kind
  script=${BASH_SOURCE[0]}
  parent=$(dirname -- "$script")
  base=$(basename -- "$script")
  secure_dir_chain "$parent" || return 1
  [[ -f "$script" && ! -L "$script" ]] || return 1
  owner=$(stat -c '%U' "$script" 2>/dev/null) || return 1
  mode=$(stat -c '%a' "$script" 2>/dev/null) || return 1
  kind=$(stat -c '%F' "$script" 2>/dev/null) || return 1
  [[ "$owner" == root && "$mode" =~ ^[0-7][0145][0145]$ && "$kind" == "regular file" ]] || return 1
  manifest="$parent/SHA256SUMS"
  [[ -f "$manifest" && ! -L "$manifest" ]] || return 1
  owner=$(stat -c '%U' "$manifest" 2>/dev/null) || return 1
  mode=$(stat -c '%a' "$manifest" 2>/dev/null) || return 1
  [[ "$owner" == root && "$mode" =~ ^[0-7][0145][0145]$ ]] || return 1
  line=$(grep -E "^[0-9a-f]{64}[[:space:]]+${base//./\\.}$" "$manifest" 2>/dev/null) || return 1
  [[ "$(printf '%s\n' "$line" | wc -l)" == 1 ]] || return 1
  expected=${line%%[[:space:]]*}
  actual=$(sha256sum "$script" 2>/dev/null) || return 1
  [[ "${actual%% *}" == "$expected" ]] || return 1
  (cd -- "$parent" && sha256sum -c SHA256SUMS >/dev/null 2>&1)
}

require_node() {
  local resolved
  secure_dir_chain /usr/bin || return 1
  [[ -f "$NODE" && ! -L "$NODE" ]] || return 1
  [[ "$(stat -c '%U:%G:%a:%F:%h' "$NODE")" == "root:root:755:regular file:1" ]] || return 1
  resolved=$(readlink -f -- "$NODE") || return 1
  [[ "$resolved" == "$NODE" ]]
}
require_snapshot_file() {
  local path=$1 resolved owner mode kind nlink
  [[ -f "$path" && ! -L "$path" ]] || return 1
  owner=$(stat -c '%U' "$path") || return 1; mode=$(stat -c '%a' "$path") || return 1
  kind=$(stat -c '%F' "$path") || return 1; nlink=$(stat -c '%h' "$path") || return 1
  [[ "$owner" == root && "$mode" =~ ^[0-7][0145][0145]$ && "$kind" == "regular file" && "$nlink" == 1 ]] || return 1
  resolved=$(readlink -f -- "$path") || return 1
  [[ "$resolved" == "$SNAPSHOT"/* ]]
}
require_snapshot_integrity() {
  local p resolved
  secure_dir_chain "$RUNTIME" || return 1
  [[ -d "$SNAPSHOT" && ! -L "$SNAPSHOT" ]] || return 1
  [[ "$(stat -c '%U:%G:%a' "$SNAPSHOT")" == "root:root:755" ]] || return 1
  [[ -f "$RUNTIME/protected-manifest" && ! -L "$RUNTIME/protected-manifest" ]] || return 1
  [[ "$(stat -c '%U:%G:%a' "$RUNTIME/protected-manifest")" == "root:root:644" ]] || return 1
  (cd "$SNAPSHOT" && sha256sum -c ../protected-manifest >/dev/null 2>&1) || return 1
  /usr/bin/python3 -I -c '
import os, stat, sys
root = os.path.realpath(sys.argv[1])
def check(p):
    s = os.lstat(p)
    if s.st_uid != 0: raise ValueError("owner")
    if stat.S_ISLNK(s.st_mode):
        if s.st_nlink != 1 or os.path.isabs(os.readlink(p)) or not os.path.realpath(p).startswith(root + os.sep): raise ValueError("link")
        if not os.path.exists(p): raise ValueError("broken")
    elif stat.S_ISDIR(s.st_mode):
        if s.st_mode & 0o022: raise ValueError("directory")
    elif stat.S_ISREG(s.st_mode):
        if s.st_nlink != 1 or s.st_mode & 0o022: raise ValueError("file")
    else: raise ValueError("special")
def failed(error): raise error
try:
    check(root)
    for parent, dirs, files in os.walk(root, followlinks=False, onerror=failed):
        for name in dirs + files: check(os.path.join(parent, name))
except (OSError, ValueError): sys.exit(1)
' "$SNAPSHOT" 2>/dev/null || return 1
  require_snapshot_file "$CLI" || return 1
  require_snapshot_file "$CONFIG" || return 1
  require_snapshot_file "$TSX_TARGET" || return 1
  resolved=$(readlink -f -- "$TSX") || return 1
  [[ "$resolved" == "$TSX_TARGET" ]]
}
require_cli() { require_snapshot_integrity && require_node; }

require_deploy_integrity() {
  local actual actual_hash owner mode
  secure_dir_chain "$(dirname -- "$DEPLOY")" || return 1
  [[ -f "$DEPLOY" && ! -L "$DEPLOY" ]] || return 1
  actual=$(sha256sum "$DEPLOY" 2>/dev/null) || return 1
  actual_hash=${actual%% *}
  [[ "$actual_hash" == "$DEPLOY_SHA256" ]] || return 1
  owner=$(stat -c '%U' "$DEPLOY" 2>/dev/null) || return 1
  mode=$(stat -c '%a' "$DEPLOY" 2>/dev/null) || return 1
  [[ "$owner" == root && "$mode" =~ ^[0-7][0145][0145]$ ]] || return 1
  (cd "$(dirname "$DEPLOY")" && sha256sum -c SHA256SUMS >/dev/null 2>&1)
}

acquire_lock() {
  secure_dir_chain /run/growth-mailbox-sync || return 1
  if [[ -e "$LOCKFILE" || -L "$LOCKFILE" ]]; then
    [[ -f "$LOCKFILE" && ! -L "$LOCKFILE" && "$(stat -c '%U:%G:%a:%h' "$LOCKFILE")" == root:root:600:1 ]] || return 1
  fi
  umask 077
  exec {LOCK_FD}>"$LOCKFILE" 2>/dev/null || return 1
  flock -n "$LOCK_FD"
}

# This is the only backup producer. Refuse a same-second target before calling it.
take_backup() { bash "$DEPLOY" dump 2>/dev/null; }
raw_take_backup() {
  local target="$BACKUPS/deploy-$(date -u +%Y%m%dT%H%M%SZ).dump"
  [[ ! -e "$target" && ! -L "$target" ]] || return 1
  take_backup
}

parse_receipt() {
  local raw=$1 line lines=0
  BACKUP_PATH=''; BACKUP_SIZE=0; BACKUP_MODE=''; BACKUP_TABLE_DATA=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == '== verified backup ==' ]] && continue
    if [[ "$line" =~ ^dump:\ (.+)$ ]]; then
      [[ -z "$BACKUP_PATH" ]] || return 1
      BACKUP_PATH=${BASH_REMATCH[1]}
    elif [[ "$line" =~ ^size:\ ([0-9]+)\ bytes$ ]]; then
      [[ "$BACKUP_SIZE" == 0 ]] || return 1
      BACKUP_SIZE=${BASH_REMATCH[1]}
    elif [[ "$line" =~ ^mode:\ ([0-9]{3,4})$ ]]; then
      [[ -z "$BACKUP_MODE" ]] || return 1
      BACKUP_MODE=${BASH_REMATCH[1]}
    elif [[ "$line" =~ ^table-data\ entries:\ ([0-9]+)$ ]]; then
      [[ "$BACKUP_TABLE_DATA" == 0 ]] || return 1
      BACKUP_TABLE_DATA=${BASH_REMATCH[1]}
    else
      return 1
    fi
    lines=$((lines + 1))
  done <<<"$raw"
  [[ "$lines" == 4 && "$BACKUP_PATH" =~ ^/var/backups/growth/deploy-[0-9]{8}T[0-9]{6}Z\.dump$ && "$BACKUP_SIZE" =~ ^[1-9][0-9]*$ && "$BACKUP_MODE" == 600 && "$BACKUP_TABLE_DATA" =~ ^[0-9]+$ ]]
}

validate_backup_listing() {
  local listing=$1 producer_status=$2 entries
  [[ "$producer_status" == 0 ]] || return 1
  entries=$(printf '%s\n' "$listing" | grep -c 'TABLE DATA') || return 1
  [[ "$entries" =~ ^[0-9]+$ && "$entries" -ge "$MIN_TABLE_DATA" && "$entries" == "$BACKUP_TABLE_DATA" ]]
}

validate_backup_time() {
  local mtime=$1 invocation=$2 now=$3
  [[ "$mtime" =~ ^[0-9]+$ && "$invocation" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ ]] || return 1
  [[ "$mtime" -ge "$invocation" && "$mtime" -le "$now" && $((now - mtime)) -le "$MAX_BACKUP_AGE" ]]
}

verify_backup() {
  local path=$1 invocation=$2 size mode owner file_type mtime now entries listing real_path producer_status
  [[ "$path" =~ ^/var/backups/growth/deploy-[0-9]{8}T[0-9]{6}Z\.dump$ ]] || return 1
  secure_dir_chain /var/backups || return 1
  # The approved dump producer writes as growth into this existing private growth-owned directory.
  [[ -d "$BACKUPS" && ! -L "$BACKUPS" ]] || return 1
  [[ "$(stat -c '%U' "$BACKUPS" 2>/dev/null)" == growth && "$(stat -c '%a' "$BACKUPS" 2>/dev/null)" == 700 ]] || return 1
  [[ "$(readlink -f -- "$BACKUPS" 2>/dev/null)" == "$BACKUPS" ]] || return 1
  [[ -f "$path" && ! -L "$path" ]] || return 1
  real_path=$(readlink -f -- "$path" 2>/dev/null) || return 1
  [[ "$real_path" == "$path" ]] || return 1
  owner=$(stat -c '%U' "$path" 2>/dev/null) || return 1
  mode=$(stat -c '%a' "$path" 2>/dev/null) || return 1
  file_type=$(stat -c '%F' "$path" 2>/dev/null) || return 1
  [[ "$owner" == growth && "$mode" == 600 && "$file_type" == "regular file" ]] || return 1
  size=$(stat -c '%s' "$path" 2>/dev/null) || return 1
  [[ "$size" =~ ^[0-9]+$ && "$size" -ge "$MIN_SIZE" && "$size" == "$BACKUP_SIZE" ]] || return 1
  mtime=$(stat -c '%Y' "$path" 2>/dev/null) || return 1
  now=$(date +%s) || return 1
  validate_backup_time "$mtime" "$invocation" "$now" || return 1
  if listing=$(pg_restore --list "$path" 2>/dev/null); then
    producer_status=0
  else
    producer_status=$?
  fi
  validate_backup_listing "$listing" "$producer_status"
}

verified_receipt_json() {
  [[ "$BACKUP_PATH" =~ ^/var/backups/growth/deploy-[0-9]{8}T[0-9]{6}Z\.dump$ && "$BACKUP_MODE" == 600 ]] || return 1
  printf '{"kind":"pg_dump","verified":true,"mode":"600","path":"%s","sizeBytes":%s,"tableDataCount":%s,"verifiedAt":"%s"}\n' \
    "$BACKUP_PATH" "$BACKUP_SIZE" "$BACKUP_TABLE_DATA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

# The CLI loads the service environment itself in this fixed, non-secret-bearing command.
dispatch_cli() {
  local receipt=$1
  [[ "$#" == 1 ]] || return 1
  sudo -n -u growth -- env -i HOME=/home/growth USER=growth LOGNAME=growth PATH=/usr/bin:/bin NODE_ENV=production TSX_DISABLE_CACHE=1 \
    "$NODE" "$TSX" --tsconfig "$CONFIG" "$CLI" <<<"$receipt" >/dev/null 2>&1
}

run_once() {
  local raw receipt
  INVOCATION_EPOCH=$(date +%s) || return 1
  require_cli || { fail cli_missing; return 1; }
  raw=$(raw_take_backup) || { fail backup_failed; return 1; }
  parse_receipt "$raw" || { fail backup_receipt_invalid; return 1; }
  verify_backup "$BACKUP_PATH" "$INVOCATION_EPOCH" || { fail backup_verify_failed; return 1; }
  receipt=$(verified_receipt_json) || { fail receipt_build_failed; return 1; }
  dispatch_cli "$receipt" || { fail cli_failed; return 1; }
  printf 'SUCCESS backup=1 verified=1 cli_exit=0\n'
}

main() {
  [[ "$#" == 0 ]] || { fail invalid_args; return 1; }
  require_wrapper_integrity || { fail wrapper_integrity; return 1; }
  require_deploy_integrity || { fail deploy_integrity; return 1; }
  require_cli || { fail cli_missing; return 1; }
  acquire_lock || { fail lock_busy; return 1; }
  run_once
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
