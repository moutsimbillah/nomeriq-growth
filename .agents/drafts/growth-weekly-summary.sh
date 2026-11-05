#!/usr/bin/env bash
# Weekly summary for Nomeriq Growth — read-only. Delivered every Monday morning.
# Unlike the daily check this always prints: the point is the trend, not silence.
set -uo pipefail

KEY="C:/Users/Welcome/.ssh/LightsailDefaultKey-ap-south-1.pem"
HOST="ubuntu@52.66.27.26"
REPO="/d/DeepSeek Nomeirq3.5/Nomeriq Leads"

remote() { timeout 90 ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=20 "$HOST" "$1" 2>/dev/null; }
sql()    { remote "sudo -n -u growth python3 /tmp/pgx.py psql -d growth -X -A -t -c \"$1\""; }

echo "GROWTH WEEKLY SUMMARY — $(date -u +%Y-%m-%d)"
echo ""
echo "counts (leads/verified/drafts/messages): $(sql "SELECT (SELECT count(*) FROM prospects), (SELECT count(*) FROM prospects WHERE qualification_status = 'verified'), (SELECT count(*) FROM drafts), (SELECT count(*) FROM messages)" | tr '\t' '/')"
echo "migrations in ledger: $(sql 'SELECT count(*) FROM _migrations')"
echo "newest migration: $(sql 'SELECT id FROM _migrations ORDER BY id DESC LIMIT 1')"
echo ""
echo "deployed commit: $(remote 'sudo -n -u growth git -C /home/growth/app log --oneline -1')"
echo "health: $(remote 'curl -s -m 10 -o /dev/null -w "%{http_code}" https://growth.nomeriq.info/api/health')"
echo ""
echo "backups: $(remote "sudo -n bash -c 'ls -1 /var/backups/growth/*.dump 2>/dev/null | wc -l'") dumps, newest $(remote "sudo -n bash -c 'ls -1t /var/backups/growth/*.dump 2>/dev/null | head -1'")"
echo "service errors last 7d: $(remote 'sudo -n journalctl -u growth.service --since "-7 days" -p err --no-pager -q | wc -l')"
echo ""
echo "recent commits (repo checkout):"
(cd "$REPO" && git log --oneline -10 2>/dev/null | sed 's/^/  /')
echo ""
echo "(read-only summary; nothing was changed)"
