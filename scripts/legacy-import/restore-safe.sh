#!/usr/bin/env bash
# Restore the production database safely: build a NEW database, verify it, then swap it in by renaming.
# It never restores into the live database, and it refuses to swap in a database that pg_restore did not
# restore cleanly -- a restore that reports errors and carries on is how a rollback becomes a corruption.
#
#   restore-safe.sh --target growth --dump /var/backups/growth/<file>.dump        the real thing
#   restore-safe.sh --target growth_restoretest --dump <file> --rehearsal         no service changes
set -uo pipefail
TARGET=growth; DUMP=""; REHEARSAL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2;;
    --dump) DUMP="$2"; shift 2;;
    --rehearsal) REHEARSAL=1; shift;;
    *) echo "unknown argument: $1"; exit 2;;
  esac
done
[ -n "$DUMP" ] || { echo "refusing: --dump is required"; exit 2; }
TS=$(date -u +%Y%m%dT%H%M%SZ)
NEW="${TARGET}__restore_${TS}"; OLD="${TARGET}__old_${TS}"
pgx() { sudo -u growth python3 /home/growth/app/scripts/pgx.py "$@"; }
pg() { sudo -u postgres psql -X -A -t -c "$1"; }
die() { echo "ABORT: $*"; exit 1; }
step() { echo; echo "=== $* ==="; }

step "1. the dump, proven before anything is created"
sudo test -s "$DUMP" || die "dump missing or empty: $DUMP"
echo "  $(sudo ls -l "$DUMP" | awk '{print $5}') bytes, $(basename "$DUMP")"
N=$(pgx pg_restore --list "$DUMP" | grep -c "TABLE DATA") || die "could not read the dump"
echo "  table data entries: $N"
[ "${N:-0}" -gt 0 ] || die "dump has no table data"

step "2. restore into a new database: $NEW"
[ "$(pg "SELECT count(*) FROM pg_database WHERE datname = '$NEW'")" = "0" ] || die "$NEW already exists"
sudo -u postgres createdb -O growth_app "$NEW" || die "could not create $NEW"
pgx pg_restore -d "$NEW" --no-owner --no-privileges "$DUMP" 2>/tmp/restore-safe.err
RC=$?
if [ "$RC" != "0" ]; then
  echo "  pg_restore reported errors:"; sed -n 1,6p /tmp/restore-safe.err
  die "refusing to swap in a database that did not restore cleanly"
fi
echo "  pg_restore exit=0, no errors"

step "3. verify the restored database before swapping"
Q="SELECT (SELECT count(*) FROM prospects) || ' prospects, ' || (SELECT count(*) FROM drafts) || ' drafts, ' || (SELECT count(*) FROM users) || ' user'"
echo "  $NEW: $(pgx psql -d "$NEW" -X -A -t -c "$Q")"
CH=$(pgx psql -d "$NEW" -X -A -t -c "SELECT count(*) FROM prospects") || die "cannot read $NEW"
[ "${CH:-0}" -gt 0 ] || die "$NEW restored with no prospects"

step "4. swap it in"
if [ "$REHEARSAL" = "1" ]; then
  echo "  rehearsal: skipping the service stop and the connection termination"
else
  sudo systemctl stop growth.service || die "could not stop growth.service"
  echo "  growth.service stopped"
  pg "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TARGET' AND pid <> pg_backend_pid()" >/dev/null
  echo "  remaining connections to $TARGET terminated"
fi
pg "ALTER DATABASE \"$TARGET\" RENAME TO \"$OLD\"" || die "could not rename $TARGET aside"
pg "ALTER DATABASE \"$NEW\" RENAME TO \"$TARGET\"" || die "could not swap $NEW into place"
echo "  $TARGET is now the restored database; the previous one is $OLD"
if [ "$REHEARSAL" = "1" ]; then
  echo "  rehearsal: skipping the service start"
else
  sudo systemctl start growth.service || die "could not start growth.service"
  sleep 5
  echo "  growth.service started"
fi

step "5. verify the target"
echo "  $TARGET: $(pgx psql -d "$TARGET" -X -A -t -c "$Q")"
echo "  previous database kept as $OLD -- drop it once you are satisfied"
echo
echo "RESTORE COMPLETE"
