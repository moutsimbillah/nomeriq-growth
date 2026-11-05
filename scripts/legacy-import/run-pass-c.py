"""Pass C: run the read-only checks and report a pass or fail line per check. Nothing is written."""
import os, re, subprocess, sys, urllib.parse
for line in open("/home/growth/.growth.env"):
    if line.startswith("DATABASE_URL="):
        u = urllib.parse.urlparse(line.split("=", 1)[1].strip().strip('"').strip("'"))
        os.environ.update(PGHOST=u.hostname or "127.0.0.1", PGPORT=str(u.port or 5432),
                          PGUSER=u.username or "", PGPASSWORD=urllib.parse.unquote(u.password or ""))
SCRUB = re.compile(r"^\s*(DETAIL|CONTEXT|HINT|QUERY):.*$", re.M)
r = subprocess.run(["psql","-d","growth_import_dryrun","-X","-q","-v","ON_ERROR_STOP=1","-c","\\set VERBOSITY terse",
                    "-f", sys.argv[1]], capture_output=True, text=True)
print(SCRUB.sub("<redacted>", (r.stdout or "") + (r.stderr or "")).strip()[:4000])
if r.returncode:
    print("\nPASS C FAILED"); sys.exit(1)
print("\nPASS C RAN")
