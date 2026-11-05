# .agents/drafts/deny-rules.md — hard blocks (item 3)

## Where they go

Top-level `approvals.deny` in `~/.hermes/config.yaml`. These are **user-defined deny rules**:
they block matching terminal commands unconditionally — they fire *before* `--yolo`,
`/yolo` and `approvals.mode: off` are consulted. They are the "never, ever" list, not the
"usually" list. `approvals.mode` stays `smart`.

## The exact change (one command, verified against a scratch home)

```
hermes config set approvals.deny '["*dropdb*","*drop database*","*pg_restore*","*restore-safe.sh*","*import-window.sh*","*git push --force*","*git push -f*","*git push*--force*","*rm -rf /home/growth*","*rm -rf /var/backups/growth*","*.growth.env*","*.env.production*","*systemctl stop growth*","*systemctl restart growth*"]'
```

## Why each rule exists

| Rule | Blocks |
| --- | --- |
| `*dropdb*` | Dropping any database, locally or over SSH |
| `*drop database*` | The SQL form of the same thing |
| `*pg_restore*` | `pg_restore` into an existing growth database |
| `*restore-safe.sh*` | Any restore run, including `--rehearsal` (deliberate) |
| `*import-window.sh*` | The one-off 2026-11-05 import — never again |
| `*git push --force*`, `*git push -f*`, `*git push*--force*` | Force push in every spelling |
| `*rm -rf /home/growth*`, `*rm -rf /var/backups/growth*` | Recursive deletes of app or backups |
| `*.growth.env*`, `*.env.production*` | Reading or editing the server's env files |
| `*systemctl stop growth*`, `*systemctl restart growth*` | Stopping/restarting live |

## Verified behaviour (14 commands, real matcher, real config loader)

Blocked as intended: remote `dropdb growth`; `restore-safe.sh`; `cat /home/growth/.growth.env`;
`git push --force origin master`; `rm -rf /var/backups/growth`; `systemctl restart growth.service`.

**Still allowed** (proving the rules are not too broad): the read-only ledger query
`sudo -u growth python3 /tmp/pgx.py psql -d growth …SELECT`; `sudo -n bash /tmp/deploy.sh`;
`git push origin master`; `systemctl status growth.service`; `npm run typecheck`;
`ls -1t /var/backups/growth/*.dump | head -1`.

0 mismatches.

## Coverage caveat — read this

Deny rules are **shell-command policy, not an interpreter**. Hermes documents this: matching
does not resolve arbitrary variables, aliases, functions, renamed binaries, wrapper scripts,
or every shell grammar. So these rules stop the *obvious* forms, which is what they are for;
they are not a sandbox. The real containment for live data is the second layer: the database
role's grants, the read-only deploy key, and a human saying yes.

Two rules are deliberately wider than the brief:
- `*restore-safe.sh*` blocks the **rehearsal** path too, because the same script can be
  pointed at live. If you want rehearsals to run unattended, say so and I will narrow the
  rule to the live target only.
- `*systemctl stop/restart growth*` is not in your brief; I added it because those two
  commands take the portal down. Remove them if a deploy must restart the service without
  asking — but then a restart can happen unattended at 3am.
