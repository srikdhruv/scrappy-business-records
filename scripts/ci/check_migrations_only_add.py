"""Fail if a database migration could lose or rewrite the owner's data (ADR 0004).

    python3 scripts/ci/check_migrations_only_add.py            # every migration
    python3 scripts/ci/check_migrations_only_add.py path/to/0003_x.py ...

Migrations may only **add**: new tables, new columns (nullable, or with a default), indexes and
constraints. It reads each `backend/app/migrations/versions/*.py` and, in `upgrade()` (and any
function of the same file it calls), flags:

- `drop_table`, `drop_column`;
- renaming a table or a column (`rename_table`, `alter_column(new_column_name=...)`);
- `alter_column` changing a column's type (`type_=`) or making it required (`nullable=False`);
- `add_column` of a required column with no `server_default` (existing rows would have no value);
- SQL run directly (`op.execute`, `.execute`, `.exec_driver_sql`) that contains DELETE, UPDATE,
  DROP, RENAME, REPLACE or TRUNCATE, or whose text can't be read from the source;
- SQLAlchemy `delete(...)` / `update(...)` statements;
- `batch_alter_table(copy_from=...)` or `reflect_args=...`, which decide which columns are copied.

`downgrade()` isn't checked: the app never runs it on the owner's laptop.

**Batch mode is allowed.** SQLite can't alter most things in place, so Alembic's
`batch_alter_table` makes a new table, copies every row into it (`INSERT INTO ... SELECT`), drops
the old one and renames the new one. That drop and rename are Alembic's own steps, never written
in the migration, so they aren't flagged: a batch that only adds (as `0002_fee_change_kind`
does) keeps every row. What happens inside the batch (`batch_op.drop_column(...)` and so on) is
checked like anything else. The copy runs with foreign keys off and is rolled back if
`PRAGMA foreign_key_check` finds a broken link (`migrations/env.py`), and the release-fixture
test (`backend/tests/test_release_upgrades.py`) proves a table copy keeps every release's data.

**An exception** needs the owner's explicit approval, a backup and a tested data-preserving
migration (ADR 0004). Mark it with a comment:

    # data-safety: approved by owner — <why, and when the owner approved it>

on the flagged line (or the line just above it), or anywhere above `def upgrade()` to approve the
whole migration. The reason can't be empty. Standard library only.
"""

from __future__ import annotations

import argparse
import ast
import io
import re
import sys
import tokenize
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSIONS = ROOT / "backend" / "app" / "migrations" / "versions"

MARKER = re.compile(r"#\s*data-safety:\s*approved by owner\s*[\u2014\u2013:-]+\s*\S", re.IGNORECASE)
MARKER_HINT = "# data-safety: approved by owner — <reason>"
DESTRUCTIVE_SQL = re.compile(r"\b(DELETE|UPDATE|DROP|RENAME|REPLACE|TRUNCATE)\b", re.IGNORECASE)
SQL_RUNNERS = {"execute", "exec_driver_sql"}


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    message: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}: {self.message}"


def _marker_lines(source: str) -> set[int]:
    """Lines with an approval comment (comments only: the words in a string don't count)."""
    lines = set()
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type == tokenize.COMMENT and MARKER.search(token.string):
            lines.add(token.start[0])
    return lines


def _name(func: ast.expr) -> str | None:
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Name):
        return func.id
    return None


def _keyword(call: ast.Call, name: str) -> ast.expr | None:
    return next((k.value for k in call.keywords if k.arg == name), None)


def _is_constant(node: ast.expr | None, value: object) -> bool:
    return isinstance(node, ast.Constant) and node.value is value


def _strings(call: ast.Call) -> list[str]:
    """Every piece of literal text in the call's arguments (including f-strings' fixed parts)."""
    out = []
    for arg in [*call.args, *(k.value for k in call.keywords)]:
        for node in ast.walk(arg):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                out.append(node.value)
    return out


def _column_call(call: ast.Call) -> ast.Call | None:
    return next(
        (a for a in call.args if isinstance(a, ast.Call) and _name(a.func) == "Column"), None
    )


