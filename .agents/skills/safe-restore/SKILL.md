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

## The agent cannot run this — by design

`restore-safe.sh` and `rehearse.sh` are hard-denied to the agent in Hermes
(`approvals.deny`: `*restore-safe.sh*`, `*rehearse.sh*`), in **both** the `default` and
`growth` profiles. The block fires at the tool layer, before auto-approval, and
`--yolo` / `/yolo` / `approvals.mode=off` cannot waive it. A restore swaps the live
database, so it is a founder decision every single time — not a step the agent reaches
for. `hermes approvals test 'bash scripts/legacy-import/restore-safe.sh'` must print
`BLOCKED`.

Consequence of an absolute rule: it matches the word anywhere in the command, so the
agent cannot `cat`, `grep` or `bash -n` these scripts either. Read them with the
file-reading tool instead. Do not rephrase a blocked command to get around this — that
is exactly what the rule exists to stop.

## Emergency procedure — founder only, by hand

The agent must not do step 1 or step 3. If the agent is asked to, it refuses and says why.

1. **Founder:** in a text editor, open `C:\Users\Welcome\AppData\Local\hermes\config.yaml`
   and `C:\Users\Welcome\AppData\Local\hermes\profiles\growth\config.yaml`. Under
   `approvals:` → `deny:`, delete exactly the one line `    - '*restore-safe.sh*'`.
   Leave every other rule untouched. (`hermes config unset` is itself denied — edit the
   file, or the change cannot be made at all.)
2. **Agent:** with the rule gone, run the restore with the verified dump, in the normal
   order below.
3. **Founder:** put the line back immediately —
   `    - '*restore-safe.sh*'` at the same indentation under `deny:` — in both files, and
   confirm with `hermes config get approvals.deny` that it is listed again.

The rule is out only for the duration of that one approved restore. Leaving it out is
the failure mode this procedure bounds; if you are unsure whether it went back, run the
`approvals test` above.

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
