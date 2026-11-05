---
name: safe-restore
description: "Rehearsed procedure to put a dump back safely."
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [restore, backup, growth, rehearsal]
---

# Safe restore

`scripts/legacy-import/restore-safe.sh` in the repo is the **only** supported way to put a
dump back. It never writes into the live database. Read it before running it.

## Refusals — these need the founder, every time

- Restoring into the **live** database (`--target growth` without `--rehearsal`).
- `pg_restore` into an existing growth database, or any `--clean`.
- `dropdb`, `DROP DATABASE`, or dropping a `__old_` / `__restore_` database.
- `import-window.sh` — a one-off record of the 2026-11-05 migration, **never run again**.
- Running any of this without a verified dump in hand.

## Order matters

1. **Prove the dump first, before creating anything.** It must exist, be non-empty, and
   `python3 /tmp/pgx.py pg_restore --list <dump> | grep -c "TABLE DATA"` must count real table data.
   A restore with no usable dump is how a rollback destroys what it meant to protect.
2. **Restore into a NEW database** named `<target>__restore_<utc>`, owned by `growth_app`.
3. **Abort on any `pg_restore` error.** Never `--clean`, never ignore errors: a run that
   prints `errors ignored: N` and carries on leaves a database nobody can trust.
4. **Verify before swapping** — read counts from the new database and refuse to continue if
   it came back empty.
5. **Swap by renaming** — stop `growth.service` *(founder approval)*, terminate remaining
   connections, rename live aside to `<target>__old_<utc>`, rename the restored one in.
   The previous database is **kept, not dropped**.
6. **Start the service and re-verify the counts.** Drop the `__old_` database only when the
   founder says so.

## Rehearse first

```
bash scripts/legacy-import/restore-safe.sh --target growth_restoretest --dump <file> --rehearsal
```
`--rehearsal` skips the service stop and the connection termination. Rehearse on a
throwaway target before anyone trusts the procedure on live. Report the counts the
rehearsal produced; that is the evidence the procedure works.

## Connection

`ssh -i C:/Users/Welcome/.ssh/LightsailDefaultKey-ap-south-1.pem ubuntu@52.66.27.26`
Records transport with `-o BatchMode=yes` and the normal host-key check — never
`StrictHostKeyChecking=no`. Privileged remote work goes through
`ssh host 'sudo -n bash /tmp/<script>.sh'`.
