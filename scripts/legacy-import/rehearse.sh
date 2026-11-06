#!/usr/bin/env bash
# Rehearse the window twice on growth_rehearsal, each time from a fresh dump of live. Live is only read.
set -uo pipefail
SRC=/var/backups/growth/rehearsal-src-$(date -u +%Y%m%dT%H%M%SZ).dump
pgx() { sudo -u growth python3 /home/growth/app/scripts/pgx.py "$@"; }
fresh() {
  echo "--- fresh dump of live (read-only) and a clean growth_rehearsal ---"
  pgx pg_dump -Fc -d growth -f "$SRC" || { echo "ABORT: could not dump live"; exit 1; }
  N=$(pgx pg_restore --list "$SRC" | grep -c "TABLE DATA")
  echo "src table data entries: $N"
  [ "${N:-0}" -gt 0 ] || { echo "ABORT: src dump has no table data"; exit 1; }
  sudo -u postgres dropdb --if-exists growth_rehearsal
  sudo -u postgres createdb -O growth_app growth_rehearsal
  pgx pg_restore -d growth_rehearsal --no-owner --no-privileges "$SRC" >/dev/null 2>&1
  Q="SELECT (SELECT count(*) FROM prospects) || ' prospects, ' || (SELECT count(*) FROM drafts) || ' drafts, ' || (SELECT count(*) FROM users) || ' user'"
  echo "rehearsal before the window: $(pgx psql -d growth_rehearsal -X -A -t -c "$Q")"
}
echo "########## REHEARSAL 1: clean run to the end ##########"
fresh
bash /tmp/import-window.sh --target growth_rehearsal; echo "rehearsal 1 exit: $?"
echo
echo "########## REHEARSAL 2: forced failure after pass A ##########"
fresh
bash /tmp/import-window.sh --target growth_rehearsal --force-fail-after pass-a; echo "rehearsal 2 exit: $?"
echo
Q="SELECT (SELECT count(*) FROM prospects) || ' prospects, ' || (SELECT count(*) FROM drafts) || ' drafts, ' || (SELECT count(*) FROM users) || ' user'"
echo "live is untouched: $(pgx psql -d growth -X -A -t -c "$Q")"
