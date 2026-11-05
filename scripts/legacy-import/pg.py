"""Every database call the import tooling makes goes through here.

Two rules, learned the hard way:

- `\\set VERBOSITY terse` and a scrub of DETAIL/CONTEXT lines, because Postgres quotes the offending
  value in those lines and the export is full of real email bodies. A failed COPY printed the opening
  line of a real message once. It must not be possible again.
- Callers print table names, counts, codes and ids. Never a sample row, not even while debugging.
"""
import subprocess
from typing import Iterable

_SCRUB = __import__("re").compile(r"^\s*(DETAIL|CONTEXT|HINT|QUERY):.*$", __import__("re").M)


class PsqlError(RuntimeError):
    def __init__(self, code: str, sqlstate: str, statement: str, detail: str):
        super().__init__(f"{code} sqlstate={sqlstate} statement={statement[:80]} {detail}"[:400])
        self.code, self.sqlstate = code, sqlstate


def _args(db: str, tuples: bool) -> list[str]:
    args = ["psql", "-d", db, "-X", "-q", "-v", "ON_ERROR_STOP=1"]
    return args + (["-A", "-t", "-F", "|"] if tuples else [])


def run(db: str, sql: str = None, file: str = None, tuples: bool = False,
        on_error: str = "raise") -> str:
    """Returns stdout, scrubbed of anything Postgres wanted to quote back at us."""
    args = _args(db, tuples)
    args += ["-f", file] if file else ["-c", "\\set VERBOSITY terse", "-c", sql]
    done = subprocess.run(args, capture_output=True, text=True)
    if done.returncode != 0:
        detail = _SCRUB.sub("<redacted by the importer>", done.stderr or done.stdout).strip()
        if on_error == "raise":
            raise PsqlError("psql", "unknown", sql or file or "", detail)
        return detail
    return done.stdout


def scalar(db: str, sql: str) -> str:
    return run(db, sql, tuples=True).strip().splitlines()[0].strip() if run(db, sql, tuples=True).strip() else ""


def counts(db: str, queries: Iterable[tuple[str, str]]) -> None:
    """queries: (label, sql). Prints label=value lines only."""
    for label, sql in queries:
        print(f"  {label}={scalar(db, sql)}")
