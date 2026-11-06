---
name: live-check
description: "Read-only health check of the live Growth server."
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [live-check, growth, read-only, monitoring]
---

# Live check (read-only)

Prove the server is healthy **without changing anything**. Every command here is a read.
Script: `~/.hermes/scripts/growth-live-check.sh` (empty stdout = healthy = silent).

## Refusals

- No write of any kind: no INSERT/UPDATE/DELETE/DDL, no migration, no service restart,
  no file delete, no `.env` edit, no email send.
- Never read row **contents** — counts only. Lead rows are real businesses' data.
- Never print a secret, a connection string or a password.
- If a check needs a privileged read, it goes in a script invoked as
  `ssh host 'sudo -n bash /tmp/<script>.sh'` — never a heredoc whose body starts with the
  privileged word, and never a local password prompt.

## Connection

```
ssh -i C:/Users/Welcome/.ssh/LightsailDefaultKey-ap-south-1.pem ubuntu@52.66.27.26
```
Host key is already known — never `StrictHostKeyChecking=no`. Use `-o BatchMode=yes`.

## What to check, in order

1. **API** — `http://127.0.0.1:3100/api/health` and `https://growth.nomeriq.info/api/health`
   both `200`, body `{"ok":true,...,"database":"reachable"}`.
2. **Service** — `systemctl is-active growth.service` = `active`.
3. **Timers** — `growth-backup`, `growth-cron-research`, `growth-cron-follow-ups`,
   `growth-cron-sends` all `enabled` + `active`; `systemctl list-timers` shows a next fire.
4. **Ledger** — every file in `src/db/migrations/` appears in
   `sudo -n -u growth python3 /home/growth/app/scripts/pgx.py psql -d growth -X -A -t -c "SELECT id FROM _migrations ORDER BY id"`.
   A repo migration missing from the ledger is the fault that broke a deploy once.
5. **Counts** — `prospects`, `prospects WHERE qualification_status='verified'`, `drafts`,
   `messages`. Report the numbers; a large unexplained drop is an incident.
   (Note the column is `qualification_status`, **not** `email_verified`.)
6. **Backups** — newest `/var/backups/growth/*.dump` younger than 48h.
   That directory is mode `0700 growth`, so the listing needs `sudo -n`.
7. **Journal** — `sudo -n journalctl -u growth.service --since "-1 day" -p err --no-pager -q`
   is empty.
8. **Disk** — root filesystem under 90%.

## Reading a failure

State the failed assertion, the value observed, and the command that produced it. Do not
fix anything during a live check — fixing is a separate, approved action.
Counts-only logging: never copy lead names, emails or message bodies into a report.
