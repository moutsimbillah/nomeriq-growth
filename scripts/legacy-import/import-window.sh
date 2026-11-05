#!/usr/bin/env bash
# The import window. One file, three modes:
#   --target growth --live             the live window
#   --target growth_rehearsal          rehearsal: the deploy, the b511f13 redeploy and the timer changes are
#                                      SKIPPED and only logged, because they act on the live app whatever the
#                                      database is. Migrations and passes run from a separate checkout.
#   --print-only                       print every command a run would execute and execute nothing
#   --force-fail-after <sql>           abort after that pass, so the rollback can be proven
set -uo pipefail
TARGET=growth; LIVE=0; PRINT=0; FORCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2;;
    --live) LIVE=1; shift;;
    --print-only) PRINT=1; shift;;
    --force-fail-after) FORCE="$2"; shift 2;;
    *) echo "unknown argument: $1"; exit 2;;
  esac
done
MODE=rehearsal; [ "$TARGET" = "growth" ] && MODE=live
NEW=bdc5a1d; PREV=b511f13
APP=/home/growth/app
WORK=/home/growth/rehearsal
EXPORT=/home/growth/import/Nomeriq-Growth-Export-20261104T201547Z-2aa5fc9e2b
TS=$(date -u +%Y%m%dT%H%M%SZ)
DUMP=/var/backups/growth/preimport-$TARGET-$TS.dump
BACKUP_OK=0
step() { echo; echo "=== $* ==="; }
as_growth() { run sudo -u growth bash -c "$1"; }
pgx() { sudo -u growth python3 /tmp/pgx.py "$@"; }
run() {
  if [ "$PRINT" = "1" ]; then echo "WOULD RUN: $*"; return 0; fi
  "$@"
}
psqlq() { pgx psql -d "$TARGET" -X -A -t -c "$1"; }
counts() {
  local q="SELECT (SELECT count(*) FROM prospects) || ' prospects, ' || (SELECT count(*) FROM drafts) || ' drafts, ' || (SELECT count(*) FROM users) || ' user, ' || (SELECT count(*) FROM email_accounts) || ' accounts, ' || (SELECT count(*) FROM prospects WHERE do_not_contact) || ' held'"
  psqlq "$q" 2>/dev/null
}
assert_target() {
  local q="SELECT count(*) FROM pg_database WHERE datname = '$TARGET'"
  local got; got=$(psqlq "$q")
  [ "$got" = "1" ] || { echo "REFUSING: database $TARGET does not exist (server said '$got')"; exit 1; }
}
rollback() {
  step "ROLLBACK on $TARGET (mode $MODE)"
  if [ "$BACKUP_OK" != "1" ]; then echo "ABORT: no verified backup from this run, refusing to drop $TARGET"; return 1; fi
  assert_target
  run sudo -u postgres dropdb --if-exists "$TARGET"
  run sudo -u postgres createdb -O growth_app "$TARGET"
  run sudo -u growth python3 /tmp/pgx.py pg_restore -d "$TARGET" --no-owner --no-privileges "$DUMP"
  if [ "$MODE" = "live" ]; then
    run sudo -u growth bash -c "git -C $APP reset --hard $PREV"
    run sudo -u growth bash -c "cd $APP && npm run build"
    run sudo systemctl restart growth.service
  else
    echo "skipped (rehearsal): would redeploy $PREV to $APP"
  fi
  sleep 2; echo "after rollback: $(counts)"
}
trap 'rc=$?; if [ "$rc" -ne 0 ]; then echo "WINDOW FAILED rc=$rc on target $TARGET"; rollback; fi' EXIT

step "mode=$MODE target=$TARGET print_only=$PRINT backup=$DUMP"
if [ "$MODE" = "live" ] && [ "$LIVE" != "1" ]; then echo "REFUSING: live target without --live"; exit 1; fi

step "0. timers"
if [ "$MODE" = "live" ]; then
  run sudo systemctl stop growth-cron-research.timer growth-cron-sends.timer growth-cron-follow-ups.timer
  echo "timers now: $(run sudo systemctl is-active growth-cron-research.timer growth-cron-sends.timer growth-cron-follow-ups.timer | tr '\n' ' ')"
else
  echo "skipped (rehearsal): would stop the three cron timers"
fi

step "1. backup of $TARGET, written as growth, verified before anything else"
[ "$PRINT" = "1" ] || assert_target
run sudo -u growth python3 /tmp/pgx.py pg_dump -Fc -d "$TARGET" -f "$DUMP" || { echo "ABORT: backup failed"; exit 1; }
if [ "$PRINT" != "1" ]; then
  run sudo ls -l "$DUMP" | awk '{print "dump bytes: " $5}'
  ENTRIES=$(pgx pg_restore --list "$DUMP" | grep -c "TABLE DATA")
  echo "verified table data entries: $ENTRIES"
  [ "${ENTRIES:-0}" -gt 0 ] || { echo "ABORT: dump has no table data"; exit 1; }
  BACKUP_OK=1
fi

