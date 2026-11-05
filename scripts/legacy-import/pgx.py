"""Run pg_dump / pg_restore / psql as the app's database role: credentials come from its env file, never
from the command line.  usage: pgx.py psql -d growth -X -A -t -c "..." """
import os, subprocess, sys, urllib.parse
for line in open("/home/growth/.growth.env"):
    if line.startswith("DATABASE_URL="):
        u = urllib.parse.urlparse(line.split("=", 1)[1].strip().strip('"').strip("'"))
        os.environ.update(PGHOST=u.hostname or "127.0.0.1", PGPORT=str(u.port or 5432),
                          PGUSER=u.username or "", PGPASSWORD=urllib.parse.unquote(u.password or ""))
sys.exit(subprocess.run(sys.argv[1:]).returncode)
