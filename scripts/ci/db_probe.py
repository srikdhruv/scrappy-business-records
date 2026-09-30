"""Tiny database probe for the install smoke tests, run with the *bundled* Python.

    python db_probe.py insert      <records.db> <name>  # add a student called <name>
    python db_probe.py check       <records.db> <name>  # exit 0 if that student exists, else 1
    python db_probe.py valid       <records.db>         # exit 0 if it's a sound copy of our DB
    python db_probe.py hot-journal <records.db>         # crash mid-save: leaves records.db-journal

Talks to SQLite directly because the smoke tests must not depend on API endpoints that other
pull requests are still building.
"""

import os
import sqlite3
import sys


def leave_hot_journal(db: str) -> int:
    """Start a big change and die before committing it, like a force-killed server or a power
    cut. SQLite leaves a "hot" journal that the next opener must roll back."""
    conn = sqlite3.connect(db, isolation_level=None)
    conn.execute("CREATE TABLE IF NOT EXISTS smoke_filler (x TEXT)")
    conn.executemany("INSERT INTO smoke_filler VALUES (?)", [("original" * 50,)] * 2000)
    conn.execute("PRAGMA cache_size=2")  # tiny cache: changes spill into the database file
    conn.execute("BEGIN")
    conn.execute("UPDATE smoke_filler SET x = 'half-saved'")
    if not os.path.exists(db + "-journal"):
        print("no journal was left behind", file=sys.stderr)
        return 1
    print(f"left a hot journal next to {db}", flush=True)
    os._exit(0)  # no rollback, no close: exactly like being killed


def main() -> int:
    # Paths may contain letters the console code page can't encode; don't crash printing them.
    sys.stdout.reconfigure(errors="backslashreplace")
    sys.stderr.reconfigure(errors="backslashreplace")
    action, db = sys.argv[1:3]
    name = sys.argv[3] if len(sys.argv) > 3 else ""
    if action == "hot-journal":
        return leave_hot_journal(db)
    conn = sqlite3.connect(db)
    try:
        if action == "valid":
            ok = conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
            half = (
                "smoke_filler" in tables
                and conn.execute(
                    "SELECT count(*) FROM smoke_filler WHERE x = 'half-saved'"
                ).fetchone()[0]
            )
            print(f"{db}: integrity {'ok' if ok else 'BAD'}, half-saved rows: {half or 0}")
            return 0 if ok and "students" in tables and not half else 1
        if action == "insert":
            with conn:
                conn.execute(
                    "INSERT INTO students (name, joined_month) VALUES (?, '2026-01-01')", (name,)
                )
            print(f"inserted {name!r} into {db}")
            return 0
        found = conn.execute("SELECT count(*) FROM students WHERE name = ?", (name,)).fetchone()[0]
        print(f"{name!r} found {found} time(s) in {db}")
        return 0 if found == 1 else 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
