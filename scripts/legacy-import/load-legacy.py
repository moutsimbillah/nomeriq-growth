"""Load the old portal's export into the dry-run copy: staging rows, then the legacy archive.

Stage 1 of the import. Reads JSONL, writes staging tables, then loads all 47 exported tables into
`legacy.*` with an id that is the row's own or one derived from the exporter's key columns (the same
algorithm as src/lib/import/rowId.ts). Prints counts only — never a record value.

  python3 load-legacy.py <export_dir> <target_db>
"""
import base64
import hashlib
import json
import os
import subprocess
import sys
import urllib.parse

os.umask(0o077)
EXPORT = sys.argv[1]
TARGET = sys.argv[2]

for line in open("/home/growth/.growth.env"):
    if line.startswith("DATABASE_URL="):
        url = urllib.parse.urlparse(line.split("=", 1)[1].strip().strip('"').strip("'"))
        os.environ["PGHOST"] = url.hostname or "127.0.0.1"
        os.environ["PGPORT"] = str(url.port or 5432)
        os.environ["PGUSER"] = url.username or ""
        os.environ["PGPASSWORD"] = urllib.parse.unquote(url.password or "")


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pg import PsqlError, run as _run  # noqa: E402


def psql(sql=None, file=None, tuples=False):
    """Terse, scrubbed. On failure only the statement and its SQLSTATE are named."""
    try:
        return _run(TARGET, sql=sql, file=file, tuples=tuples)
    except PsqlError as error:
        raise SystemExit(f"stopped: {error.sqlstate} on {str(sql or file).splitlines()[0][:70]}")



def canonical(value):
    """Must match canonical() in rowId.ts: sorted object keys, no spaces, raw unicode."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, sort_keys=True)


def row_id(table, row, order_by):
    own = row.get("id")
    if isinstance(own, str) and own.strip():
        return own.strip()
    values = []
    for column in order_by:
        value = row.get(column)
        if value is None:
            raise SystemExit(f"{table}: key column {column} is null")
        values.append(value)
    payload = f"legacy:{table}:{canonical(values)}"
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


manifest = json.load(open(os.path.join(EXPORT, "manifest.json"), encoding="utf-8"))
tables = manifest["tables"]
print(f"manifest: status={manifest['status']} tables={len(tables)}")

print("=== staging schema ===")
psql("CREATE SCHEMA IF NOT EXISTS stg;")
psql("""DROP TABLE IF EXISTS stg.rows; DROP TABLE IF EXISTS stg.raw_b64; DROP TABLE IF EXISTS stg.files;
        CREATE TABLE stg.rows (source_table text NOT NULL, ordinal int NOT NULL, row_id text NOT NULL,
                               data jsonb NOT NULL);
        CREATE TABLE stg.raw_b64 (source_table text NOT NULL, ordinal int NOT NULL, row_id text NOT NULL,
                                  data_b64 text NOT NULL);
        CREATE TABLE stg.files (file text PRIMARY KEY, source_table text, sha256 text NOT NULL,
                                rows int NOT NULL, bytes int NOT NULL);""")

# ---- stream every exported table into staging, computing the archive id as we go
rows_path = "/tmp/stg-rows.tsv"
counts = {}
with open(rows_path, "w", encoding="utf-8") as out:
    for table in tables:
        path = os.path.join(EXPORT, table["file"])
        order_by = table.get("order_by") or ["id"]
        ordinal = 0
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                ordinal += 1
                row = json.loads(line)
                out.write(
                    "\t".join(
                        [
                            table["table"],
                            str(ordinal),
                            row_id(table["table"], row, order_by),
                            base64.b64encode(canonical(row).encode("utf-8")).decode("ascii"),
                        ]
                    )
                    + "\n"
                )
        counts[table["table"]] = ordinal
psql(f"""\\copy stg.raw_b64 (source_table, ordinal, row_id, data_b64) FROM '{rows_path}'""")
psql("""INSERT INTO stg.rows (source_table, ordinal, row_id, data)
        SELECT source_table, ordinal, row_id, convert_from(decode(data_b64, 'base64'), 'UTF8')::jsonb
          FROM stg.raw_b64""")
psql("DROP TABLE stg.raw_b64")
print(f"staged rows: {sum(counts.values())} across {len(counts)} tables")

files_path = "/tmp/stg-files.tsv"
with open(files_path, "w", encoding="utf-8") as out:
    for table in tables:
        out.write("\t".join([table["file"], table["table"], table["sha256"],
                             str(table["rows"]), str(table["bytes"])]) + "\n")
psql(f"""\\copy stg.files (file, source_table, sha256, rows, bytes) FROM '{files_path}'""")
os.remove(rows_path)
os.remove(files_path)

# ---- the archive: every exported table, unchanged, under its archive id
print("=== archive ===")
loaded = 0
for table in tables:
    name = table["table"]
    psql(f"""INSERT INTO legacy.{name} (id, data)
             SELECT row_id, data FROM stg.rows WHERE source_table = '{name}'
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data""")
    got = psql(f"SELECT count(*) FROM legacy.{name}", tuples=True).strip()
    flag = "ok " if got == str(table["rows"]) else "MISMATCH"
    if got != str(table["rows"]):
        print(f"  {flag} {name}: {got} != {table['rows']}")
    loaded += int(got)
psql("""INSERT INTO legacy.import_files (file, source_table, sha256, rows, bytes)
        SELECT file, source_table, sha256, rows, bytes FROM stg.files
        ON CONFLICT (file) DO UPDATE SET sha256 = EXCLUDED.sha256, rows = EXCLUDED.rows,
                                         bytes = EXCLUDED.bytes""")
print(f"archive rows loaded: {loaded}")
print("import_files:", psql("SELECT count(*) FROM legacy.import_files", tuples=True).strip())
