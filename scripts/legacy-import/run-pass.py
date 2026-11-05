"""Run pass A, check it against the numbers it must produce, and abort loudly if any is wrong.

A silent no-op is the failure mode this guards against: the merge block once ran as nothing at all
because its staging table was empty, and the only sign was a count nobody was checking.
"""
import base64, json, os, re, subprocess, sys, urllib.parse
os.umask(0o077)
for line in open("/home/growth/.growth.env"):
    if line.startswith("DATABASE_URL="):
        u = urllib.parse.urlparse(line.split("=", 1)[1].strip().strip('"').strip("'"))
        os.environ.update(PGHOST=u.hostname or "127.0.0.1", PGPORT=str(u.port or 5432),
                          PGUSER=u.username or "", PGPASSWORD=urllib.parse.unquote(u.password or ""))
DB, EXPORT = "growth_import_dryrun", "/home/growth/import/Nomeriq-Growth-Export-20261104T201547Z-2aa5fc9e2b"
SCRUB = re.compile(r"^\s*(DETAIL|CONTEXT|HINT|QUERY):.*$", re.M)

def psql(*calls, tuples=True):
    a = ["psql", "-d", DB, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", "\\set VERBOSITY terse"]
    a += (["-A", "-t", "-F", "|"] if tuples else [])
    for call in calls:
        a += ["-c", call]
    return subprocess.run(a, capture_output=True, text=True)

def scalar(sql):
    r = psql(sql)
    if r.returncode:
        return "ERR:" + SCRUB.sub("<redacted>", r.stderr).strip()[:90]
    return r.stdout.strip().splitlines()[0].strip() if r.stdout.strip() else ""

# ---- stage the decisions file exactly the way the loader stages the export: base64, one psql process
decisions = open(os.path.join(EXPORT, "import-decisions.json"), encoding="utf-8").read()
path = "/tmp/dec.b64"
with open(path, "w") as handle:
    handle.write(base64.b64encode(json.dumps(json.loads(decisions)).encode("utf-8")).decode("ascii"))
staged = psql("DROP TABLE IF EXISTS stg.decisions; DROP TABLE IF EXISTS stg.decisions_raw; "
              "CREATE TABLE stg.decisions (data jsonb); CREATE TABLE stg.decisions_raw (b text);",
              "\\copy stg.decisions_raw (b) FROM '/tmp/dec.b64'",
              "INSERT INTO stg.decisions SELECT convert_from(decode(b, 'base64'), 'UTF8')::jsonb "
              "FROM stg.decisions_raw; DROP TABLE stg.decisions_raw;")
os.remove(path)
if staged.returncode:
    print("STAGING FAILED (loud, on purpose)")
    print(SCRUB.sub("<redacted>", staged.stderr).strip()[:300])
    sys.exit(2)

done = psql(open(sys.argv[1], encoding="utf-8").read(), tuples=False) if False else \
       subprocess.run(["psql", "-d", DB, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", "\\set VERBOSITY terse",
                       "-f", sys.argv[1]], capture_output=True, text=True)
if done.returncode:
    print("PASS A FAILED")
    print(SCRUB.sub("<redacted>", done.stderr or done.stdout).strip()[:700])
    sys.exit(1)

# ---- the opt-out the decisions file requires before any outreach
opt_out = json.loads(decisions).get("new_portal_suppression_required_before_any_outreach")
for address in sorted(set(re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", json.dumps(opt_out)))):
    lit = "'" + address.replace("'", "''") + "'"
    psql("INSERT INTO suppressions (id, normalized_email, email, reason, source, note, active) "
         "SELECT gen_random_uuid(), lower(%s), lower(%s), 'opt_out', 'legacy_import', "
         "'requested before any outreach; unapplied in the old portal', true "
         "WHERE NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.normalized_email = lower(%s))"
         % (lit, lit, lit),
         "UPDATE prospects p SET do_not_contact = true, updated_at = now() WHERE EXISTS "
         "(SELECT 1 FROM prospect_emails e WHERE e.prospect_id = p.id AND e.normalized_email = lower(%s))" % lit)

# ---- what it must have produced. Any failure here aborts before anything is committed.
CHECKS = [
  ("decisions staged",         "SELECT count(*) FROM stg.decisions", 1),
  ("merge groups resolved",    "SELECT count(*) FROM (SELECT DISTINCT kept_old_id FROM stg.merged_away) x", 6),
  ("  records merged away",    "SELECT count(*) FROM stg.merged_away", 6),
  ("  groups with no kept row","SELECT count(*) FROM stg.merge_group WHERE kept_old_id IS NULL", 0),
  ("suppressions bounce",      "SELECT count(*) FROM suppressions WHERE reason = 'bounce'", 57),
  ("suppressions opt_out",     "SELECT count(*) FROM suppressions WHERE reason = 'opt_out'", 1),
  ("existing leads folded",    "SELECT count(*) FROM prospects WHERE created_by_type <> 'legacy'", 4),
  ("  and all four carry the fold", "SELECT count(*) FROM prospects WHERE created_by_type <> 'legacy' "
                                    "AND metadata->'legacy'->>'prospect_id' IS NOT NULL", 4),
  ("leads",                    "SELECT count(*) FROM prospects", 578),
  ("collisions on a merge business", "SELECT count(*) FROM stg.demoted d WHERE d.old_prospect_id IN "
                                     "(SELECT kept_old_id FROM stg.merge_group UNION SELECT folded_old_id FROM stg.merge_group)", 0),
  ("collisions with an existing lead of a merge business",
   "SELECT count(*) FROM stg.demoted d JOIN prospects p ON p.domain_key = d.key "
   "WHERE p.business_name IN (SELECT business FROM stg.merge_group)", 0),
]
failures = []
print("CHECK  expected  actual  result")
for label, sql, expected in CHECKS:
    actual = scalar(sql)
    ok = actual == str(expected)
    if not ok:
        failures.append(f"{label}: expected {expected}, got {actual}")
    print(f"  {label}: expected {expected}, got {actual} -> {'ok' if ok else 'FAIL'}")

if failures:
    print("\nCHECKS FAILED — pass A did not produce what it must, so it is not accepted:")
    for line in failures:
        print("  " + line)
    sys.exit(3)

print("\nPASS A RAN, and every check holds")
for label, sql in [
  ("suppressions bounce",     "SELECT count(*) FROM suppressions WHERE reason = 'bounce'"),
  ("suppressions opt_out",    "SELECT count(*) FROM suppressions WHERE reason = 'opt_out'"),
  ("leads",                   "SELECT count(*) FROM prospects"),
  ("  legacy",                "SELECT count(*) FROM prospects WHERE created_by_type = 'legacy'"),
  ("  existing 4 kept",       "SELECT count(*) FROM prospects WHERE created_by_type <> 'legacy'"),
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
    print(f"  {label}: {scalar(sql)}")
print("\nmerge groups (named, they are the approved merge decisions):")
print(scalar("SELECT string_agg(g.business || ' ' || g.kept_old_id || ' <- ' || g.folded_old_id, ' | ') FROM stg.merge_group g") or "  (none)")
print("\ncollisions by rule, named only where a merge group or an existing lead is involved:")
print(scalar("SELECT coalesce(string_agg(DISTINCT d.rule || ' ' || d.authority, ', '), '(none)') FROM stg.demoted d") or "  (none)")
