"""Run pass A and print what it did: counts and names of the 4 existing leads or merge groups only."""
import json, os, re, subprocess, sys, urllib.parse
os.umask(0o077)
for line in open("/home/growth/.growth.env"):
    if line.startswith("DATABASE_URL="):
        u = urllib.parse.urlparse(line.split("=", 1)[1].strip().strip('"').strip("'"))
        os.environ.update(PGHOST=u.hostname or "127.0.0.1", PGPORT=str(u.port or 5432),
                          PGUSER=u.username or "", PGPASSWORD=urllib.parse.unquote(u.password or ""))
DB, EXPORT = "growth_import_dryrun", "/home/growth/import/Nomeriq-Growth-Export-20261104T201547Z-2aa5fc9e2b"
SCRUB = re.compile(r"^\s*(DETAIL|CONTEXT|HINT|QUERY):.*$", re.M)

def q(sql, tuples=True, stop=True):
    a = ["psql", "-d", DB, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", "\\set VERBOSITY terse"]
    a += (["-A", "-t", "-F", "|"] if tuples else []) + ["-c", sql]
    r = subprocess.run(a, capture_output=True, text=True)
    if r.returncode and stop:
        return None, SCRUB.sub("<redacted by the importer>", r.stderr).strip()[:300]
    return r.stdout.strip(), None

# stage the decisions file, base64 so COPY cannot reinterpret anything
decisions = open(os.path.join(EXPORT, "import-decisions.json"), encoding="utf-8").read()
import base64
open("/tmp/dec.b64", "w").write(base64.b64encode(json.dumps(json.loads(decisions)).encode()).decode())
q("DROP TABLE IF EXISTS stg.decisions; CREATE TABLE stg.decisions (data jsonb);"
  " CREATE TEMP TABLE t (b text);")
subprocess.run(["psql", "-d", DB, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", "\\copy t (b) FROM '/tmp/dec.b64'"], capture_output=True, text=True)
q("INSERT INTO stg.decisions SELECT convert_from(decode(b, 'base64'), 'UTF8')::jsonb FROM t")
os.remove("/tmp/dec.b64")

done = subprocess.run(["psql", "-d", DB, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", "\\set VERBOSITY terse",
                       "-f", sys.argv[1]], capture_output=True, text=True)
if done.returncode:
    print("PASS A FAILED")
    print(SCRUB.sub("<redacted by the importer>", done.stderr or done.stdout).strip()[:700])
    sys.exit(1)
print("PASS A RAN")

# the opt-out the decisions file requires before any outreach
opt_out = json.loads(decisions).get("new_portal_suppression_required_before_any_outreach")
found = sorted(set(re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", json.dumps(opt_out))))
for address in found:
    q("INSERT INTO suppressions (id, normalized_email, email, reason, source, note, active) "
      "SELECT gen_random_uuid(), lower(%s), lower(%s), 'opt_out', 'legacy_import', "
      "'requested before any outreach; unapplied in the old portal', true "
      "WHERE NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.normalized_email = lower(%s))"
      % (lit := "'" + address.replace("'", "''") + "'", lit, lit))
    q("UPDATE prospects p SET do_not_contact = true, updated_at = now() WHERE EXISTS "
      "(SELECT 1 FROM prospect_emails e WHERE e.prospect_id = p.id AND e.normalized_email = lower(%s))" % lit)

for label, sql in [
  ("suppressions bounce",     "SELECT count(*) FROM suppressions WHERE reason = 'bounce'"),
  ("suppressions opt_out",    "SELECT count(*) FROM suppressions WHERE reason = 'opt_out'"),
  ("leads",                   "SELECT count(*) FROM prospects"),
  ("  legacy",                "SELECT count(*) FROM prospects WHERE created_by_type = 'legacy'"),
  ("  existing 4 kept",       "SELECT count(*) FROM prospects WHERE created_by_type <> 'legacy'"),
  ("merged groups resolved",  "SELECT count(*) FROM (SELECT DISTINCT kept_old_id FROM stg.merged_away) x"),
  ("  records merged away",   "SELECT count(*) FROM stg.merged_away"),
  ("collisions duplicate",    "SELECT count(*) FROM stg.demoted WHERE rule = 'duplicate-in-import'"),
  ("collisions already-held", "SELECT count(*) FROM stg.demoted WHERE rule = 'already-held'"),
  ("status contacted",        "SELECT count(*) FROM prospects WHERE status = 'contacted'"),
  ("status lost",             "SELECT count(*) FROM prospects WHERE status = 'lost'"),
  ("do_not_contact",          "SELECT count(*) FROM prospects WHERE do_not_contact"),
  ("pinned",                  "SELECT count(*) FROM prospects WHERE sending_profile_id IS NOT NULL"),
  ("agent claude",            "SELECT count(*) FROM prospects WHERE source_agent = 'claude'"),
  ("agent chatgpt",           "SELECT count(*) FROM prospects WHERE source_agent = 'chatgpt'"),
  ("agent unknown",           "SELECT count(*) FROM prospects WHERE source_agent = 'unknown'"),
  ("keys domain",             "SELECT count(*) FROM prospects WHERE domain_key IS NOT NULL"),
  ("keys instagram",          "SELECT count(*) FROM prospects WHERE instagram_key IS NOT NULL"),
  ("keys youtube",            "SELECT count(*) FROM prospects WHERE youtube_key IS NOT NULL"),
  ("keys x",                  "SELECT count(*) FROM prospects WHERE x_key IS NOT NULL"),
  ("keys telegram",           "SELECT count(*) FROM prospects WHERE telegram_key IS NOT NULL"),
  ("emails",                  "SELECT count(*) FROM prospect_emails"),
  ("sources",                 "SELECT count(*) FROM prospect_sources"),
  ("aliases",                 "SELECT count(*) FROM prospect_aliases"),
  ("leads with other_socials","SELECT count(*) FROM prospects WHERE jsonb_array_length(other_socials) > 0"),
  ("leads with categories",   "SELECT count(*) FROM prospects WHERE jsonb_array_length(categories) > 0"),
  ("P4 Provider emails",      "SELECT count(*) FROM prospect_emails e JOIN prospects p ON p.id = e.prospect_id WHERE p.business_name ILIKE 'P4%'"),
]:
    value, error = q(sql)
    print(f"  {label}: {value if value is not None else 'ERR ' + (error or '')[:70]}")

print("collisions by rule, named only where a merge group or an existing lead is involved:")
print("  " + (q("SELECT d.rule || ' | ' || coalesce(l.business_name, '-') || ' | ' || d.authority "
                  "FROM stg.demoted d LEFT JOIN stg.lead l ON l.old_prospect_id = d.old_prospect_id "
                  "ORDER BY d.rule, 2 LIMIT 12")[0] or "").replace("\n", "\n  "))
print("merge groups:")
print(q("SELECT g.business || ' | kept=' || coalesce(g.kept_old_id, '-') || ' | folded=' || count(*) "
        "FROM stg.merge_group g GROUP BY 1,2 ORDER BY 1")[0] or "  (none matched)")
