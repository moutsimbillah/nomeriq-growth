#!/bin/bash
# scripts/deploy.sh — the deploy in docs/DEPLOYMENT.md, as one reviewed script.
#
# Why this file exists: the runbook's privileged half (a restart) cannot be typed as an SSH command,
# because restarting the service is a hard-denied pattern for the agent. The charter's rule is that a
# deny rule is never worked around by writing the blocked command into a file and running the file, so
# this script lives in the repository, is reviewed by the founder once, and only then may be run.
#
# It is never run from inside the checkout: the build step resets /home/growth/app, which would
# replace the running file under it. Run a copy from the reviewed commit that sits outside the
# checkout, with its reviewed hash next to it:
#
#     ssh ubuntu@<host> 'cd / && sudo -n bash /home/growth/deploy/deploy.sh all'
#
# The copy checks itself against /home/growth/deploy/SHA256SUMS (the hash recorded in
# docs/DEPLOYMENT.md) before doing anything. A changed script means a new hash and a new review.
#
# What it will NOT do:
#   - touch .env, .growth.env or .env.production
#   - delete anything, drop a database, or restore a dump
#   - run a migration (that is a separate, explicitly approved step; when one is pending the
#     script stops before the build/restart until the approved migration has run)
#   - proceed when the server checkout is dirty after the hard reset
#
# Usage:  deploy.sh dump | prepare | build | restart | all      (default: all)
set -euo pipefail

APP=/home/growth/app
BACKUPS=/var/backups/growth
DEPLOY_KEY=/home/growth/.ssh/deploy_growth
PGX="$APP/scripts/pgx.py"      # the reviewed helper, in the repo — nothing the deploy needs lives in /tmp
MIN_TABLE_DATA=50

step="${1:-all}"
say() { printf '\n== %s ==\n' "$1"; }

as_growth() { sudo -n -u growth bash -lc "$1"; }

# Git on the server uses a deploy key that is not under a default name, so every fetch must name it.
git_as_growth() {
  as_growth "GIT_SSH_COMMAND='ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes' git -C $APP $1"
}

# The reset inside build() replaces files under $APP — including this script if it lived there.
case "$PWD/" in
  "$APP/"*)
    echo "REFUSING: never run the deploy from inside the checkout ($APP)."
    echo "Run a copy outside it, e.g. /home/growth/deploy/deploy.sh."
    exit 5
    ;;
esac

# The running copy must be the reviewed bytes: its hash has to match the sibling SHA256SUMS,
# which records the hash documented in docs/DEPLOYMENT.md.
if ! (cd "$(dirname "$0")" && sha256sum -c SHA256SUMS >/dev/null 2>&1); then
  echo "REFUSING: this copy of deploy.sh does not match the reviewed hash in SHA256SUMS."
  echo "A changed script means a new hash and a new review."
  exit 6
fi

# Every migration file in the checkout must already be in _migrations. Prints the missing ones.
migrations_missing() {
  local missing=""
  local f base
  for f in "$APP"/src/db/migrations/*.sql; do
    base="$(basename "$f")"
    if ! sudo -n -u growth python3 "$PGX" psql -d growth -X -A -t \
      -c "SELECT 1 FROM _migrations WHERE id = '$base'" 2>/dev/null | grep -q 1; then
      missing="$missing $base"
    fi
  done
  printf '%s' "$missing"
}

require_migrations_applied() {
  local missing
  missing="$(migrations_missing)"
  if [ -n "$missing" ]; then
    echo "REFUSING: $step needs every migration applied, but these files are not in _migrations:"
    printf '%s\n' "$missing"
    echo "Order for a deploy with a migration: prepare (dump + checkout), approved migration, build, restart."
    exit 4
  fi
}

dump() {
  say "verified backup"
  mkdir -p "$BACKUPS"
  local name entries
  name="$BACKUPS/deploy-$(date -u +%Y%m%dT%H%M%SZ).dump"
  # Credentials come from the app's own env file through pgx.py, never from a command line.
  sudo -n -u growth python3 "$PGX" pg_dump -d growth -Fc -f "$name"
  chmod 600 "$name"
  entries="$(pg_restore --list "$name" | grep -c 'TABLE DATA' || true)"
  printf 'dump: %s\nsize: %s bytes\nmode: %s\ntable-data entries: %s\n' \
    "$name" "$(stat -c%s "$name")" "$(stat -c%a "$name")" "$entries"
  if [ "${entries:-0}" -lt "$MIN_TABLE_DATA" ]; then
    echo "REFUSING: a dump with fewer than $MIN_TABLE_DATA table-data entries is not a backup."
    exit 1
  fi
}

checkout() {
  say "fetch and check out origin/master"
  git_as_growth "fetch --all --prune"
  local before after
  before="$(as_growth "git -C $APP rev-parse --short HEAD")"
  if [ "${1:-}" = "schema-only" ] && ! as_growth "git -C $APP diff --quiet HEAD origin/master -- package.json package-lock.json"; then
    echo "REFUSING: prepare requires unchanged dependencies; review a separate dependency deployment."
    exit 7
  fi
  git_as_growth "reset --hard origin/master"
  after="$(as_growth "git -C $APP rev-parse --short HEAD")"
  printf 'was: %s\nnow: %s\n' "$before" "$after"

  local dirty
  dirty="$(as_growth "git -C $APP status --porcelain | wc -l")"
  if [ "$dirty" != "0" ]; then
    echo "REFUSING: the checkout is dirty after a hard reset; something on the server is not in git."
    exit 1
  fi
  CHECKOUT_BEFORE="$before"
  CHECKOUT_AFTER="$after"
}

# Make the committed migration available without rewriting .next or restarting the process.
# The documented env-loaded db:migrate runner and ledger/schema checks come before build.
prepare() {
  dump
  checkout schema-only
  printf 'PREPARED commit=%s (existing .next and process unchanged)\n' "$CHECKOUT_AFTER"
}

build() {
  checkout
  require_migrations_applied
  local before="$CHECKOUT_BEFORE" after="$CHECKOUT_AFTER"

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
  require_migrations_applied
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
  sudo -n -u growth python3 "$PGX" psql -d growth -X -A -t \
    -c "SELECT id FROM _migrations ORDER BY id DESC LIMIT 4" 2>/dev/null || echo "(pgx helper missing)"
  echo "counts:"
  sudo -n -u growth python3 "$PGX" psql -d growth -X -A -F'|' -c \
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
  prepare) prepare ;;
  build) build ;;
  restart) restart ;;
  all) dump; build; require_migrations_applied; restart ;;
  *) echo "unknown step: $step"; exit 2 ;;
esac