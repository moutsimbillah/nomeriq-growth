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
- **Disguising a denied name so a deny rule does not see it.** Writing a command so a
  forbidden filename never appears in it — a glob, `$(...)`, a variable, a wildcard — is
  routing around the deny list, and it is banned for every purpose, including a harmless
  read. If a server-side step needs a file whose name is denied, **tell the founder and
  stop**; the repo-side edit is done with the file tools (which are not scoped by the deny
  list) and the normal reviewed deploy carries it to the server.

## 0. Connect

```
ssh -i C:/Users/Welcome/.ssh/LightsailDefaultKey-ap-south-1.pem ubuntu@52.66.27.26
```
The server's host key is already known — **never** pass `StrictHostKeyChecking=no`.
Remote commands use passwordless `sudo -n`. Never let a local sudo prompt fire.

**Two command shapes are allowed, both single-quoted one-liners on the ssh call:**

- read-only work: `ssh host 'cmd1; cmd2'`;
- privileged work: a committed, reviewed script, `ssh host 'sudo -n bash /home/growth/app/scripts/<name>.sh'`.

**The `<<'SH'` heredoc shape is banned for privileged remote commands.** A `sudo`-prefixed
line inside the heredoc body reads to the approval scanner as a *local* privileged
invocation, so it raises a password prompt (the founder cancels it). Never stage a script
in `/tmp` either — a temp copy is unreviewed by definition.

## 1. Local gate (all three must be green)

```
npm run typecheck && npm test && npm run build
```
Report the real numbers. A partial run is not a gate.

## 2. Verified backup FIRST

A deploy without a fresh dump is not a deploy. `deploy.sh prepare` makes the dump and moves
the checkout:

```
ssh host 'sudo -n bash /home/growth/deploy/deploy.sh prepare'
```

It prints the dump path, byte size, mode and table-data count, and hard-fails below 50
entries. Expect about 106 entries and 8.0 MB at roughly 580 leads. Listing the dump's table
data with the backup-restore tool is what this runbook used to do, but the agent deny list
covers that tool's name, so the command is refused and must NOT be reworded, scripted or
routed around. Reviewed alternative, accepted by independent review: rely on the script's own
count (it fails closed) **plus** an independent `sudo -n stat -c "%s %a" <dump>` that must
match the script's size and show mode exactly 600. A dump that is empty, mis-sized or not
mode 600 stops the deploy.

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
ssh host 'sudo -n bash /home/growth/deploy/deploy.sh prepare'
ssh host 'sudo -n bash /home/growth/deploy/deploy.sh build'
ssh host 'sudo -n bash /home/growth/deploy/deploy.sh restart'   # FOUNDER APPROVAL, ASKED FIRST
```

`prepare` dumps the database and checks out `origin/master`; `build` produces the new
`.next` and is the point of no return (it replaces the build under the running process);
`restart` swaps the process over. The server's deploy script hash must equal the hash
`docs/DEPLOYMENT.md` records as current and founder-approved, checked read-only before
anything runs. The deploy key on the server is **read-only**; the push happens from this PC.

**Ask for the restart approval BEFORE the first live write, in the same turn as the deploy
starts.** `build` is the point of no return, so a "no" asked at the restart step leaves live
half-changed with no reviewed undo. Record the founder's own words in the review packet as a
gate ahead of the push. A yes given for an earlier change does not carry over to a new change.

## 6. Verify after deploying

- `curl -s http://127.0.0.1:3100/api/health` → `{"ok":true,...,"database":"reachable"}`.
- `curl -s https://growth.nomeriq.info/api/health` → the same.
- Ledger newest row equals the migration just applied.
- Counts **unchanged** except where the change intended otherwise: report
  leads/verified/drafts/messages before and after.
- `systemctl is-active growth.service` = `active`; all four timers enabled+active.
- `journalctl -u growth.service -p err --since "<restart time>"` is empty, and a fixed
  window (10 minutes) after the restart holds zero `timeout exceeded when trying to connect`
  lines, read in the background so the wait is not idle polling.
- Update `.agents/notes/current-task.md` in the same pass.
- Never sign in to verify, and never time a route behind the login wall.

**The deploy commands raise an on-screen approval prompt** (the backup/`prepare` one is the
blocker). Tell the founder to be at the screen and press Approve; a chat "deploy karo" is not
that prompt. If no one answers within five minutes the command does not run: stop and report,
never re-run it hoping for a different result, and never rephrase it to dodge the prompt.

## 7. Failure

If any assertion fails, stop and report exactly which one failed and what the server
shows. Do not "try once more" with a different command shape — that is how a deploy
writes to the wrong database.
