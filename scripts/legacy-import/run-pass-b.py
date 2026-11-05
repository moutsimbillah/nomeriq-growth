"""Run pass B after pass A, assert every number it must produce, and abort loudly on any mismatch."""
import base64, json, os, re, subprocess, sys, urllib.parse
os.umask(0o077)
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
EXPORT = "/home/growth/import/Nomeriq-Growth-Export-20261104T201547Z-2aa5fc9e2b"
# the name is a claim; the server is the fact
_r = subprocess.run(["psql", "-d", DB, "-X", "-q", "-A", "-t", "-c", "\\set VERBOSITY terse",
                     "-c", "SELECT current_database()"], capture_output=True, text=True)
_got = (_r.stdout or "").strip().splitlines()[0].strip() if _r.stdout.strip() else "(could not connect)"
if _got != DB:
    raise SystemExit("refusing: asked for '" + DB + "' but the server says '" + _got + "'")
print("target database: " + DB)
SCRUB = re.compile(r"^\s*(DETAIL|CONTEXT|HINT|QUERY):.*$", re.M)

def psql(*calls, tuples=True):
    a = ["psql", "-d", DB, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", "\\set VERBOSITY terse"]
    a += (["-A", "-t", "-F", "|"] if tuples else [])
    for c in calls:
        a += ["-c", c]
    return subprocess.run(a, capture_output=True, text=True)

def scalar(sql):
    r = psql(sql)
    return "ERR:" + SCRUB.sub("<redacted>", r.stderr).strip()[:90] if r.returncode else \
           (r.stdout.strip().splitlines()[0].strip() if r.stdout.strip() else "")

# stage the senders index exactly as the export was staged: base64 into a file, one psql process
rows = [json.loads(l) for l in open(os.path.join(EXPORT, "sent-email-senders.jsonl"), encoding="utf-8") if l.strip()]
with open("/tmp/senders.b64", "w") as h:
    for r in rows:
        h.write(base64.b64encode(json.dumps(r, separators=(",", ":")).encode()).decode() + "\n")
staged = psql("DROP TABLE IF EXISTS stg.senders_raw; DROP TABLE IF EXISTS stg.senders;"
              " CREATE TABLE stg.senders_raw (b text); CREATE TABLE stg.senders (data jsonb);",
              "\\copy stg.senders_raw (b) FROM '/tmp/senders.b64'",
              "INSERT INTO stg.senders SELECT convert_from(decode(b, 'base64'), 'UTF8')::jsonb FROM stg.senders_raw;"
              " DROP TABLE stg.senders_raw;")
os.remove("/tmp/senders.b64")
if staged.returncode:
    print("STAGING THE SENDERS INDEX FAILED"); print(SCRUB.sub("<redacted>", staged.stderr).strip()[:300]); sys.exit(2)

done = subprocess.run(["psql", "-d", DB, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", "\\set VERBOSITY terse",
                       "-f", sys.argv[1]], capture_output=True, text=True)
if done.returncode:
    print("PASS B FAILED"); print(SCRUB.sub("<redacted>", done.stderr or done.stdout).strip()[:700]); sys.exit(1)

CHECKS = [
 ("old ids mapped",              "SELECT count(*) FROM stg.old_to_new", 584),
 ("  old ids left unresolved",   "SELECT count(*) FROM stg.old_to_lead m LEFT JOIN stg.old_to_new x ON x.old_prospect_id = m.old_prospect_id WHERE x.prospect_id IS NULL", 0),
 ("  imported rows without a lead", "SELECT count(*) FROM messages WHERE source='legacy_import' AND prospect_id IS NULL", 0),
 ("  step-2 draft has no SENT dispatch", "SELECT count(*) FROM stg.rows dd JOIN stg.rows ap ON ap.source_table='marketing_outreach_draft_approvals' AND ap.data->>'draft_id' = dd.data->>'id' JOIN stg.rows dz ON dz.source_table='marketing_email_dispatches' AND dz.data->>'approval_id' = ap.data->>'id' AND dz.data->>'state'='SENT' WHERE dd.source_table='marketing_outreach_drafts' AND dd.data->>'step'='2'", 0),
 ("senders index staged",        "SELECT count(*) FROM stg.senders", 433),
 ("accepted from the index",      "SELECT count(*) FROM messages WHERE matched_by = 'legacy_senders_index'", None),
 ("  known unresolved (archive)", "SELECT 433 - count(*) FROM messages WHERE matched_by = 'legacy_senders_index'", None),
 ("  accepted without a lead",    "SELECT count(*) FROM messages WHERE matched_by = 'legacy_senders_index' AND prospect_id IS NULL", 0),
 ("  accepted without a sent time","SELECT count(*) FROM messages WHERE matched_by = 'legacy_senders_index' AND sent_at IS NULL", 0),
 ("  accepted not on moutsim",    "SELECT count(*) FROM messages m JOIN email_accounts a ON a.id = m.account_id WHERE m.matched_by = 'legacy_senders_index' AND a.normalized_email <> 'moutsim@nomeriq.com'", 0),
("contacts from history",        "SELECT count(*) FROM prospects p WHERE EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'outbound' AND m.delivery_status IN ('accepted','uncertain'))", None),
 ("  none left below contacted",  "SELECT count(*) FROM prospects p WHERE EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'outbound' AND m.delivery_status IN ('accepted','uncertain')) AND p.status NOT IN ('contacted','replied','interested','demo','proposal','won','lost')", 0),
 ("  none left unpinned",         "SELECT count(*) FROM prospects p WHERE EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'outbound' AND m.delivery_status IN ('accepted','uncertain')) AND p.sending_profile_id IS NULL", 0),
 ("lost dispositions",             "SELECT count(*) FROM prospects WHERE metadata->'legacy'->>'disposition' = 'LOST'", None),
 ("NOT_INTERESTED leads",        "SELECT count(*) FROM stg.rows r JOIN stg.old_to_new om ON om.old_prospect_id = r.data->>'prospect_id' WHERE r.source_table = 'marketing_outreach_replies' AND r.data->>'classification' = 'NOT_INTERESTED'", 4),
 ("  overlap with LOST",         "SELECT count(*) FROM prospects p WHERE p.metadata->'legacy'->>'disposition' = 'LOST' AND p.id IN (SELECT om.prospect_id FROM stg.rows r JOIN stg.old_to_new om ON om.old_prospect_id = r.data->>'prospect_id' WHERE r.source_table = 'marketing_outreach_replies' AND r.data->>'classification' = 'NOT_INTERESTED')", None),
 ("leads lost",                  "SELECT count(*) FROM prospects WHERE status = 'lost'", None),
 ("  dispositions + replies less overlap", "SELECT (SELECT count(*) FROM prospects WHERE metadata->'legacy'->>'disposition' = 'LOST') + 4 - (SELECT count(*) FROM prospects p WHERE p.metadata->'legacy'->>'disposition' = 'LOST' AND p.id IN (SELECT om.prospect_id FROM stg.rows r JOIN stg.old_to_new om ON om.old_prospect_id = r.data->>'prospect_id' WHERE r.source_table = 'marketing_outreach_replies' AND r.data->>'classification' = 'NOT_INTERESTED'))", None),
 ("conversations",                "SELECT count(*) FROM conversations", None),
 ("  with a last outbound time",  "SELECT count(*) FROM conversations WHERE last_outbound_at IS NOT NULL", None),
 ("  with a last inbound time",   "SELECT count(*) FROM conversations WHERE last_inbound_at IS NOT NULL", 13),
 ("  inbound on distinct leads",  "SELECT count(DISTINCT prospect_id) FROM messages WHERE direction='inbound' AND source='legacy_import'", 13),
 ("drafts sent first_contact",    "SELECT count(*) FROM drafts WHERE kind='first_contact' AND status='sent'", None),
 ("  distinct leads with one",    "SELECT count(DISTINCT prospect_id) FROM drafts WHERE kind='first_contact' AND status='sent'", None),
 ("drafts follow_up",             "SELECT count(*) FROM drafts WHERE kind='follow_up'", 1),
 ("drafts unsent heads",          "SELECT count(*) FROM drafts WHERE status='draft' AND created_by_type='legacy'", None),
 ("  duplicate first contacts",   "SELECT count(*) FROM (SELECT prospect_id FROM drafts WHERE kind='first_contact' AND status='sent' GROUP BY 1 HAVING count(*) > 1) x", 0),
 ("P4 Provider sent drafts",      "SELECT count(*) FROM drafts d JOIN prospects p ON p.id=d.prospect_id WHERE p.business_name ILIKE 'P4%' AND d.status='sent'", 1),
 ("  and no leftover new draft",  "SELECT count(*) FROM drafts d JOIN prospects p ON p.id=d.prospect_id WHERE p.business_name ILIKE 'P4%' AND d.status='draft' AND d.created_by_type <> 'legacy'", 0),
 ("Tawsiyat sent drafts",         "SELECT count(*) FROM drafts d JOIN prospects p ON p.id=d.prospect_id WHERE p.business_name ILIKE 'Tawsiyat%' AND d.status='sent'", 1),
 ("NEEDS_MATCHING kept in archive only", "SELECT count(*) FROM stg.rows WHERE source_table='marketing_conversation_links' AND data->>'state'='NEEDS_MATCHING'", 8),
 ("  none imported as a reply",   "SELECT count(*) FROM messages m JOIN stg.rows lk ON lk.source_table='marketing_conversation_links' AND lk.data->>'state'='NEEDS_MATCHING' AND lk.data->>'mailbox_id' = m.message_id WHERE m.source='legacy_import' AND m.direction='inbound'", 0),
]
failures = []
print("CHECK  expected  actual  result")
for label, sql, expected in CHECKS:
    actual = scalar(sql)
    if expected is None:
        print(f"  {label}: {actual}")
        continue
    ok = actual == str(expected)
    if not ok:
        failures.append(f"{label}: expected {expected}, got {actual}")
    print(f"  {label}: expected {expected}, got {actual} -> {'ok' if ok else 'FAIL'}")

print("\nknown item: 8 NEEDS_MATCHING inbound messages sit in the archive and were not imported as replies;")
print("the new portal's mailbox sync will match them once moutsim@nomeriq.com is connected.")
if failures:
    print("\nCHECKS FAILED — pass B is not accepted:")
    for f in failures:
        print("  " + f)
    sys.exit(3)
print("\nPASS B RAN, and every check holds")
