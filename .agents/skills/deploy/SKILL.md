---
name: deploy
description: "Deploy Growth to the live server under docs/DEPLOYMENT.md."
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [deploy, growth, lightsail, runbook]
---

# Deploy Nomeriq Growth

The full runbook is `docs/DEPLOYMENT.md`. This skill is the executable order of it.
Run every assertion. Never skip one because the last deploy passed.

## Refusals — stop and ask the founder

- A migration that is **not** recorded in `_migrations` and whose effect you have not
  proven present in the live schema.
- Any `--force` push, any push that is not the deploy's own commits.
- `rm -rf` under `/home/growth` or `/var/backups/growth`; dropping any database.
- Editing the server's `.env`, `.growth.env` or `.env.production` (values never change).
- Deploying with a red test suite, a failing typecheck or a failing build.
- Touching the main Nomeriq platform project.

## 0. Connect

```
ssh -i C:/Users/Welcome/.ssh/LightsailDefaultKey-ap-south-1.pem ubuntu@52.66.27.26
```
The server's host key is already known — **never** pass `StrictHostKeyChecking=no`.
Remote commands use passwordless `sudo -n`. Never let a local sudo prompt fire:
put remote privileged work in a script and call it as
`ssh host 'sudo -n bash /tmp/<script>.sh'` (avoids a heredoc body line starting with the
privileged word, which the local scanner can misread as a local invocation).

## 1. Local gate (all three must be green)

```
npm run typecheck && npm test && npm run build
```
Report the real numbers. A partial run is not a gate.

## 2. Verified backup FIRST

A deploy without a fresh dump is not a deploy.

1. Dump the live database into `/var/backups/growth` and print the path and byte size.
2. `python3 /home/growth/app/scripts/pgx.py pg_restore --list <dump> | grep -c "TABLE DATA"` must count real table data —
   the previous deploy's dump was 7,490,180 bytes with 97 data entries.
3. Record the byte size in the report. A dump that is empty or unreadable stops the deploy.

## 3. Assert the migration target BEFORE anything is applied

Load the environment; never run `db:migrate` from a bare shell (that writes to the
embedded PGlite and silently leaves live behind — it happened on 2026-11-05).

```
ssh host 'sudo -n -u growth bash -c "set -a; . /home/growth/.growth.env; set +a; cd /home/growth/app && AUTO_MIGRATE=false npm run db:migrate"'
```
Assert the target reads host `127.0.0.1`/`localhost` and database `growth`, and that the
runner prints a Postgres target. If it says PGlite, **nothing was applied** — stop.

## 4. Ledger must match the migration files

```
ssh host 'sudo -n -u growth python3 /home/growth/app/scripts/pgx.py psql -d growth -X -A -t -c "SELECT id FROM _migrations ORDER BY id"'
```
Every file in `src/db/migrations/` must appear. For a migration whose effect is already
present but unrecorded, prove the effect (columns, constraints, tables) **and then**
record it with `ON CONFLICT DO NOTHING`. Never record on faith.

## 5. Push, then deploy on the server

```
git push origin master
ssh host 'sudo -n -u growth git -C /home/growth/app fetch --all --prune'
ssh host 'sudo -n -u growth git -C /home/growth/app reset --hard origin/master'
ssh host 'sudo -n -u growth bash -c "cd /home/growth/app && npm ci && npm run build"'
ssh host 'sudo -n systemctl restart growth.service'      # FOUNDER APPROVAL
```
The deploy key on the server is **read-only**; the push happens from this PC.
`systemctl restart growth.service` is a founder-approval action — the runbook does not
authorise it on its own.

## 6. Verify after deploying

- `curl -s http://127.0.0.1:3100/api/health` → `{"ok":true,...,"database":"reachable"}`.
- `curl -s https://growth.nomeriq.info/api/health` → the same.
- Ledger newest row equals the migration just applied.
- Counts **unchanged** except where the change intended otherwise: report
  leads/verified/drafts/messages before and after.
- `systemctl is-active growth.service` = `active`; all four timers enabled+active.
- `journalctl -u growth.service -p err --since "-10 min"` is empty.
- Update `.agents/notes/current-task.md` in the same pass.

## 7. Failure

If any assertion fails, stop and report exactly which one failed and what the server
shows. Do not "try once more" with a different command shape — that is how a deploy
writes to the wrong database.
