#!/usr/bin/env bash
# Read-only guard for mailbox backup growth and disk headroom.
set -euo pipefail
readonly BACKUP_DIR=/var/backups/growth
readonly MIN_FREE_KIB=2097152
readonly MAX_BACKUPS=1000
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
backup_count() {
  local n=0 f base
  while IFS= read -r -d '' f; do
    base=${f##*/}
    [[ "$base" =~ ^deploy-[0-9]{8}T[0-9]{6}Z\.dump$ ]] || continue
    n=$((n + 1))
    [[ "$n" -le "$MAX_BACKUPS" ]] || { printf '%s\n' "$n"; return 0; }
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'deploy-*.dump' -print0)
  printf '%s\n' "$n"
}
main() {
  [[ $# == 0 ]] || { fail invalid_args; return 1; }
  root_trusted_wrapper || { fail wrapper_untrusted; return 1; }
  [[ -d "$BACKUP_DIR" && ! -L "$BACKUP_DIR" ]] || { fail backup_dir_invalid; return 1; }
  local owner mode free count target
  owner=$(stat -c '%U:%G' "$BACKUP_DIR") || { fail backup_dir_stat; return 1; }
  mode=$(stat -c '%a' "$BACKUP_DIR") || { fail backup_dir_stat; return 1; }
  [[ "$owner" == growth:growth && "$mode" == 700 ]] || { fail backup_dir_permissions; return 1; }
  free=$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')
  count=$(backup_count)
  check_facts "$free" "$count" || { [[ "$free" =~ ^[0-9]+$ && "$free" -lt "$MIN_FREE_KIB" ]] && fail disk_headroom || fail backup_count; return 1; }
  target="$BACKUP_DIR/deploy-$(date -u +%Y%m%dT%H%M%SZ).dump"
  [[ ! -e "$target" && ! -L "$target" ]] || { fail backup_target_exists; return 1; }
  printf 'storage_ok free_kib=%s backup_count=%s min_free_kib=%s max_backups=%s\n' "$free" "$count" "$MIN_FREE_KIB" "$MAX_BACKUPS"
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
