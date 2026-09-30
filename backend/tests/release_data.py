"""What a released database holds, as plain data: shared by the release-fixture script and the
upgrade test (`test_release_upgrades.py`).

A fixture's manifest (`fixtures/releases/vX.Y.Z.json`) records, for every table the owner's
data lives in, the row count and every row's stored values, sorted by id. After an upgrade, the
same columns must hold exactly the same values: nothing lost, nothing rewritten.

Only the timestamps the database sets itself (`created_at`, `updated_at`) are left out: they
aren't something the owner typed. Everything else is compared, ids and links between rows too.

Standard library only: `scripts/make_release_fixture.py` loads this file with any Python 3.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any

MANIFEST_FORMAT = 1
NOT_USER_DATA = frozenset({"created_at", "updated_at"})
"""Columns the database fills in itself. Every other column is compared."""
_INTERNAL_TABLES = ("alembic_version",)


def _connect_read_only(db: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True)


def user_tables(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' "
        "ORDER BY name"
    ).fetchall()
    return [r[0] for r in rows if r[0] not in _INTERNAL_TABLES]


def user_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    columns = [r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')]
    return [c for c in columns if c not in NOT_USER_DATA]


def table_rows(conn: sqlite3.Connection, table: str, columns: list[str]) -> list[list[Any]]:
    """Every row's values for `columns`, sorted (by id when there is one)."""
    select = ", ".join(f'"{c}"' for c in columns)
    rows = [list(r) for r in conn.execute(f'SELECT {select} FROM "{table}"')]
    key = columns.index("id") if "id" in columns else None
    if key is not None:
        rows.sort(key=lambda r: r[key])
    else:
        rows.sort(key=lambda r: json.dumps(r, ensure_ascii=False))
    return rows


def rows_hash(rows: list[list[Any]]) -> str:
    canonical = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def revision(db: Path) -> str | None:
    conn = _connect_read_only(db)
    try:
        row = conn.execute("SELECT version_num FROM alembic_version").fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def dump(db: Path) -> dict[str, dict[str, Any]]:
    """`{table: {count, columns, sha256, rows}}` for every table holding the owner's data."""
    conn = _connect_read_only(db)
    try:
        result: dict[str, dict[str, Any]] = {}
        for table in user_tables(conn):
            columns = user_columns(conn, table)
            rows = table_rows(conn, table, columns)
            result[table] = {
                "count": len(rows),
                "columns": columns,
                "sha256": rows_hash(rows),
                "rows": rows,
            }
        return result
    finally:
        conn.close()


def dump_like(db: Path, expected: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """`dump(db)`, restricted to the tables and columns in `expected` (a manifest's `tables`).

    Tables and columns added by later migrations are ignored; a missing one raises, which the
    test reports as data lost.
    """
    conn = _connect_read_only(db)
    try:
        result: dict[str, dict[str, Any]] = {}
        for table, spec in expected.items():
            columns = list(spec["columns"])
            rows = table_rows(conn, table, columns)
            result[table] = {
                "count": len(rows),
                "columns": columns,
                "sha256": rows_hash(rows),
                "rows": rows,
            }
        return result
    finally:
        conn.close()


def manifest(db: Path, tag: str, today: str) -> dict[str, Any]:
    return {
        "format": MANIFEST_FORMAT,
        "tag": tag,
        "revision": revision(db),
        "today": today,
        "note": (
            "Made by scripts/make_release_fixture.py from the released code. Fictional data. "
            "Never edit by hand: regenerate it instead."
        ),
        "tables": dump(db),
    }


def write_manifest(path: Path, data: dict[str, Any]) -> None:
    """Pretty JSON, with each row on one line so a diff shows which row changed."""
    rows_marker = "@@row:{}:{}@@"
    tables = {
        table: {**spec, "rows": [rows_marker.format(table, i) for i in range(len(spec["rows"]))]}
        for table, spec in data["tables"].items()
    }
    text = json.dumps({**data, "tables": tables}, ensure_ascii=False, indent=1)
    for table, spec in data["tables"].items():
        for i, row in enumerate(spec["rows"]):
            placeholder = json.dumps(rows_marker.format(table, i))
            text = text.replace(placeholder, json.dumps(row, ensure_ascii=False), 1)
    path.write_text(text + "\n", encoding="utf-8")


def read_manifest(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))
