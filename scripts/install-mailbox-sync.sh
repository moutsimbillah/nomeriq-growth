#!/usr/bin/env bash
# Reviewed mailbox-only installer; execute only after founder approval on the real host.
set -euo pipefail

readonly RELEASE_SHA_RE='^[0-9a-f]{40}$'
readonly APP_ROOT=/home/growth/app
readonly RUNTIME_DIR=/usr/local/lib/growth-mailbox-sync
readonly DEPLOY="$RUNTIME_DIR/deploy.sh"
readonly QUARANTINE_ROOT=/usr/local/lib/growth-mailbox-sync-quarantine
readonly UNIT_DIR=/etc/systemd/system
readonly SERVICE=growth-mailbox-sync.service
readonly TIMER=growth-mailbox-sync.timer
readonly ALERT=growth-cron-alert.service
readonly EXPECTED_DEPLOY_SHA=a8cc605ca1dfe323f1b3b7ce1d123e1ae3f8197268fc9339399b2d37b593f8c6
readonly ORIGINAL_DEPLOY=/home/growth/deploy/deploy.sh
readonly BACKUP_DIR=/var/backups/growth
readonly SOURCE_DIR=$APP_ROOT
readonly MANAGED_MARKER=.managed-mailbox-sync-release
readonly INSTALL_STATE=.install-state
readonly SNAPSHOT_MANIFEST=protected-manifest

require_installer_trust() {
  local release=$1 script dir expected actual parent owner mode
  root_only || return 1
  script=$(readlink -f -- "${BASH_SOURCE[0]}") || return 1
  dir=$(dirname -- "$script")
  [[ "$dir" == "/home/ubuntu/growth-mailbox-install/$release" && ! -L "${BASH_SOURCE[0]}" ]] || return 1
  for parent in /home /home/ubuntu /home/ubuntu/growth-mailbox-install; do
    [[ -d "$parent" && ! -L "$parent" ]] || return 1
    owner=$(stat -c '%U' "$parent") || return 1; mode=$(stat -c '%a' "$parent") || return 1
    [[ "$owner" == root || "$owner" == ubuntu ]] || return 1
    [[ "$mode" =~ ^[0-7][0145][0145]$ ]] || return 1
  done
  [[ "$(stat -c '%U:%G:%a:%F' "$dir")" == root:root:755:directory ]] || return 1
  trusted_file "$script" && trusted_file "$dir/INSTALLER-BLOB-SHA" || return 1
  expected=$(git_growth rev-parse "$release:scripts/install-mailbox-sync.sh") || return 1
  actual=$(/usr/bin/git hash-object "$script") || return 1
  [[ "$actual" == "$expected" && "$(tr -d '\r\n' <"$dir/INSTALLER-BLOB-SHA")" == "$expected" ]] || return 1
}
log() { printf '%s\n' "$*"; }
refuse() { log "REFUSING: $*" >&2; return 1; }
root_only() { [[ "$(id -u)" == 0 ]] || refuse "installation steps require root"; }
valid_sha() { [[ "$1" =~ $RELEASE_SHA_RE ]]; }
git_growth() { sudo -n -u growth -- /usr/bin/git -C "$APP_ROOT" "$@"; }
trusted_file() {
  [[ -f "$1" && ! -L "$1" ]] || return 1
  [[ "$(stat -c '%U:%a:%h' "$1")" =~ ^root:[0-7][0145][0145]:1$ ]]
}
trusted_chain() {
  local remaining=${1#/} part current='' value
  while [[ -n "$remaining" ]]; do
    part=${remaining%%/*}; current="$current/$part"
    [[ -d "$current" && ! -L "$current" ]] || return 1
    value=$(stat -c '%U:%a' "$current") || return 1
    [[ "$value" =~ ^root:[0-7][0145][0145]$ ]] || return 1
    if [[ "$remaining" == */* ]]; then remaining=${remaining#*/}; else remaining=''; fi
  done
}

source_file() { case "$1" in
  core) printf '%s/scripts/growth-cron-sync.sh\n' "$SOURCE_DIR";;
  deploy) printf '%s/scripts/deploy.sh\n' "$SOURCE_DIR";;
  storage) printf '%s/scripts/mailbox-sync-storage-check.sh\n' "$SOURCE_DIR";;
  service) printf '%s/scripts/systemd/growth-mailbox-sync.service\n' "$SOURCE_DIR";;
  timer) printf '%s/scripts/systemd/growth-mailbox-sync.timer\n' "$SOURCE_DIR";;
  *) return 1;; esac; }

