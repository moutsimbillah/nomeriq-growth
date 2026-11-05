#!/usr/bin/env bash
# Create the throwaway database the importer is proven on. Runs as ubuntu (postgres access), and hands the
# dump/restore to the app's user, which is the only one that can read its env file.
#
#   bash dryrun-create.sh          create, fill and verify the copy
#   bash dryrun-create.sh --drop   remove it
set -uo pipefail
DRY=growth_import_dryrun

if [ "${1:-}" = "--drop" ]; then
  sudo -u postgres dropdb --if-exists "$DRY" && echo "dropped $DRY"
  exit 0
fi

LIVE_DB=$(sudo -u postgres psql -X -A -t -c \
  "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres','$DRY') ORDER BY datname LIMIT 1")
if [ -z "${LIVE_DB:-}" ]; then echo "could not identify the live database"; exit 1; fi
OWNER=$(sudo -u postgres psql -X -A -t -c \
  "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$LIVE_DB'")
echo "=== 1. scratch database ==="
echo "live=$LIVE_DB owner=$OWNER"
sudo -u postgres dropdb --if-exists "$DRY"
sudo -u postgres createdb -O "$OWNER" "$DRY" && echo "created $DRY owned by $OWNER"

sudo -u growth bash /tmp/dryrun-fill.sh "$LIVE_DB"