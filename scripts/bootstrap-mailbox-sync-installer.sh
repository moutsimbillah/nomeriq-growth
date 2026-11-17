#!/usr/bin/env bash
# Stage the exact committed mailbox installer into its immutable trust directory.
set -euo pipefail

readonly APP_ROOT=/home/growth/app
readonly INSTALLER_ROOT=/home/ubuntu/growth-mailbox-install
readonly INSTALLER_NAME=install-mailbox-sync.sh
readonly BOOTSTRAP_NAME=bootstrap-mailbox-sync-installer.sh
readonly RELEASE_SHA_RE='^[0-9a-f]{40}$'

refuse() { printf 'REFUSING: %s\n' "$*" >&2; return 1; }
root_only() { [[ "$(id -u)" == 0 ]] || refuse "root is required"; }
valid_sha() { [[ "$1" =~ $RELEASE_SHA_RE ]]; }
git_growth() { sudo -n -u growth -- /usr/bin/git -C "$APP_ROOT" "$@"; }

trusted_directory() {
  local path=$1 owner mode
  [[ -d "$path" && ! -L "$path" ]] || return 1
  owner=$(stat -c '%U' "$path") || return 1
  mode=$(stat -c '%a' "$path") || return 1
  [[ ( "$owner" == root || "$owner" == ubuntu ) && "$mode" =~ ^[0-7][0145][0145]$ ]]
}

trusted_stage_file() {
  local path=$1 expected_blob=$2 expected_mode=$3 owner mode links actual
  [[ -f "$path" && ! -L "$path" ]] || return 1
  owner=$(stat -c '%U:%G' "$path") || return 1
  mode=$(stat -c '%a' "$path") || return 1
  links=$(stat -c '%h' "$path") || return 1
  actual=$(/usr/bin/git hash-object "$path") || return 1
  [[ "$owner" == root:root && "$mode" == "$expected_mode" && "$links" == 1 && "$actual" == "$expected_blob" ]]
}

write_exact() {
  local release=$1 stage=$2 file_name=$3 expected_blob=$4 mode=$5 tmp
  tmp=$(mktemp "$stage/.pending.XXXXXXXX") || return 1
  if ! git_growth show "$release:scripts/$file_name" >"$tmp"; then return 1; fi
  [[ "$(/usr/bin/git hash-object "$tmp")" == "$expected_blob" ]] || return 1
  chown root:root "$tmp" || return 1
  chmod "$mode" "$tmp" || return 1
  mv -T -n -- "$tmp" "$stage/$file_name" || return 1
  [[ ! -e "$tmp" && ! -L "$stage/$file_name" ]] || return 1
  trusted_stage_file "$stage/$file_name" "$expected_blob" "$mode"
}

write_blob_marker() {
  local stage=$1 blob=$2 path="$stage/INSTALLER-BLOB-SHA" tmp
  tmp=$(mktemp "$stage/.pending.XXXXXXXX") || return 1
  printf '%s\n' "$blob" >"$tmp" || return 1
  chown root:root "$tmp" || return 1
  chmod 644 "$tmp" || return 1
  mv -T -n -- "$tmp" "$path" || return 1
  [[ ! -e "$tmp" && ! -L "$path" && "$(<"$path")" == "$blob" ]]
  [[ "$(stat -c '%U:%G:%a:%h' "$path")" == root:root:644:1 ]]
}

main() {
  [[ $# == 1 ]] || { refuse "exactly one release SHA is required"; return 1; }
  valid_sha "$1" || { refuse "release SHA must be 40 lowercase hex characters"; return 1; }
  root_only || return 1
  local release=$1 script expected_bootstrap actual_bootstrap expected_installer head dirty stage parent_owner installer_path marker_path installer_exists marker_exists
  script=$(readlink -f -- "${BASH_SOURCE[0]}") || return 1
  [[ "$script" == "$APP_ROOT/scripts/$BOOTSTRAP_NAME" && ! -L "${BASH_SOURCE[0]}" ]] || { refuse "bootstrap path is not fixed"; return 1; }
  head=$(git_growth rev-parse HEAD) || return 1
  [[ "$head" == "$release" ]] || { refuse "checkout HEAD is not the requested release"; return 1; }
  dirty=$(git_growth status --porcelain --untracked-files=all) || return 1
  [[ -z "$dirty" ]] || { refuse "checkout is dirty"; return 1; }
  expected_bootstrap=$(git_growth rev-parse "$release:scripts/$BOOTSTRAP_NAME") || return 1
  actual_bootstrap=$(/usr/bin/git hash-object "$script") || return 1
  [[ "$actual_bootstrap" == "$expected_bootstrap" ]] || { refuse "bootstrap bytes differ from release"; return 1; }
  expected_installer=$(git_growth rev-parse "$release:scripts/$INSTALLER_NAME") || return 1
  [[ -n "$expected_installer" ]] || return 1

  if [[ -e "$INSTALLER_ROOT" || -L "$INSTALLER_ROOT" ]]; then
    trusted_directory "$INSTALLER_ROOT" || { refuse "installer parent is unsafe"; return 1; }
  else
    install -o root -g root -m 0755 -d "$INSTALLER_ROOT" || return 1
  fi
  parent_owner=$(stat -c '%U:%G:%a' "$INSTALLER_ROOT") || return 1
  [[ "$parent_owner" == root:root:755 ]] || { refuse "installer parent metadata differs"; return 1; }
  stage="$INSTALLER_ROOT/$release"
  if [[ -e "$stage" || -L "$stage" ]]; then
    [[ -d "$stage" && ! -L "$stage" && "$(stat -c '%U:%G:%a' "$stage")" == root:root:755 ]] || { refuse "release staging directory is unmanaged"; return 1; }
  else
    install -o root -g root -m 0755 -d "$stage" || return 1
  fi
  installer_path="$stage/$INSTALLER_NAME"
  marker_path="$stage/INSTALLER-BLOB-SHA"
  if [[ -e "$installer_path" || -L "$installer_path" ]]; then
    trusted_stage_file "$installer_path" "$expected_installer" 755 || { refuse "existing staged installer differs"; return 1; }
    installer_exists=1
  else installer_exists=0; fi
  if [[ -e "$marker_path" || -L "$marker_path" ]]; then
    [[ -f "$marker_path" && ! -L "$marker_path" && "$(<"$marker_path")" == "$expected_installer" && "$(stat -c '%U:%G:%a:%h' "$marker_path")" == root:root:644:1 ]] || { refuse "existing installer blob marker differs"; return 1; }
    marker_exists=1
  else marker_exists=0; fi
  if [[ "$installer_exists" == 0 ]]; then
    write_exact "$release" "$stage" "$INSTALLER_NAME" "$expected_installer" 755 || { refuse "installer staging failed; evidence retained at $stage"; return 1; }
  fi
  if [[ "$marker_exists" == 0 ]]; then
    write_blob_marker "$stage" "$expected_installer" || { refuse "installer marker staging failed; evidence retained at $stage"; return 1; }
  fi
  trusted_stage_file "$installer_path" "$expected_installer" 755 || { refuse "final staged installer verification failed"; return 1; }
  [[ "$(<"$marker_path")" == "$expected_installer" && "$(stat -c '%U:%G:%a:%h' "$marker_path")" == root:root:644:1 ]] || { refuse "final installer marker verification failed"; return 1; }
  printf 'installer_staged release=%s blob=%s path=%s/%s\n' "$release" "$expected_installer" "$stage" "$INSTALLER_NAME"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