require_source_file() { local f; f=$(source_file "$1") || return 1; [[ -f "$f" && ! -L "$f" && -r "$f" ]] || refuse "missing source $1"; }
require_deploy_source() {
  local digest
  digest=$(git_growth show "$1:scripts/deploy.sh" | sha256sum) || return 1
  [[ "${digest%% *}" == "$EXPECTED_DEPLOY_SHA" ]]
}
require_release() {
  [[ $# == 1 ]] || { refuse "release SHA is required"; return 1; }
  valid_sha "$1" || { refuse "release SHA must be exactly 40 lowercase hex characters"; return 1; }
  git_growth rev-parse --verify "$1^{commit}" >/dev/null 2>&1 || { refuse "release SHA is not present"; return 1; }
  local head dirty
  head=$(git_growth rev-parse HEAD) || return 1
  [[ "$head" == "$1" ]] || { refuse "checkout HEAD is not the requested release"; return 1; }
  dirty=$(git_growth status --porcelain --untracked-files=all) || return 1
  [[ -z "$dirty" ]] || { refuse "checkout is dirty"; return 1; }
  for f in scripts/deploy.sh scripts/growth-cron-sync.sh scripts/mailbox-sync-storage-check.sh scripts/systemd/growth-mailbox-sync.service scripts/systemd/growth-mailbox-sync.timer scripts/scheduled-mailbox-sync.ts scripts/pgx.py tsconfig.json package.json; do
    git_growth cat-file -e "$1:$f" || { refuse "release lacks $f"; return 1; }
  done
}
require_external_location() { [[ "$APP_ROOT" == /home/growth/app ]] || refuse "application root is not fixed"; }
require_unit_integrity() {
  local release phase
  trusted_chain "$RUNTIME_DIR" || return 1
  trusted_file "$UNIT_DIR/$SERVICE" && trusted_file "$UNIT_DIR/$TIMER" && trusted_file "$RUNTIME_DIR/$MANAGED_MARKER" || return 1
  trusted_file "$RUNTIME_DIR/$INSTALL_STATE" || return 1
  phase=$(awk -F= '$1 == "phase" {print $2}' "$RUNTIME_DIR/$INSTALL_STATE") || return 1
  [[ "$phase" == runtime-published || "$phase" == service-installed || "$phase" == timer-installed || "$phase" == complete ]] || return 1
  trusted_file "$RUNTIME_DIR/growth-cron-sync.sh" && trusted_file "$RUNTIME_DIR/SHA256SUMS" && trusted_file "$RUNTIME_DIR/protected-manifest" || return 1
  release=$(<"$RUNTIME_DIR/$MANAGED_MARKER"); release=${release#release_sha=}
  valid_sha "$release" || return 1
  git_growth show "$release:scripts/growth-cron-sync.sh" | cmp -s - "$RUNTIME_DIR/growth-cron-sync.sh" || return 1
  cmp -s "$RUNTIME_DIR/units/$SERVICE" "$UNIT_DIR/$SERVICE" || return 1
  cmp -s "$RUNTIME_DIR/units/$TIMER" "$UNIT_DIR/$TIMER" || return 1
  (cd "$RUNTIME_DIR" && sha256sum -c SHA256SUMS >/dev/null 2>&1) || { refuse "runtime manifest check failed"; return 1; }
  bash -c 'source "$1"; require_wrapper_integrity && require_deploy_integrity && require_cli' -- "$RUNTIME_DIR/growth-cron-sync.sh" || return 1
}
require_install_state() {
  local expected=$1
  trusted_file "$RUNTIME_DIR/$INSTALL_STATE" || return 1
  [[ "$(awk -F= '$1 == "release_sha" {print $2}' "$RUNTIME_DIR/$INSTALL_STATE")" == "$expected" && "$(awk -F= '$1 == "phase" {print $2}' "$RUNTIME_DIR/$INSTALL_STATE")" == complete ]]
}
fresh_verified_backup() {
  local producer=${1:-$DEPLOY} raw line path='' size='' mode='' entries='' listing count expected started stamp now
  [[ -f "$producer" && ! -L "$producer" ]] || return 1
  expected=$(sha256sum "$producer") || return 1
  [[ "${expected%% *}" == "$EXPECTED_DEPLOY_SHA" ]] || return 1
  trusted_chain /var/backups || return 1
  [[ -d "$BACKUP_DIR" && ! -L "$BACKUP_DIR" && "$(stat -c '%U:%a' "$BACKUP_DIR")" == growth:700 && "$(readlink -f -- "$BACKUP_DIR")" == "$BACKUP_DIR" ]] || return 1
  started=$(date +%s) || return 1
  expected="$BACKUP_DIR/deploy-$(date -u +%Y%m%dT%H%M%SZ).dump"
  [[ ! -e "$expected" && ! -L "$expected" ]] || { refuse "fresh backup target already exists"; return 1; }
  raw=$(bash "$producer" dump 2>/dev/null) || { refuse "fresh backup failed"; return 1; }
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == '== verified backup ==' ]] && continue
    if [[ "$line" =~ ^dump:\ (.+)$ && -z "$path" ]]; then path=${BASH_REMATCH[1]}
    elif [[ "$line" =~ ^size:\ ([0-9]+)\ bytes$ && -z "$size" ]]; then size=${BASH_REMATCH[1]}
    elif [[ "$line" =~ ^mode:\ ([0-9]{3,4})$ && -z "$mode" ]]; then mode=${BASH_REMATCH[1]}
    elif [[ "$line" =~ ^table-data\ entries:\ ([0-9]+)$ && -z "$entries" ]]; then entries=${BASH_REMATCH[1]}
    else refuse "fresh backup receipt invalid"; return 1; fi
  done <<<"$raw"
  [[ "$path" =~ ^/var/backups/growth/deploy-[0-9]{8}T[0-9]{6}Z\.dump$ && "$size" =~ ^[1-9][0-9]*$ && "$mode" == 600 && "$entries" =~ ^[0-9]+$ ]] || return 1
  [[ -f "$path" && ! -L "$path" && "$(readlink -f -- "$path")" == "$path" ]] || return 1
  [[ "$(stat -c '%U:%a:%h:%s' "$path")" == "growth:600:1:$size" && "$size" -ge 1024 ]] || return 1
  stamp=$(stat -c '%Y' "$path") || return 1; now=$(date +%s) || return 1
  [[ "$stamp" -ge "$started" && "$stamp" -le "$now" && $((now-stamp)) -le 300 ]] || return 1
  listing=$(pg_restore --list "$path" 2>/dev/null) || return 1
  count=$(printf '%s\n' "$listing" | grep -c 'TABLE DATA') || return 1
  [[ "$count" -ge 50 && "$count" == "$entries" ]]
}

require_migration_035() {
  [[ -x "$APP_ROOT/scripts/pgx.py" || -f "$APP_ROOT/scripts/pgx.py" ]] || { refuse "application database helper missing"; return 1; }
  sudo -n -u growth python3 "$APP_ROOT/scripts/pgx.py" psql -d growth -X -A -t \
    -c "SELECT 1 FROM _migrations WHERE id='035_mailbox_sync_journal.sql'" 2>/dev/null | grep -Fxq 1 || {
      refuse "migration 035 is not applied"; return 1;
    }
}

record_fact() { local f=$1 hash; hash=$(sha256sum "$f" | awk '{print $1}'); stat -c "fact path=%n owner=%U:%G mode=%a sha256=$hash" "$f"; }
dependency_file_is_credential_like() {
  local path=$1 relative digest
  relative=${path#"$APP_ROOT/node_modules/"}
  case "$relative" in
    caniuse-lite/data/features/credential-management.js)
      digest=$(sha256sum -- "$path") || return 0
      [[ "${digest%% *}" != 9c4732ae7346e5488daeeb8ea5abd0cd0655d020f9a11499d54553576a87712f ]]
      return
      ;;
  esac
  case "${path##*/}" in
    .env*|.npmrc|*.pem|*credential*|auth.json) return 0 ;;
    *) return 1 ;;
  esac
}
scan_dependency_credentials() {
  local root=$1 f bad='' scan_fd scan_pid
  exec {scan_fd}< <(find "$root" -type f \( -name '.env*' -o -name '.npmrc' -o -name '*.pem' -o -name '*credential*' -o -name 'auth.json' \) -print0)
  scan_pid=$!
  while IFS= read -r -d '' f <&"$scan_fd"; do
    if dependency_file_is_credential_like "$f" && [[ -z "$bad" ]]; then bad=$f; fi
  done
  exec {scan_fd}<&-
  wait "$scan_pid" || return 1
  [[ -z "$bad" ]] || { refuse "credential-like dependency file; nothing copied"; return 1; }
}
assert_managed_or_absent() {
  local target=$1 src=$2
  if [[ -e "$target" || -L "$target" ]]; then
    [[ -f "$target" && ! -L "$target" ]] || refuse "unmanaged collision at $target"
    cmp -s "$src" "$target" || refuse "refusing overwrite of non-identical managed file $target"
  fi
}

