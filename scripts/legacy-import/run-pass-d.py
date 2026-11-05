"""Run pass D and report what it did, with the qualification breakdown and its exceptions."""
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
def q(sql):
    a = ["psql", "-d", DB,"-X","-q","-v","ON_ERROR_STOP=1","-c","\\set VERBOSITY terse","-A","-t","-F","|","-c",sql]
    r = subprocess.run(a, capture_output=True, text=True)
    return "ERR " + SCRUB.sub("<redacted>", r.stderr).strip()[:110] if r.returncode else r.stdout.strip()
done = subprocess.run(["psql", "-d", DB,"-X","-q","-v","ON_ERROR_STOP=1","-c","\\set VERBOSITY terse","-f",sys.argv[1]], capture_output=True, text=True)
if done.returncode:
    print("PASS D FAILED"); print(SCRUB.sub("<redacted>", done.stderr or done.stdout).strip()[:600]); sys.exit(1)
print("PASS D RAN")
print("verified after commit, from a new connection:")
for label, sql in [
  ("suppressions with a lead",   "SELECT count(*) FROM suppressions WHERE prospect_id IS NOT NULL"),
  ("suppressions without",       "SELECT count(*) FROM suppressions WHERE prospect_id IS NULL"),
  ("leads with a signal",        "SELECT count(*) FROM prospects WHERE signal_description IS NOT NULL"),
  ("leads with a summary",       "SELECT count(*) FROM prospects WHERE evidence_summary IS NOT NULL"),
  ("sources after dedupe",       "SELECT count(*) FROM prospect_sources"),
  ("source rows per lead (max)", "SELECT max(n) FROM (SELECT count(*) AS n FROM prospect_sources GROUP BY prospect_id) x"),
  ("sources marked FAIL",        "SELECT count(*) FROM prospect_sources WHERE notes LIKE 'FAIL%'"),
  ("qualification verified",     "SELECT count(*) FROM prospects WHERE qualification_status = 'verified'"),
  ("qualification candidate",    "SELECT count(*) FROM prospects WHERE qualification_status = 'candidate'"),
  ("  verified because emailed",  "SELECT count(*) FROM prospects p WHERE p.qualification_status = 'verified' AND EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'outbound' AND m.delivery_status IN ('accepted','uncertain'))"),
  ("  verified without email",    "SELECT count(*) FROM prospects p WHERE p.qualification_status = 'verified' AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'outbound' AND m.delivery_status IN ('accepted','uncertain'))"),
  ("EXCEPTION: verified with no eligible market", "SELECT count(*) FROM prospects p WHERE p.qualification_status = 'verified' AND NOT EXISTS (SELECT 1 FROM stg.rows sc JOIN stg.old_to_new om ON om.old_prospect_id = sc.data->>'prospect_id' WHERE om.prospect_id = p.id AND sc.source_table = 'marketing_prospect_signal_categories')"),
  ("EXCEPTION: under review but verified", "SELECT count(*) FROM prospects p WHERE p.qualification_status = 'verified' AND EXISTS (SELECT 1 FROM stg.rows er JOIN stg.old_to_new om ON om.old_prospect_id = er.data->>'prospect_id' WHERE om.prospect_id = p.id AND er.source_table = 'marketing_eligibility_reviews' AND er.data->>'state' = 'REVIEW_REQUIRED')"),
  ("EXCEPTION: verified without an official check", "SELECT count(*) FROM prospects p WHERE p.qualification_status = 'verified' AND NOT EXISTS (SELECT 1 FROM stg.rows cc JOIN stg.rows ct ON ct.source_table = 'marketing_prospect_contacts' AND ct.data->>'id' = cc.data->>'contact_id' JOIN stg.old_to_new om ON om.old_prospect_id = cc.data->>'prospect_id' WHERE om.prospect_id = p.id AND cc.source_table = 'marketing_contact_checks' AND cc.data->>'result' = 'VERIFIED' AND cc.data->>'method' = 'PUBLISHED_SOURCE' AND ct.data->>'route' = 'EMAIL' AND ct.data->>'official_status' = 'OFFICIAL')"),
  ("assessment NO or brand risk HIGH", "SELECT count(*) FROM prospects WHERE follow_up_excluded"),
  ("  of those, still do_not_contact",  "SELECT count(*) FROM prospects WHERE follow_up_excluded AND do_not_contact"),
  ("VERIFY_FIRST leads (needs review, unchanged)", "SELECT count(*) FROM prospects p WHERE EXISTS (SELECT 1 FROM stg.rows a JOIN stg.old_to_new om ON om.old_prospect_id = a.data->>'prospect_id' JOIN stg.rows pr ON pr.source_table = 'marketing_prospects' AND pr.data->>'current_assessment_id' = a.data->>'id' WHERE om.prospect_id = p.id AND a.source_table = 'marketing_qualification_assessments' AND a.data->>'qualification' = 'VERIFY_FIRST')"),
]:
    print(f"  {label}: {q(sql)}")
print("  exceptions, by name:")
print(q("SELECT business_name || ' | ' || status || ' | ' || qualification_status || ' | excluded from auto follow-up' FROM prospects WHERE follow_up_excluded ORDER BY business_name"))
print("  the 5 under review, by qualification:")
print(q("SELECT p.qualification_status, count(*) FROM prospects p WHERE EXISTS (SELECT 1 FROM stg.rows er JOIN stg.old_to_new om ON om.old_prospect_id = er.data->>'prospect_id' WHERE om.prospect_id = p.id AND er.source_table = 'marketing_eligibility_reviews' AND er.data->>'state' = 'REVIEW_REQUIRED') GROUP BY 1"))
print("  the 5 under review, by qualification:")
print("   ", q("SELECT coalesce(p.qualification_status,'-') || '=' || count(*) FROM prospects p WHERE EXISTS (SELECT 1 FROM stg.rows er JOIN stg.old_to_new om ON om.old_prospect_id = er.data->>'prospect_id' WHERE om.prospect_id = p.id AND er.source_table = 'marketing_eligibility_reviews' AND er.data->>'state' = 'REVIEW_REQUIRED') GROUP BY 1").replace("\n", " "))
