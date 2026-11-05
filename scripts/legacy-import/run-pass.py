"""Run one pass of the import and print what it did: counts only, never a record value."""
import os, re, subprocess, sys, urllib.parse
os.umask(0o077)
for line in open("/home/growth/.growth.env"):
    if line.startswith("DATABASE_URL="):
        p = urllib.parse.urlparse(line.split("=", 1)[1].strip().strip('"').strip("'"))
        os.environ.update(PGHOST=p.hostname or "127.0.0.1", PGPORT=str(p.port or 5432),
                          PGUSER=p.username or "", PGPASSWORD=urllib.parse.unquote(p.password or ""))
DB = "growth_import_dryrun"
SCRUB = re.compile(r"^\s*(DETAIL|CONTEXT|HINT|QUERY):.*$", re.M)

def q(sql, tuples=True):
    a = ["psql", "-d", DB, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", "\\set VERBOSITY terse"]
    a += (["-A", "-t", "-F", "|"] if tuples else []) + ["-c", sql]
    r = subprocess.run(a, capture_output=True, text=True)
    if r.returncode:
        return None, SCRUB.sub("<redacted by the importer>", r.stderr).strip()[:400]
    return r.stdout.strip(), None

file = sys.argv[1]
out, err = q(None if False else "SELECT 1")
done = subprocess.run(["psql", "-d", DB, "-X", "-q", "-v", "ON_ERROR_STOP=1",
                       "-c", "\\set VERBOSITY terse", "-f", file], capture_output=True, text=True)
if done.returncode:
    print("PASS A FAILED")
    print(SCRUB.sub("<redacted by the importer>", done.stderr or done.stdout).strip()[:900])
    sys.exit(1)

print("PASS A RAN")
for label, sql in [
  ("suppressions",            "SELECT count(*) FROM suppressions WHERE source = 'legacy_import'"),
  ("leads imported",          "SELECT count(*) FROM prospects"),
  ("  of which legacy",       "SELECT count(*) FROM prospects WHERE created_by_type = 'legacy'"),
  ("  status contacted",      "SELECT count(*) FROM prospects WHERE status = 'contacted'"),
  ("  status lost",           "SELECT count(*) FROM prospects WHERE status = 'lost'"),
  ("  do_not_contact",        "SELECT count(*) FROM prospects WHERE do_not_contact"),
  ("  pinned to a profile",   "SELECT count(*) FROM prospects WHERE sending_profile_id IS NOT NULL"),
  ("  source_agent claude",   "SELECT count(*) FROM prospects WHERE source_agent = 'claude'"),
  ("  source_agent chatgpt",  "SELECT count(*) FROM prospects WHERE source_agent = 'chatgpt'"),
  ("  source_agent unknown",  "SELECT count(*) FROM prospects WHERE source_agent = 'unknown'"),
  ("emails",                  "SELECT count(*) FROM prospect_emails"),
  ("sources",                 "SELECT count(*) FROM prospect_sources"),
  ("aliases",                 "SELECT count(*) FROM prospect_aliases"),
  ("leads with other_socials","SELECT count(*) FROM prospects WHERE jsonb_array_length(other_socials) > 0"),
  ("leads with categories",   "SELECT count(*) FROM prospects WHERE jsonb_array_length(categories) > 0"),
  ("leads with domain_key",   "SELECT count(*) FROM prospects WHERE domain_key IS NOT NULL"),
  ("collisions demoted",      "SELECT count(*) FROM stg.demoted"),
  ("shared addresses kept out","SELECT count(*) FROM stg.rows c WHERE c.source_table='marketing_prospect_contacts' AND c.data->>'route'='EMAIL' AND EXISTS (SELECT 1 FROM prospect_emails e WHERE e.normalized_email = lower(coalesce(c.data->>'normalized_locator', c.data->>'locator')))"),
  ("P4 Provider emails",      "SELECT count(*) FROM prospect_emails e JOIN prospects p ON p.id = e.prospect_id WHERE p.business_name ILIKE 'P4%'"),
]:
    value, error = q(sql)
    print(f"  {label}: {value if value is not None else 'ERR ' + (error or '')[:80]}")
