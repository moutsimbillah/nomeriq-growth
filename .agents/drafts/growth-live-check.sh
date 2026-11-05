#!/usr/bin/env bash
# Read-only health check for the Nomeriq Growth production server.
# Healthy = NO output (cron treats empty stdout as silent). Prints only on a problem.
# Every command here is a READ: no writes, no restarts, no migrations, no email, no deletes.
# The server's host key is ALREADY in known_hosts — never pass StrictHostKeyChecking=no.
set -uo pipefail

KEY="C:/Users/Welcome/.ssh/LightsailDefaultKey-ap-south-1.pem"
HOST="ubuntu@52.66.27.26"
REPO="/d/DeepSeek Nomeirq3.5/Nomeriq Leads"
P=""

remote() { timeout 90 ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=20 "$HOST" "$1" 2>/dev/null; }
sql()    { remote "sudo -n -u growth python3 /tmp/pgx.py psql -d growth -X -A -t -c \"$1\""; }

# 1. API health, internal and public.
IN=$(remote 'curl -s -m 10 -o /dev/null -w "%{http_code}" http://127.0.0.1:3100/api/health')
PUB=$(remote 'curl -s -m 10 -o /dev/null -w "%{http_code}" https://growth.nomeriq.info/api/health')
[ "$IN"  != "200" ] && P="${P}API health (internal) returned '$IN', expected 200\n"
[ "$PUB" != "200" ] && P="${P}API health (public) returned '$PUB', expected 200\n"

# 2. Service + timers enabled and active.
SVC=$(remote 'systemctl is-active growth.service')
[ "$SVC" != "active" ] && P="${P}growth.service is '$SVC', expected active\n"
for t in growth-backup growth-cron-research growth-cron-follow-ups growth-cron-sends; do
  ST=$(remote "systemctl is-enabled $t.timer; systemctl is-active $t.timer" | tr '\n' '/')
  [ "$ST" != "enabled/active/" ] && P="${P}timer $t is '$ST', expected enabled/active\n"
done

# 3. The live ledger must contain every migration file shipped in the repo.
LEDGER=$(sql "SELECT id FROM _migrations ORDER BY id")
if [ -z "$LEDGER" ]; then
  P="${P}could not read the live _migrations ledger\n"
else
  for f in $(ls "$REPO/src/db/migrations/" 2>/dev/null); do
    printf '%s\n' "$LEDGER" | grep -qx "$f" || P="${P}migration $f ships in the repo but is NOT in the live ledger\n"
  done
fi

# 4. Row counts — counts only, never row contents.
COUNTS=$(sql "SELECT (SELECT count(*) FROM prospects), (SELECT count(*) FROM prospects WHERE qualification_status = 'verified'), (SELECT count(*) FROM drafts), (SELECT count(*) FROM messages)" | tr '\t' '/')
[ -z "$COUNTS" ] && P="${P}could not read live row counts (database unreachable?)\n"

# 5. Backup freshness: the newest dump must be younger than 48h. /var/backups/growth is 0700 growth.
BACKUP=$(remote "sudo -n bash -c 'ls -1t /var/backups/growth/*.dump 2>/dev/null | head -1'")
if [ -z "$BACKUP" ]; then
  P="${P}no backup dump found in /var/backups/growth\n"
else
  OLD=$(remote "sudo -n find '$BACKUP' -maxdepth 0 -mmin +2880")
  [ -n "$OLD" ] && P="${P}newest backup is older than 48h: $BACKUP\n"
fi
# 6. Journal errors in the last 24h.
ERRS=$(remote 'sudo -n journalctl -u growth.service --since "-1 day" -p err --no-pager -q | tail -5')
[ -n "$ERRS" ] && P="${P}growth.service logged errors in the last 24h:\n$ERRS\n"

# 7. Disk headroom.
DISK=$(remote 'df -P / | tail -1 | awk "{print \$5}" | tr -d "%"')
if [ -n "$DISK" ] && [ "$DISK" -ge 90 ] 2>/dev/null; then
  P="${P}root filesystem is ${DISK}% full\n"
fi

# Healthy = empty stdout = silent. Print only when something is wrong.
if [ -n "$P" ]; then
  echo "GROWTH LIVE-CHECK — PROBLEM(S) FOUND $(date -u +%Y-%m-%dT%H:%MZ)"
  printf '%b' "$P"
  echo "counts leads/verified/drafts/messages: ${COUNTS:-unavailable}"
  echo "(read-only check; nothing was changed)"
fi
