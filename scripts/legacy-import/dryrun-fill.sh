#!/usr/bin/env bash
# Fill a scratch database from a dump of the live one. Runs as the app's user, which can read its env.
#   bash dryrun-fill.sh <live_db_name>
set -uo pipefail
LIVE_DB="${1:?usage: dryrun-fill.sh <live_db>}"
DRY=growth_import_dryrun
MIGRATIONS="${2:-/tmp/legacy-migrations}"

set -a; . /home/growth/.growth.env; set +a
eval "$(python3 - <<'PY'
import os, shlex, urllib.parse
u = urllib.parse.urlparse(os.environ["DATABASE_URL"])
print("export PGHOST=%s" % shlex.quote(u.hostname or "127.0.0.1"))
print("export PGPORT=%s" % shlex.quote(str(u.port or 5432)))
print("export PGUSER=%s" % shlex.quote(u.username or ""))
print("export PGPASSWORD=%s" % shlex.quote(urllib.parse.unquote(u.password or "")))
PY
)"

echo "=== 2. dump the live database, restore it into the copy ==="
set -o pipefail
pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$LIVE_DB" --no-owner --no-privileges \
  | psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$DRY" -q >/dev/null
echo "restore_exit=$?"

echo "=== 3. apply 017, 018, 019 to the copy (live has up to 016) ==="
for f in 017_legacy_origin.sql 018_legacy_archive.sql 019_legacy_message_source.sql; do
  printf "  %-32s " "$f"
  if psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$DRY" -q -v ON_ERROR_STOP=1 \
       -f "$MIGRATIONS/$f" >/dev/null 2>&1; then echo APPLIED; else echo FAILED; fi
done

echo "=== 4. row counts: the copy versus live ==="
COUNTS="SELECT (SELECT count(*) FROM prospects) AS prospects, (SELECT count(*) FROM drafts) AS drafts,
               (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM messages) AS messages,
               (SELECT count(*) FROM email_accounts) AS accounts, (SELECT count(*) FROM suppressions) AS suppr"
printf "copy: "; psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$DRY"      -X -A -t -F"|" -c "\\set VERBOSITY terse" -c "$COUNTS"
printf "live: "; psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$LIVE_DB" -X -A -t -F"|" -c "\\set VERBOSITY terse" -c "$COUNTS"

echo "=== 5. the three migrations are visible in the copy ==="
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$DRY" -X -A -F"|" -c "
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'legacy') AS legacy_tables,
       (SELECT count(*) FROM pg_constraint WHERE conname = 'messages_source_check'
          AND pg_get_constraintdef(oid) LIKE '%legacy_import%') AS source_allows_import,
       (SELECT count(*) FROM information_schema.columns
          WHERE table_name = 'prospects' AND column_name = 'sending_profile_id') AS profile_col,
       (SELECT count(*) FROM email_accounts WHERE normalized_email = 'moutsim@nomeriq.com') AS moutsim_profile,
       (SELECT count(*) FROM prospects WHERE do_not_contact) AS held_leads;"