#!/usr/bin/env bash
# Retention guard for mailbox backups and disk headroom.
set -euo pipefail
readonly BACKUP_DIR=/var/backups/growth
readonly MIN_FREE_KIB=2097152
readonly RETENTION_SECONDS=2592000
readonly RETENTION_DAYS=30
readonly MAX_BACKUPS=3200
readonly DEPLOY=/usr/local/lib/growth-mailbox-sync/deploy.sh
readonly MANIFEST=/usr/local/lib/growth-mailbox-sync/SHA256SUMS
readonly LOGGER_TAG=growth-mailbox-sync-storage

fail() { local code=$1; logger -t "$LOGGER_TAG" "failure_code=$code" >/dev/null 2>&1 || true; printf 'REFUSING code=%s\n' "$code" >&2; return 1; }
root_trusted_wrapper() {
  [[ "$(id -u)" == 0 ]] || return 1
  [[ -f "$DEPLOY" && ! -L "$DEPLOY" && -f "$MANIFEST" && ! -L "$MANIFEST" ]] || return 1
  [[ "$(stat -c '%U:%G:%a:%h' "$DEPLOY" 2>/dev/null)" == root:root:640:1 ]] || return 1
  [[ "$(stat -c '%U:%G:%a:%h' "$MANIFEST" 2>/dev/null)" == root:root:640:1 ]] || return 1
  (cd "$(dirname "$DEPLOY")" && sha256sum -c SHA256SUMS >/dev/null 2>&1)
}
# Pure fact guard: tests may supply measured facts; it never changes storage.
check_facts() {
  local free_kib=$1 count=$2
  [[ "$free_kib" =~ ^[0-9]+$ && "$count" =~ ^[0-9]+$ ]] || return 1
  [[ "$free_kib" -ge "$MIN_FREE_KIB" ]] || return 1
  [[ "$count" -le "$MAX_BACKUPS" ]] || return 1
}
backup_epoch_from_name() {
  local base=$1 year clock stamp raw epoch canonical
  [[ "$base" =~ ^deploy-([0-9]{8})T([0-9]{6})Z\.dump$ ]] || return 1
  year=${BASH_REMATCH[1]}
  clock=${BASH_REMATCH[2]}
  stamp="${year}T${clock}Z"
  raw=$(date -u -d "$year ${clock:0:2}:${clock:2:2}:${clock:4:2}" '+%s %Y%m%dT%H%M%SZ' 2>/dev/null) || return 1
  read -r epoch canonical <<<"$raw"
  [[ "$canonical" == "$stamp" && "$epoch" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$epoch"
}
list_timestamped_backup_paths() {
  local output_name=$1 fd pid map_status=0 find_status=0
  [[ "$output_name" =~ ^[a-z_][a-z0-9_]*$ ]] || return 1
  exec {fd}< <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -name 'deploy-*.dump' -print0) || return 1
  pid=$!
  mapfile -d '' -t "$output_name" <&"$fd" || map_status=$?
  exec {fd}<&- || return 1
  wait "$pid" || find_status=$?
  (( map_status == 0 && find_status == 0 ))
}
prune_expired_backups() {
  local now=${1:-} cutoff f base metadata epoch removed=0
  local -a files=() expired=()
  [[ "$now" =~ ^[0-9]+$ ]] || now=$(date +%s) || return 1
  cutoff=$((now - RETENTION_SECONDS))
  list_timestamped_backup_paths files || return 1
  for f in "${files[@]}"; do
    base=${f##*/}
    [[ "$base" =~ ^deploy-[0-9]{8}T[0-9]{6}Z\.dump$ ]] || continue
    [[ -f "$f" && ! -L "$f" ]] || return 1
    metadata=$(stat -c '%U:%G:%a:%h' "$f" 2>/dev/null) || return 1
    [[ "$metadata" == growth:growth:600:1 ]] || return 1
    epoch=$(backup_epoch_from_name "$base") || return 1
    (( epoch <= now )) || return 1
    (( epoch < cutoff )) && expired+=("$f")
  done
  for f in "${expired[@]}"; do
    unlink -- "$f" || return 1
    removed=$((removed + 1))
  done
  printf '%s\n' "$removed"
}
backup_count() {
  local n=0 f base
  local -a files=()
  list_timestamped_backup_paths files || return 1
  for f in "${files[@]}"; do
    base=${f##*/}
    [[ "$base" =~ ^deploy-[0-9]{8}T[0-9]{6}Z\.dump$ ]] || continue
    n=$((n + 1))
    [[ "$n" -le "$MAX_BACKUPS" ]] || { printf '%s\n' "$n"; return 0; }
  done
  printf '%s\n' "$n"
}
main() {
  [[ $# == 0 ]] || { fail invalid_args; return 1; }
  root_trusted_wrapper || { fail wrapper_untrusted; return 1; }
  [[ -d "$BACKUP_DIR" && ! -L "$BACKUP_DIR" ]] || { fail backup_dir_invalid; return 1; }
  local owner mode free count target now pruned
  owner=$(stat -c '%U:%G' "$BACKUP_DIR") || { fail backup_dir_stat; return 1; }
  mode=$(stat -c '%a' "$BACKUP_DIR") || { fail backup_dir_stat; return 1; }
  [[ "$owner" == growth:growth && "$mode" == 700 ]] || { fail backup_dir_permissions; return 1; }
  now=$(date +%s) || { fail clock_unavailable; return 1; }
  pruned=$(prune_expired_backups "$now") || { fail retention_cleanup; return 1; }
  free=$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')
  count=$(backup_count) || { fail retention_cleanup; return 1; }
  check_facts "$free" "$count" || { [[ "$free" =~ ^[0-9]+$ && "$free" -lt "$MIN_FREE_KIB" ]] && fail disk_headroom || fail backup_count; return 1; }
  target="$BACKUP_DIR/deploy-$(date -u +%Y%m%dT%H%M%SZ).dump"
  [[ ! -e "$target" && ! -L "$target" ]] || { fail backup_target_exists; return 1; }
  printf 'storage_ok free_kib=%s backup_count=%s min_free_kib=%s max_backups=%s retention_days=%s pruned_backups=%s\n' "$free" "$count" "$MIN_FREE_KIB" "$MAX_BACKUPS" "$RETENTION_DAYS" "$pruned"
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
