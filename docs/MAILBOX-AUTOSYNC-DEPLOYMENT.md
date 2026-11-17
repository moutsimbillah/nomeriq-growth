# Mailbox scheduled sync: proposed installation package

This package is **local and disabled by default**. It adds only the mailbox sync service,
its conservative timer, a backup-retention/storage guard, and reversible quarantine. It does
not send mail, change mailbox settings, alter billing, upload backups, delete backups younger
than 30 days, or modify existing research/follow-up/sends units. The founder approved automatic
removal of timestamped database dumps older than 30 days; no other backup files are eligible.

## Files and fixed paths

- `scripts/install-mailbox-sync.sh` — strict steps: `install`, `run-once`, `enable`, `disable`,
  `quarantine`; each takes exactly the expected 40-character release SHA.
- `scripts/bootstrap-mailbox-sync-installer.sh` — root-only staging of the exact committed installer
  blob into `/home/ubuntu/growth-mailbox-install/<release-sha>/`, with a root-owned mode-600 blob
  marker. It refuses a dirty/mismatched release or conflicting staged bytes and safely resumes a
  valid partial stage.
- The installed root wrapper also accepts `undo <run-id>`; it requires the timer disabled and both
  timer/service inactive, takes and verifies a fresh backup, and validates the structured undo
  status and journal-row count before reporting success.
- Immediately after creating a scheduled run, the private CLI emits `RUN_STARTED run_id=<uuid>`;
  the root wrapper forwards only that validated breadcrumb to the service journal and suppresses
  other CLI diagnostics. It is the recovery ID if systemd terminates the run before final output.
- `scripts/mailbox-sync-storage-check.sh` — root-trusted manifest check, fixed
  `/var/backups/growth`, exact 30-day UTC timestamp retention (only regular `deploy-*.dump`
  files owned by `growth:growth`, mode `600`, link count 1, and strictly older than the cutoff
  are removed), at least **2,097,152 KiB** free, at most **3,200** timestamped dumps, and refusal
  if the current timestamped dump target already exists. Any inventory failure, invalid date or
  unsafe matching file stops the sync; files inside the 30-day window and unrelated files are preserved.
- `scripts/systemd/growth-mailbox-sync.service` — root oneshot, storage check before the reviewed
  root wrapper, 300-second timeout, control-group kill, existing `growth-cron-alert.service` on
  failure.
- `scripts/systemd/growth-mailbox-sync.timer` — a 15-minute activation trigger and a separate
  15-minute trigger after the service last completed; the earlier due trigger wins. Enable it
  directly after the verified initial sync, not after leaving an old completed run for hours.
  Installation performs daemon-reload only;
  it does not start or enable the timer.

The runtime directory is `/usr/local/lib/growth-mailbox-sync`, with root-owned files and a pinned
`SHA256SUMS`. The private sync CLI and its imports are not executed from the mutable checkout: installation creates the
root-owned `/usr/local/lib/growth-mailbox-sync/app` snapshot from exact Git blobs plus a physical
copy of the existing `node_modules` tree. Its `protected-manifest` hashes every snapshot regular
file; links must be relative and resolve inside the snapshot, and regular-file hard-link counts are one. The wrapper validates
that snapshot, `/usr/bin/node`, its parent chain, and a fixed environment before dispatch. It never
copies `.env*`, credentials, or user data. The existing `/home/growth/deploy/deploy.sh` remains
untouched; the package requires its exact reviewed SHA256 `a8cc605ca1dfe323f1b3b7ce1d123e1ae3f8197268fc9339399b2d37b593f8c6` before installation. No service environment file or credential is copied into the root runtime.
The unchanged approved backup script still invokes the checkout's `scripts/pgx.py` as `growth`.
That existing backup-helper boundary is distinct from the protected private CLI snapshot.
The oneshot creates a root-private `/run/growth-mailbox-sync` lock directory; its lock is not
placed in the commonly writable `/run/lock` directory.

## Founder approval boundary

Building, testing, and reviewing this local package do not install it. The founder approved
30-day automatic retention of old database dump backups; this approval does not cover any other
file class or data. Any real installation,
run-once import, timer enable/disable, or quarantine is a founder-approval action for these exact
new privileged scripts and units. A short application deployment/restart is a separate approval.
Before any live schema action, show the exact SQL to the founder and obtain approval; this package
never applies migration SQL.

## Reviewed sequence

1. Review the exact candidate bytes and run the isolated tests.
2. On the target, stage and install only the exact release bytes:
   `sudo -n bash /home/growth/app/scripts/bootstrap-mailbox-sync-installer.sh <release-sha>`, then
   `sudo -n bash /home/ubuntu/growth-mailbox-install/<release-sha>/install-mailbox-sync.sh install <release-sha>`.
   The installer verifies the clean release, source files, deploy hash, fixed paths, ownership/modes,
   and refuses unmanaged collisions. It installs units but leaves them disabled and stopped, then
   runs daemon-reload only.
