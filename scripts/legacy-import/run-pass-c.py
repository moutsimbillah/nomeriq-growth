"""Pass C: run the read-only checks and report a pass or fail line per check. Nothing is written."""
import os, re, subprocess, sys, urllib.parse
# the target is chosen explicitly and checked by name before anything else runs
import argparse
import sys as _sys
_ap = argparse.ArgumentParser()
_ap.add_argument("--database", default="growth_import_dryrun")
_ap.add_argument("--live", action="store_true")
_ap.add_argument("sql")
_args, _unknown = _ap.parse_known_args()
DB = _args.database
if DB == "growth" and not _args.live:
    raise SystemExit("refusing: --database growth without --live")
if _args.sql:
    _sys.argv = [_sys.argv[0], _args.sql]

for line in open("/home/growth/.growth.env"):
    if line.startswith("DATABASE_URL="):
        u = urllib.parse.urlparse(line.split("=", 1)[1].strip().strip('"').strip("'"))
        os.environ.update(PGHOST=u.hostname or "127.0.0.1", PGPORT=str(u.port or 5432),
                          PGUSER=u.username or "", PGPASSWORD=urllib.parse.unquote(u.password or ""))
# the name is a claim; the server is the fact
_r = subprocess.run(["psql", "-d", DB, "-X", "-q", "-A", "-t", "-c", "\\set VERBOSITY terse",
                     "-c", "SELECT current_database()"], capture_output=True, text=True)
_got = (_r.stdout or "").strip().splitlines()[0].strip() if _r.stdout.strip() else "(could not connect)"
if _got != DB:
    raise SystemExit("refusing: asked for '" + DB + "' but the server says '" + _got + "'")
print("target database: " + DB)
SCRUB = re.compile(r"^\s*(DETAIL|CONTEXT|HINT|QUERY):.*$", re.M)
r = subprocess.run(["psql", "-d", DB,"-X","-q","-v","ON_ERROR_STOP=1","-c","\\set VERBOSITY terse",
                    "-v", "expected_db=" + DB, "-f", sys.argv[1]], capture_output=True, text=True)
print(SCRUB.sub("<redacted>", (r.stdout or "") + (r.stderr or "")).strip()[:4000])
if r.returncode:
    print("\nPASS C FAILED"); sys.exit(1)
print("\nPASS C RAN")