def _problem(call: ast.Call) -> str | None:
    """What's destructive about this call, or None if it only adds."""
    name = _name(call.func)
    if name in ("drop_table", "drop_column"):
        return f"{name} removes the owner's data"
    if name == "rename_table":
        return "renaming a table that holds the owner's data"
    if name == "alter_column":
        if _keyword(call, "new_column_name") is not None:
            return "renaming a column that holds the owner's data"
        if _keyword(call, "type_") is not None:
            return "alter_column changes a column's type, which can rewrite stored values"
        nullable = _keyword(call, "nullable")
        if nullable is not None and not _is_constant(nullable, True):
            return "alter_column makes a column required, which fails or rewrites old rows"
        return None
    if name == "add_column":
        column = _column_call(call)
        if column is not None:
            nullable = _keyword(column, "nullable")
            required = nullable is not None and not _is_constant(nullable, True)
            if required and _keyword(column, "server_default") is None:
                return "add_column of a required column with no server_default"
        return None
    if name in SQL_RUNNERS:
        texts = _strings(call)
        if not texts:
            return f"{name}(...) runs SQL whose text can't be checked here"
        match = next((m for t in texts if (m := DESTRUCTIVE_SQL.search(t))), None)
        if match:
            return f"{name}(...) runs SQL with {match.group(1).upper()}"
        return None
    if name in ("delete", "update"):
        return f"a {name}(...) statement changes stored rows"
    if name == "batch_alter_table":
        for option in ("copy_from", "reflect_args"):
            if _keyword(call, option) is not None:
                return f"batch_alter_table({option}=...) decides which columns are copied"
    return None


def _reachable_functions(tree: ast.Module) -> list[ast.FunctionDef]:
    """`upgrade()` and every function of this file that it calls, directly or not."""
    functions = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
    if "upgrade" not in functions:
        return []
    seen: dict[str, ast.FunctionDef] = {}
    todo = ["upgrade"]
    while todo:
        name = todo.pop()
        if name in seen:
            continue
        seen[name] = functions[name]
        for node in ast.walk(functions[name]):
            called = (
                node.func.id
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                else None
            )
            if called in functions and called not in seen:
                todo.append(called)
    return list(seen.values())


def check_source(source: str, path: str = "<migration>") -> list[Finding]:
    tree = ast.parse(source, filename=path)
    reachable = _reachable_functions(tree)
    if not reachable:
        return []
    markers = _marker_lines(source)
    upgrade_line = reachable[0].lineno
    if any(line < upgrade_line for line in markers):
        return []  # the whole migration is approved
    findings = []
    for function in reachable:
        for node in ast.walk(function):
            if not isinstance(node, ast.Call):
                continue
            problem = _problem(node)
            if problem is None:
                continue
            span = range(node.lineno - 1, (node.end_lineno or node.lineno) + 1)
            if markers.isdisjoint(span):
                findings.append(Finding(path, node.lineno, problem))
    return sorted(findings, key=lambda f: f.line)


def check_file(path: Path) -> list[Finding]:
    shown = path.relative_to(ROOT) if path.is_relative_to(ROOT) else path
    return check_source(path.read_text(encoding="utf-8"), str(shown))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("paths", nargs="*", type=Path, help="default: every migration")
    args = parser.parse_args(argv)
    paths = args.paths or sorted(VERSIONS.glob("*.py"))
    if not paths:
        print(f"No migrations found in {VERSIONS}", file=sys.stderr)
        return 1
    findings = [f for p in paths for f in check_file(p.resolve())]
    for finding in findings:
        print(f"::error file={finding.path},line={finding.line}::{finding.message}")
        print(f"  {finding}")
    if findings:
        print(
            f"\n{len(findings)} change(s) could lose or rewrite the owner's data. Migrations may "
            "only add (docs/adr/0004-data-is-never-lost.md). If the owner has explicitly "
            f'approved it, and it is backed up and tested, mark the line with "{MARKER_HINT}".',
            file=sys.stderr,
        )
        return 1
    print(f"OK: {len(paths)} migration(s) only add.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