3. `sudo -n bash /home/ubuntu/growth-mailbox-install/<release-sha>/install-mailbox-sync.sh run-once <release-sha>`
   performs the storage precheck and starts only the new service. The
   service takes and verifies a fresh dump through the existing authorized deploy routine before
   the private CLI initializes the database. It records `first-sync.ok` only after systemd reports
   `Result=success`, `ExecMainStatus=0`, inactive completion, and the CLI's own completion/checkpoint readback succeeds. This is the
   explicitly approved initial live import, not a health probe.
4. `sudo -n bash /home/ubuntu/growth-mailbox-install/<release-sha>/install-mailbox-sync.sh enable <release-sha>`
   requires the successful marker, matching release, loaded failure-alert
   unit, an intact **complete** install-state marker, and intact managed files, then enables/starts only the new timer.
5. `disable <release-sha>` disables/stops only the new timer and service. `quarantine <release-sha>`
   acquires the writer's root-owned lock, takes and verifies a fresh backup through the unchanged
   original approved deploy helper, and disables/stops only units that actually exist. It does not
   execute a potentially corrupt private CLI to undo its installation. After stop readback it records
   an atomically published immutable inventory (unit hashes/metadata and runtime inode), then preserves complete or partial runtime bytes and
   any units already copied under the deterministic root-controlled
   `/usr/local/lib/growth-mailbox-sync-quarantine/<release-sha>/` destination by rename. Missing
   units are recorded as absent; an existing quarantine with the same SHA is resumed only when its
   marker matches, and conflicting files are refused. A failed post-publish install is never treated
   as complete or usable by run-once/enable. Quarantine retries do not overwrite or delete artifacts,
   then daemon-reload and leave backups, journal, migration 035, and application code untouched.
   A separate completion marker is published last; retries derive progress from the original inventory
   and actual paths, including interruption immediately after a rename. Unknown unit bytes are refused;
   a partial unit must be an exact prefix of the committed unit. A quarantined SHA cannot be installed
   again: a subsequent installation requires a separately reviewed newer release. Unpublished staging
   directories remain inert and retained as failure evidence; this action does not delete them.

If an initial or later writer run fails after producing a `run-id`, never enable or re-enable the
timer. Keep the root runtime installed long enough to use its protected wrapper. If the timer may be
enabled, first run the reviewed installer's `disable <release-sha>` step and read back **disabled** /
**inactive** for the timer and service. Then run
`sudo -n bash /usr/local/lib/growth-mailbox-sync/growth-cron-sync.sh undo <run-id>`.
The wrapper independently enforces quiescence, takes a fresh verified dump, and the CLI re-verifies
that receipt before database access. Undo is limited to the one scheduled run: it preflights every
journaled row, restores only unchanged database state, preserves the journal and audit history, and
refuses if later changes conflict, the lease is still live, or a Sent-copy external-effect intent
exists. A successful readback reports `UNDO_SUCCESS`, the run ID and journal-row count. A conflict
or any other failure stops here: leave units disabled/inactive, do not restore the database, do not
force past the conflict, and obtain a separately reviewed repair/containment decision. Run quarantine
only as the separately reviewed preservation/containment step; it is not mailbox-data undo and must
not precede a needed undo because it moves the wrapper.

If systemd killed the service before the wrapper printed a run ID, retrieve the matching breadcrumb
from the service journal (use the failed service's time window; if more than one run ID is plausible,
stop rather than guess):
`sudo -n journalctl -u growth-mailbox-sync.service --since "<failed-run-time>" --no-pager -q | grep -E '^RUN_STARTED run_id='`.
After a forced interruption, once the service is confirmed inactive and the timer disabled, wait at
least 120 seconds for the final run lease to expire. Then run the undo command above; it takes a new
verified backup. A run that reported a handled failure has already released its lease and does not
need this wait.

If any check fails, the step stops. Expired-backup removal is bounded by the approved 30-day rule;
other storage pauses are explicit maintenance conditions, not silent cleanup. The package does not
claim full timer notification delivery proof; the existing alert unit
is integrated and its load state is checked before timer activation.

## Future deployments

Before changing the application checkout or the CLI source, disable/quiesce this timer, complete
the reviewed source deployment, and perform a separately reviewed resume with an updated protected
snapshot. The CLI changes its working directory to the fixed application root but executes the protected
snapshot code and loads its own environment internally; the package does not copy or print
credentials. No email, live-mode, or automatic follow-up permission is implied.
