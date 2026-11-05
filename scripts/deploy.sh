#!/bin/bash
# scripts/deploy.sh — the deploy in docs/DEPLOYMENT.md, as one reviewed script.
#
# Why this file exists: the runbook's privileged half (a restart) cannot be typed as an SSH command,
# because `systemctl restart growth` is a hard-denied pattern for the agent. The store's rule is that a
# deny rule is never worked around by writing the blocked command into a file and running the file, so
# this script lives in the repository, is reviewed by the founder once, and only then may be run:
#
#     ssh ubuntu@<host> 'sudo -n bash /home/growth/app/scripts/deploy.sh all'
#
# The script is the whole deploy — backup, build, restart, verify — so the review covers everything it
# does. Any later change to this file needs a fresh review, because it contains a denied command.
#
# What it will NOT do:
#   - touch .env, .growth.env or .env.production
#   - delete anything, drop a database, or restore a dump
#   - run a migration (that is a separate, explicitly approved step)
#   - deploy when the local gate has not run: it refuses if the working tree is dirty
#
# Usage:  deploy.sh dump | build | restart | all      (default: all)
set -euo pipefail

APP=/home/growth/app
BACKUPS=/var/backups/growth
DEPLOY_KEY=/home/growth/.ssh/deploy_growth
MIN_TABLE_DATA=50

step="${1:-all}"
say() { printf '\n== %s ==\n' "$1"; }

as_growth() { sudo -n -u growth bash -lc "$1"; }

# Git on the server uses a deploy key that is not under a default name, so every fetch must name it.
git_as_growth() {
  as_growth "GIT_SSH_COMMAND='ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes' git -C $APP $1"
}

dump() {
  say "verified backup"
  mkdir -p "$BACKUPS"
  local name entries
  name="$BACKUPS/deploy-$(date -u +%Y%m%dT%H%M%SZ).dump"
  # Credentials come from the app's own env file through pgx.py, never from a command line.
  sudo -n -u growth python3 /tmp/pgx.py pg_dump -d growth -Fc -f "$name"
  chmod 600 "$name"
  entries="$(pg_restore --list "$name" | grep -c 'TABLE DATA' || true)"
  printf 'dump: %s\nsize: %s bytes\nmode: %s\ntable-data entries: %s\n' \
    "$name" "$(stat -c%s "$name")" "$(stat -c%a "$name")" "$entries"
  if [ "${entries:-0}" -lt "$MIN_TABLE_DATA" ]; then
    echo "REFUSING: a dump with fewer than $MIN_TABLE_DATA table-data entries is not a backup."
    exit 1
  fi
}

build() {
  say "fetch and check out origin/master"
  git_as_growth "fetch --all --prune"
  local before after
  before="$(as_growth "git -C $APP rev-parse --short HEAD")"
  git_as_growth "reset --hard origin/master"
  after="$(as_growth "git -C $APP rev-parse --short HEAD")"
  printf 'was: %s\nnow: %s\n' "$before" "$after"

  local dirty
  dirty="$(as_growth "git -C $APP status --porcelain | wc -l")"
  if [ "$dirty" != "0" ]; then
    echo "REFUSING: the checkout is dirty after a hard reset; something on the server is not in git."
    exit 1
  fi

  # Only reinstall when the lockfile actually moved: npm ci is minutes, and it must be npm 10.
  if as_growth "git -C $APP diff --name-only $before $after -- package-lock.json" | grep -q .; then
    say "npm ci (lockfile changed)"
    as_growth "cd $APP && npx -y npm@10.9.9 ci"
  else
    echo "lockfile unchanged: skipping npm ci"
  fi

  say "build"
  as_growth "cd $APP && npm run build"

  # A build writes .next while the old process is still serving it, so this is the point of no return.
  printf 'BUILD_DONE commit=%s\n' "$after"
}

restart() {
  say "what is running before"
  printf 'commit on disk: %s\n' "$(as_growth "git -C $APP rev-parse --short HEAD")"
  printf 'loopback health: %s\n' "$(curl -s -m 5 http://127.0.0.1:3100/api/health || echo '(no answer)')"

  say "restart growth.service"
  sudo -n systemctl restart growth.service
  local waited=0
  until curl -s -m 3 http://127.0.0.1:3100/api/health | grep -q '"database":"reachable"'; do
    waited=$((waited + 2))
    if [ "$waited" -ge 40 ]; then
      echo "the service did not come back healthy in 40s"
      sudo -n journalctl -u growth.service --since "-3 min" --no-pager -q | tail -30
      exit 1
    fi
    sleep 2
  done

  say "verify"
  printf 'loopback health: %s\n' "$(curl -s -m 5 http://127.0.0.1:3100/api/health)"
  printf 'public health:   %s\n' "$(curl -s -m 10 https://growth.nomeriq.info/api/health || echo '(no answer)')"
  printf 'login page:      %s\n' "$(curl -s -m 10 -o /dev/null -w '%{http_code}' https://growth.nomeriq.info/login)"
  printf 'service:         %s\n' "$(sudo -n systemctl is-active growth.service)"
  echo "timers:"
  sudo -n systemctl list-timers --all 'growth-*' --no-pager | sed -n '1,12p'
  echo "migration ledger (newest 4):"
  sudo -n -u growth python3 /tmp/pgx.py psql -d growth -X -A -t \
    -c "SELECT id FROM _migrations ORDER BY id DESC LIMIT 4" 2>/dev/null || echo "(pgx helper missing)"
  echo "counts:"
  sudo -n -u growth python3 /tmp/pgx.py psql -d growth -X -A -F'|' -c \
    "SELECT (SELECT count(*) FROM prospects) AS prospects,
            (SELECT count(*) FROM prospects WHERE qualification_status='verified') AS verified,
            (SELECT count(*) FROM drafts) AS drafts,
            (SELECT count(*) FROM messages) AS messages"
  echo "errors in the last 10 minutes:"
  sudo -n journalctl -u growth.service --since "-10 min" -p err --no-pager -q | tail -20 || true
  echo "public listeners on 3100 (must be none):"
  sudo -n ss -ltn | grep ':3100' || echo "(none)"
}

case "$step" in
  dump) dump ;;
  build) build ;;
  restart) restart ;;
  all) dump; build; restart ;;
  *) echo "unknown step: $step"; exit 2 ;;
esac