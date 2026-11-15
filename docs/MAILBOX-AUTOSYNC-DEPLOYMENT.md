# Mailbox scheduled sync: proposed installation package

This package is **local and disabled by default**. It adds only the mailbox sync service,
its conservative timer, a read-only backup-storage guard, and reversible quarantine. It does
not send mail, change mailbox settings, alter billing, upload backups, delete backups, or modify
existing research/follow-up/sends units.

## Files and fixed paths

- `scripts/install-mailbox-sync.sh` — strict steps: `install`, `run-once`, `enable`, `disable`,
  `quarantine`; each takes exactly the expected 40-character release SHA.
- `scripts/mailbox-sync-storage-check.sh` — root-trusted manifest check, fixed
  `/var/backups/growth`, at least **2,097,152 KiB** free, at most **1,000** timestamped dumps,
  and refusal if the current timestamped dump target already exists. It is read-only.
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

Building, testing, and reviewing this local package do not install it. Any real installation,
run-once import, timer enable/disable, or quarantine is a founder-approval action for these exact
new privileged scripts and units. A short application deployment/restart is a separate approval.
Before any live schema action, show the exact SQL to the founder and obtain approval; this package
never applies migration SQL.

## Reviewed sequence

1. Review the exact candidate bytes and run the isolated tests.
2. On the target, `install <release-sha>` verifies the exact clean release, source files, deploy
   hash, fixed paths, ownership/modes, and refuses unmanaged collisions. It installs units but
   leaves them disabled and stopped, then runs daemon-reload only.
3. `run-once <release-sha>` performs the storage precheck and starts only the new service. The
   service takes and verifies a fresh dump through the existing authorized deploy routine before
   the private CLI initializes the database. It records `first-sync.ok` only after systemd reports
   `Result=success`, `ExecMainStatus=0`, inactive completion, and the CLI's own completion/checkpoint readback succeeds. This is the
   explicitly approved initial live import, not a health probe.
4. `enable <release-sha>` requires the successful marker, matching release, loaded failure-alert
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

If any check fails, the step stops. Storage pauses are explicit maintenance conditions, not silent
cleanup. The package does not claim full timer notification delivery proof; the existing alert unit
is integrated and its load state is checked before timer activation.

## Future deployments

Before changing the application checkout or the CLI source, disable/quiesce this timer, complete
the reviewed source deployment, and perform a separately reviewed resume with an updated protected
snapshot. The CLI changes its working directory to the fixed application root but executes the protected
snapshot code and loads its own environment internally; the package does not copy or print
credentials. No email, live-mode, or automatic follow-up permission is implied.
