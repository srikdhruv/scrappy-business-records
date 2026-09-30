"""Tiny database probe for the install smoke tests, run with the *bundled* Python.

    python db_probe.py insert <records.db> <name>   # add a student called <name>
    python db_probe.py check  <records.db> <name>   # exit 0 if that student exists, else 1
    python db_probe.py valid  <records.db>          # exit 0 if it's a sound copy of our database

Talks to SQLite directly because the smoke tests must not depend on API endpoints that other
pull requests are still building.
"""

import sqlite3
import sys


def main() -> int:
    action, db = sys.argv[1:3]
    name = sys.argv[3] if len(sys.argv) > 3 else ""
    conn = sqlite3.connect(db)
    try:
        if action == "valid":
            ok = conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
            print(f"{db}: integrity {'ok' if ok else 'BAD'}, tables: {sorted(tables)}")
            return 0 if ok and "students" in tables else 1
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