install_runtime() {
  local release=$1 stage f resolved paths phase
  root_only || return 1; require_release "$release" || return 1
  require_deploy_source "$release" || return 1
  [[ ! -e "$QUARANTINE_ROOT/$release" && ! -L "$QUARANTINE_ROOT/$release" ]] || { refuse "quarantined release cannot be reinstalled"; return 1; }
  if [[ -d "$RUNTIME_DIR" && ! -L "$RUNTIME_DIR" ]]; then
    trusted_chain "$RUNTIME_DIR" && trusted_file "$RUNTIME_DIR/$MANAGED_MARKER" || return 1
    [[ -f "$RUNTIME_DIR/$MANAGED_MARKER" && "$(<"$RUNTIME_DIR/$MANAGED_MARKER")" == "release_sha=$release" ]] || return 1
    require_install_state "$release" || { refuse "incomplete installation remains; quarantine it before retrying"; return 1; }
    require_unit_integrity || return 1
    log "release already installed; exact managed bytes retained"
    return 0
  fi
  for f in "$RUNTIME_DIR" "$UNIT_DIR/$SERVICE" "$UNIT_DIR/$TIMER"; do
    [[ ! -e "$f" && ! -L "$f" ]] || { refuse "unmanaged installation collision"; return 1; }
  done
  trusted_chain /usr/local/lib && trusted_chain "$UNIT_DIR" || return 1
  [[ "$(systemctl show "$ALERT" -p LoadState --value)" == loaded ]] || return 1
  [[ -d "$APP_ROOT/node_modules" && ! -L "$APP_ROOT/node_modules" ]] || return 1
  scan_dependency_credentials "$APP_ROOT/node_modules" || return 1
  fresh_verified_backup "$ORIGINAL_DEPLOY" || return 1
  stage="$RUNTIME_DIR.staging.$$.${release}"
  [[ ! -e "$stage" && ! -L "$stage" ]] || return 1
  install -o root -g root -m 0755 -d "$stage" "$stage/app" "$stage/units" || return 1
  git_growth archive --format=tar "$release" src scripts/scheduled-mailbox-sync.ts scripts/pgx.py tsconfig.json package.json | tar -xf - -C "$stage/app" || return 1
  for f in growth-cron-sync.sh mailbox-sync-storage-check.sh deploy.sh; do git_growth show "$release:scripts/$f" >"$stage/$f" || return 1; done
  for f in "$SERVICE" "$TIMER"; do git_growth show "$release:scripts/systemd/$f" >"$stage/units/$f" || return 1; done
  cp -a --reflink=never --no-preserve=ownership,links "$APP_ROOT/node_modules" "$stage/app/node_modules" || { refuse "physical dependency snapshot failed; preserved stage $stage"; return 1; }
  paths=$(find "$stage/app" -mindepth 1 -print) || return 1
  while IFS= read -r f; do
    if [[ -L "$f" ]]; then
      [[ "$(readlink -- "$f")" != /* ]] || return 1
      resolved=$(readlink -f -- "$f") || return 1
      [[ -e "$f" && "$resolved" == "$stage/app"/* ]] || return 1
    elif [[ -f "$f" ]]; then [[ "$(stat -c '%h' "$f")" == 1 ]] || return 1
    elif [[ ! -d "$f" ]]; then return 1; fi
  done <<<"$paths"
  printf 'release_sha=%s\n' "$release" >"$stage/$MANAGED_MARKER" || return 1
  chown -R root:root "$stage" || return 1
  find "$stage" -type d -exec chmod 755 {} + || return 1
  find "$stage" -type f ! -perm /111 -exec chmod 644 {} + || return 1
  find "$stage" -type f -perm /111 -exec chmod 755 {} + || return 1
  chmod 750 "$stage/growth-cron-sync.sh" "$stage/mailbox-sync-storage-check.sh" || return 1
  chmod 640 "$stage/deploy.sh" "$stage/$MANAGED_MARKER" || return 1
  (cd "$stage/app" && find . -type f -exec sha256sum {} + >"../$SNAPSHOT_MANIFEST") || return 1
  chmod 644 "$stage/$SNAPSHOT_MANIFEST" || return 1
  (cd "$stage" && sha256sum deploy.sh growth-cron-sync.sh mailbox-sync-storage-check.sh "$MANAGED_MARKER" "$SNAPSHOT_MANIFEST" "units/$SERVICE" "units/$TIMER" >SHA256SUMS) || return 1
  chmod 640 "$stage/SHA256SUMS" || return 1
  printf 'release_sha=%s\nphase=runtime-published\nservice_installed=0\ntimer_installed=0\n' "$release" >"$stage/$INSTALL_STATE" || return 1
  chmod 640 "$stage/$INSTALL_STATE" || return 1
  mv -- "$stage" "$RUNTIME_DIR" || { refuse "runtime publish failed; preserved stage $stage"; return 1; }
  install -o root -g root -m 0644 "$RUNTIME_DIR/units/$SERVICE" "$UNIT_DIR/$SERVICE" || return 1
  printf 'release_sha=%s\nphase=service-installed\nservice_installed=1\ntimer_installed=0\n' "$release" >"$RUNTIME_DIR/$INSTALL_STATE" || return 1
  install -o root -g root -m 0644 "$RUNTIME_DIR/units/$TIMER" "$UNIT_DIR/$TIMER" || return 1
  printf 'release_sha=%s\nphase=timer-installed\nservice_installed=1\ntimer_installed=1\n' "$release" >"$RUNTIME_DIR/$INSTALL_STATE" || return 1
  systemctl daemon-reload || return 1
  require_unit_integrity || return 1
  [[ "$(systemctl is-enabled "$TIMER" 2>/dev/null || true)" == disabled && "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == inactive ]] || return 1
  printf 'release_sha=%s\nphase=complete\nservice_installed=1\ntimer_installed=1\n' "$release" >"$RUNTIME_DIR/$INSTALL_STATE" || return 1
  log "installed release=$release; units remain disabled and stopped"
}

run_once() {
  local release=$1 marker="$RUNTIME_DIR/first-sync.ok" status active result
  root_only || return 1; require_release "$release" || return 1; require_external_location || return 1
  [[ -f "$RUNTIME_DIR/$MANAGED_MARKER" ]] || return 1
  grep -Fxq "release_sha=$release" "$RUNTIME_DIR/$MANAGED_MARKER" || return 1
  require_unit_integrity || return 1
  require_install_state "$release" || { refuse "installation is not complete"; return 1; }
  require_migration_035 || return 1
  [[ "$(systemctl show "$ALERT" -p LoadState --value)" == loaded ]] || return 1
  [[ "$(systemctl is-enabled "$TIMER" 2>/dev/null || true)" == disabled ]] || return 1
  [[ ! -e "$marker" && ! -L "$marker" ]] || return 1
  systemctl start "$SERVICE" || return 1
  status=$(systemctl show "$SERVICE" -p ExecMainStatus --value) || return 1
  result=$(systemctl show "$SERVICE" -p Result --value) || return 1
  active=$(systemctl is-active "$SERVICE" 2>/dev/null || true)
  [[ "$result" == success && "$status" == 0 && "$active" == "inactive" ]] || return 1
  (set -o noclobber; umask 077; printf 'release_sha=%s\nstatus=0\n' "$release" >"$marker") || return 1
  log "initial approved live import succeeded; first-sync marker recorded"
}

enable_timer() {
  local release=$1
  root_only || return 1; require_release "$release" || return 1; require_external_location || return 1
  trusted_file "$RUNTIME_DIR/first-sync.ok" || { refuse "first successful sync is required"; return 1; }
  grep -Fxq "release_sha=$release" "$RUNTIME_DIR/first-sync.ok" || return 1
  require_unit_integrity || return 1
  require_install_state "$release" || { refuse "installation is not complete"; return 1; }
  require_migration_035 || return 1
  [[ "$(systemctl is-enabled "$TIMER" 2>/dev/null || true)" == disabled ]] || return 1
  [[ "$(systemctl show "$ALERT" -p LoadState --value)" == loaded ]] || return 1
  fresh_verified_backup || return 1
  systemctl enable --now "$TIMER" || return 1
  [[ "$(systemctl is-enabled "$TIMER")" == enabled && "$(systemctl is-active "$TIMER")" == active ]] || return 1
  log "only $TIMER was enabled and started"
}

disable_timer() {
  [[ $# == 1 ]] && valid_sha "$1" || return 1
  root_only || return 1
  trusted_file "$RUNTIME_DIR/$MANAGED_MARKER" || return 1
  grep -Fxq "release_sha=$1" "$RUNTIME_DIR/$MANAGED_MARKER" || return 1
  require_unit_integrity || return 1
  require_install_state "$1" || { refuse "installation is not complete"; return 1; }
  fresh_verified_backup || return 1
  systemctl disable --now "$TIMER" || return 1
  systemctl stop "$SERVICE" || return 1
  [[ "$(systemctl is-enabled "$TIMER" 2>/dev/null || true)" == disabled && "$(systemctl is-active "$TIMER" 2>/dev/null || true)" == inactive && "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == inactive ]] || return 1
  log "disabled only the new mailbox timer and service"
}

unit_is_release_prefix() {
  local release=$1 unit=$2 path=$3 expected actual
  trusted_file "$path" || return 1
  # Failed install(1) may leave a truncated file. Preserve it, but reject unrelated bytes.
  expected=$(git_growth show "$release:scripts/systemd/$unit" | od -An -v -tx1 | tr -d ' \n') || return 1
  actual=$(od -An -v -tx1 "$path" | tr -d ' \n') || return 1
  [[ -n "$expected" && "$expected" == "$actual"* ]]
}
publish_recovery_marker() {
  local target=$1 content=$2 tmp
  [[ ! -e "$target" && ! -L "$target" ]] || return 1
  tmp=$(mktemp "$target.pending.XXXXXXXX") || return 1
  printf '%s\n' "$content" >"$tmp" && chmod 640 "$tmp" && sync -f "$tmp" || return 1
  mv -T -n -- "$tmp" "$target" || return 1
  [[ ! -e "$tmp" && -f "$target" ]] || return 1
  sync -f "$(dirname -- "$target")"
}
acquire_quarantine_lock() {
  local dir=/run/growth-mailbox-sync path=/run/growth-mailbox-sync/lock
  trusted_chain /run || return 1
  if [[ -e "$dir" || -L "$dir" ]]; then
    [[ -d "$dir" && ! -L "$dir" && "$(stat -c '%U:%G:%a' "$dir")" == root:root:700 ]] || return 1
  else install -o root -g root -m 0700 -d "$dir" || return 1; fi
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -f "$path" && ! -L "$path" && "$(stat -c '%U:%G:%a:%h:%s' "$path")" == root:root:600:1:0 ]] || return 1
  fi
  umask 077
  exec {QUARANTINE_LOCK_FD}>"$path" || return 1
  flock -n "$QUARANTINE_LOCK_FD" || { refuse "mailbox writer is running; quarantine did not change it"; return 1; }
}
quarantine() (
  [[ $# == 1 ]] && valid_sha "$1" || return 1
  root_only || return 1
  local release=$1 dest="$QUARANTINE_ROOT/$1" state unit path other digest metadata runtime_identity
  local service_present=0 timer_present=0 service_hash=- timer_hash=- service_meta=- timer_meta=-
  trusted_chain "$UNIT_DIR" || return 1
  if [[ -e "$QUARANTINE_ROOT" || -L "$QUARANTINE_ROOT" ]]; then trusted_chain "$QUARANTINE_ROOT" || return 1; fi
  if [[ -e "$dest" || -L "$dest" ]]; then trusted_chain "$dest" || return 1; fi
  if [[ -e "$RUNTIME_DIR" || -L "$RUNTIME_DIR" ]]; then path=$RUNTIME_DIR; else path="$dest/runtime"; fi
  trusted_chain "$path" && trusted_file "$path/$MANAGED_MARKER" || return 1
  [[ "$(<"$path/$MANAGED_MARKER")" == "release_sha=$release" ]] || return 1
  runtime_identity=$(stat -c '%d:%i' "$path") || return 1
  if [[ -e "$dest/.quarantine-state" || -L "$dest/.quarantine-state" ]]; then
    trusted_file "$dest/.quarantine-state" || return 1
    state=$(<"$dest/.quarantine-state")
    [[ "$state" == "release_sha=$release"$'\n'* ]] || return 1
    service_present=$(awk -F= '$1=="service_present" {print $2}' "$dest/.quarantine-state")
    timer_present=$(awk -F= '$1=="timer_present" {print $2}' "$dest/.quarantine-state")
    service_hash=$(awk -F= '$1=="service_hash" {print $2}' "$dest/.quarantine-state")
    timer_hash=$(awk -F= '$1=="timer_hash" {print $2}' "$dest/.quarantine-state")
    service_meta=$(awk -F= '$1=="service_meta" {print $2}' "$dest/.quarantine-state")
    timer_meta=$(awk -F= '$1=="timer_meta" {print $2}' "$dest/.quarantine-state")
    [[ "$service_present" =~ ^[01]$ && "$timer_present" =~ ^[01]$ ]] || return 1
    [[ "$state" == "$(printf 'release_sha=%s\nruntime_identity=%s\nservice_present=%s\ntimer_present=%s\nservice_hash=%s\ntimer_hash=%s\nservice_meta=%s\ntimer_meta=%s' "$release" "$runtime_identity" "$service_present" "$timer_present" "$service_hash" "$timer_hash" "$service_meta" "$timer_meta")" ]] || return 1
  else
    [[ "$path" == "$RUNTIME_DIR" ]] || return 1
    if [[ -d "$dest" ]]; then
      local unexpected
      unexpected=$(find "$dest" -mindepth 1 -maxdepth 1 \( ! -type f -o ! -name '.quarantine-state.pending.*' \) -printf x -quit) || return 1
      [[ -z "$unexpected" ]] || return 1
    fi
    for unit in "$SERVICE" "$TIMER"; do
      path="$UNIT_DIR/$unit"
      if [[ -e "$path" || -L "$path" ]]; then
        unit_is_release_prefix "$release" "$unit" "$path" || return 1
        digest=$(sha256sum "$path") || return 1; digest=${digest%% *}
        metadata=$(stat -c '%u:%g:%a:%d:%i:%h' "$path") || return 1
        if [[ "$unit" == "$SERVICE" ]]; then service_present=1; service_hash=$digest; service_meta=$metadata
        else timer_present=1; timer_hash=$digest; timer_meta=$metadata; fi
      fi
    done
  fi
  for unit in "$SERVICE" "$TIMER"; do
    path="$UNIT_DIR/$unit"; other="$dest/$unit"
    if [[ "$unit" == "$SERVICE" ]]; then digest=$service_hash; metadata=$service_meta; else digest=$timer_hash; metadata=$timer_meta; fi
    if [[ "$digest" == - ]]; then [[ ! -e "$path" && ! -L "$path" && ! -e "$other" && ! -L "$other" && "$metadata" == - ]] || return 1
    else
      [[ "$digest" =~ ^[a-f0-9]{64}$ ]] || return 1
      if [[ -e "$path" || -L "$path" ]]; then [[ ! -e "$other" && ! -L "$other" ]] || return 1; else path=$other; fi
      unit_is_release_prefix "$release" "$unit" "$path" || return 1
      local observed
      observed=$(sha256sum "$path") || return 1
      [[ "${observed%% *}" == "$digest" && "$(stat -c '%u:%g:%a:%d:%i:%h' "$path")" == "$metadata" ]] || return 1
    fi
  done
  if [[ -e "$dest/.quarantine-complete" || -L "$dest/.quarantine-complete" ]]; then
    trusted_file "$dest/.quarantine-complete" && [[ "$(<"$dest/.quarantine-complete")" == "release_sha=$release" ]] || return 1
    [[ ! -e "$RUNTIME_DIR" && ! -L "$RUNTIME_DIR" && ! -e "$UNIT_DIR/$SERVICE" && ! -L "$UNIT_DIR/$SERVICE" && ! -e "$UNIT_DIR/$TIMER" && ! -L "$UNIT_DIR/$TIMER" ]] || return 1
    [[ "$(systemctl is-active "$TIMER" 2>/dev/null || true)" == inactive && "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == inactive ]] || return 1
    return 0
  fi
  acquire_quarantine_lock || return 1
  fresh_verified_backup "$ORIGINAL_DEPLOY" || return 1
  # The missing or corrupt private runtime is never executed to undo its installation.
  if [[ -f "$UNIT_DIR/$TIMER" ]]; then
    if [[ "$(systemctl is-active "$TIMER" 2>/dev/null || true)" != inactive || "$(systemctl is-enabled "$TIMER" 2>/dev/null || true)" == enabled* ]]; then systemctl disable --now "$TIMER" || return 1; fi
  fi
  if [[ -f "$UNIT_DIR/$SERVICE" ]]; then systemctl stop "$SERVICE" || return 1; fi
  [[ "$(systemctl is-active "$TIMER" 2>/dev/null || true)" == inactive && "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == inactive ]] || return 1
  [[ "$(systemctl is-enabled "$TIMER" 2>/dev/null || true)" != enabled* ]] || return 1
  if [[ ! -d "$dest" ]]; then install -o root -g root -m 0750 -d "$QUARANTINE_ROOT" "$dest" || return 1; fi
  if [[ ! -f "$dest/.quarantine-state" ]]; then
    state=$(printf 'release_sha=%s\nruntime_identity=%s\nservice_present=%s\ntimer_present=%s\nservice_hash=%s\ntimer_hash=%s\nservice_meta=%s\ntimer_meta=%s' "$release" "$runtime_identity" "$service_present" "$timer_present" "$service_hash" "$timer_hash" "$service_meta" "$timer_meta")
    publish_recovery_marker "$dest/.quarantine-state" "$state" || return 1
  fi
  for unit in "$SERVICE" "$TIMER"; do
    if [[ -e "$UNIT_DIR/$unit" ]]; then
      mv -T -n -- "$UNIT_DIR/$unit" "$dest/$unit" || return 1
      [[ ! -e "$UNIT_DIR/$unit" && -f "$dest/$unit" ]] || return 1
    fi
  done
  if [[ -e "$RUNTIME_DIR" ]]; then
    [[ ! -e "$dest/runtime" && ! -L "$dest/runtime" && "$(stat -c '%d' "$RUNTIME_DIR")" == "$(stat -c '%d' "$dest")" ]] || return 1
    mv -T -n -- "$RUNTIME_DIR" "$dest/runtime" || return 1
  fi
  [[ ! -e "$RUNTIME_DIR" && "$(stat -c '%d:%i' "$dest/runtime")" == "$runtime_identity" ]] || return 1
  systemctl daemon-reload || return 1
  publish_recovery_marker "$dest/.quarantine-complete" "release_sha=$release" || return 1
  log "quarantined release $release under $dest; nothing was deleted"
)

main() {
  [[ $# == 2 ]] || { refuse "exactly step and release SHA required"; return 1; }
  valid_sha "$2" || { refuse "release SHA must be exactly 40 lowercase hex characters"; return 1; }
  case "$1" in install|run-once|enable|disable|quarantine) ;; *) refuse "unknown step"; return 1;; esac
  require_installer_trust "$2" || return 1
  case "${1:-}" in
    install) install_runtime "$2";;
    run-once) run_once "$2";;
    enable) enable_timer "$2";;
    disable) disable_timer "${2:-}";;
    quarantine) quarantine "${2:-}";;
    *) refuse "step must be install, run-once, enable, disable, or quarantine";;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