step "2. code"
if [ "$MODE" = "live" ]; then
  run sudo -u growth bash -c "cd $APP && GIT_SSH_COMMAND='ssh -i /home/growth/.ssh/deploy_growth -o IdentitiesOnly=yes' git fetch --depth=1 origin master" || { echo "ABORT: fetch failed"; exit 1; }
  if [ "$PRINT" != "1" ]; then
    GOT=$(sudo -u growth git -C "$APP" rev-parse --short FETCH_HEAD)
    [ "$GOT" = "$NEW" ] || { echo "ABORT: FETCH_HEAD is $GOT, expected $NEW"; exit 1; }
  fi
  run sudo -u growth bash -c "git -C $APP reset --hard FETCH_HEAD"
  run sudo -u growth bash -c "cd $APP && npm run build" || { echo "ABORT: build failed"; exit 1; }
  run sudo systemctl restart growth.service
  run curl -s -o /dev/null -w "health: %{http_code}\n" http://127.0.0.1:3100/login
  CODE_DIR=$APP
else
  echo "skipped (rehearsal): would fetch and deploy $NEW into $APP"
  run sudo -u growth bash -c "rm -rf $WORK && git clone -q $APP $WORK"
  run sudo -u growth bash -c "cd $WORK && GIT_SSH_COMMAND='ssh -i /home/growth/.ssh/deploy_growth -o IdentitiesOnly=yes' git fetch -q --depth=1 git@github.com:moutsimbillah/nomeriq-growth.git master && git reset --hard FETCH_HEAD"
  CODE_DIR=$WORK
  if [ "$PRINT" != "1" ]; then
    GOT=$(sudo -u growth git -C "$WORK" rev-parse --short HEAD)
    [ "$GOT" = "$NEW" ] || { echo "ABORT: rehearsal checkout is $GOT, expected $NEW"; exit 1; }
    echo "rehearsal checkout at $GOT (separate from $APP)"
  fi
fi

step "3. migrations against $TARGET from $CODE_DIR"
for f in 017_legacy_origin.sql 018_legacy_archive.sql 019_legacy_message_source.sql 020_follow_up_switch.sql 021_follow_up_exclusion.sql; do
  run sudo -u growth python3 /tmp/pgx.py psql -d "$TARGET" -q -v ON_ERROR_STOP=1 -f "$CODE_DIR/src/db/migrations/$f" || { echo "ABORT: migration $f failed"; exit 1; }
  echo "  $f applied"
done

step "4. the import against $TARGET"
LIVEFLAG=""; [ "$MODE" = "live" ] && LIVEFLAG="--live"
run sudo -u growth bash -c "cd $CODE_DIR/scripts/legacy-import && python3 load-legacy.py $EXPORT $TARGET" || { echo "ABORT: archive load failed"; exit 1; }
for pair in run-pass.py:pass-a.sql run-pass-b.py:pass-b.sql run-pass-d.py:pass-d.sql; do
  R="${pair%%:*}"; S="${pair##*:}"
  run sudo -u growth bash -c "cd $CODE_DIR/scripts/legacy-import && python3 $R --database $TARGET $LIVEFLAG $S" || { echo "ABORT: $S failed"; exit 1; }
  echo "  $S passed every assertion"
  if [ "$FORCE" = "${S%.sql}" ]; then echo "FORCED FAILURE after $S"; exit 9; fi
done

step "5. the archive lock"
run sudo -u growth python3 /tmp/pgx.py psql -d "$TARGET" -q -v ON_ERROR_STOP=1 -f "$CODE_DIR/scripts/legacy-import/archive-read-only.sql" || { echo "ABORT: lock failed"; exit 1; }
echo "lock applied"

step "6. pass C, the acceptance"
run sudo -u growth bash -c "cd $CODE_DIR/scripts/legacy-import && python3 run-pass-c.py --database $TARGET $LIVEFLAG pass-c.sql" || { echo "ABORT: pass C failed"; exit 1; }
echo "counts now: $(counts)"

if [ "$MODE" = "rehearsal" ]; then
  step "7-9. holds, timers, cleanup"
  echo "skipped (rehearsal): would lift the two holds, restart the timers and remove the export folder"
  echo "REHEARSAL COMPLETE on $TARGET"
  exit 0
fi

step "7. lift the holds, by id"
run sudo -u postgres psql -d growth -A -t -c "UPDATE prospects SET do_not_contact = false, founder_notes = coalesce(founder_notes,'') || E'\n[2026-11-05] hold lifted: the import recorded the old sent email', updated_at = now() WHERE id IN ('f8602ca5-bf39-402b-84cd-21212da236fd','815a1cd5-86c5-4705-9402-ab6b98526c89')"
HOLDS="SELECT business_name, do_not_contact, length(founder_notes) FROM prospects WHERE founder_notes LIKE '%hold lifted%'"
pgx psql -d growth -A -t -F"|" -c "$HOLDS"

step "8. timers back on"
run sudo systemctl start growth-cron-research.timer growth-cron-sends.timer growth-cron-follow-ups.timer
echo "timers: $(sudo systemctl is-active growth-cron-research.timer growth-cron-sends.timer growth-cron-follow-ups.timer | tr '\n' ' ')"

step "9. cleanup"
run rm -rf "$EXPORT"
run sudo -u postgres dropdb --if-exists growth_import_dryrun
run sudo -u postgres dropdb --if-exists growth_rehearsal
echo; echo "LIVE WINDOW COMPLETE"
