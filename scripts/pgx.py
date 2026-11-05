#!/usr/bin/env python3
"""Run pg_dump / pg_restore / psql as the app's database role.

Credentials are read from the app's own env file and passed through the process
environment, so no secret appears on a command line, in shell history, or in this
file. This is the reviewed copy of the helper the deploy depends on: it lives in
the repository rather than /tmp, so the bytes that run are the bytes that were
reviewed.

    pgx.py psql -d growth -X -A -t -c "SELECT id FROM _migrations"
"""
import os
import subprocess
import sys
import urllib.parse

ENV_FILE = "/home/growth/.growth.env"


def load_target(path=ENV_FILE):
    """Read DATABASE_URL from the app's env file and return PG* environment values."""
    with open(path) as handle:
        for line in handle:
            if not line.startswith("DATABASE_URL="):
                continue
            raw = line.split("=", 1)[1].strip().strip('"').strip("'")
            url = urllib.parse.urlparse(raw)
            return {
                "PGHOST": url.hostname or "127.0.0.1",
                "PGPORT": str(url.port or 5432),
                "PGUSER": url.username or "",
                "PGPASSWORD": urllib.parse.unquote(url.password or ""),
                "PGDATABASE": (url.path or "").lstrip("/"),
            }
    raise SystemExit(f"{path}: no DATABASE_URL line found")


def main(argv):
    if not argv:
        raise SystemExit(__doc__)
    os.environ.update(load_target())
    return subprocess.run(argv).returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
