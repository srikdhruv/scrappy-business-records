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
- SQL run directly (`execute`, `exec_driver_sql`, `executescript`, `executemany`, on `op`, a
  connection or raw `sqlite3`):
  - unless it is **one whole string literal** (or `text("...")` of one): SQL built from pieces,
    an f-string, a variable or `.bindparams(...)` can't be checked, so it's flagged;
  - if it contains DELETE, UPDATE, DROP, RENAME, TRUNCATE, `REPLACE INTO` or `OR REPLACE`.
    Quoted text, comments and `ON DELETE ...` / `ON UPDATE ...` clauses of a foreign key are
    ignored, so `CREATE TABLE ... ON DELETE SET NULL` passes;
  - if it creates a trigger (a trigger can change or delete rows later, on its own);
- SQLAlchemy `delete(...)` / `update(...)` statements (`sa.delete(t)`, `t.update()`), but not a
  dictionary's `.update()`;
- `batch_alter_table(copy_from=...)` or `reflect_args=...`, which decide which columns are copied;
- anything it can't follow, since it can't tell what that does: `getattr(op, ...)` and the like,
  calling an imported helper or a class, a call through a list or variable, an `op.<name>` it
  doesn't know, or an operation passed around instead of called. Write the operation out in
  `upgrade()` (or a function in the same file), or approve it.

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

on the flagged line (or the line just above it), or as a module-level comment before the first
`def` or `class` to approve the whole migration. The reason can't be empty. Standard library
only.
"""

from __future__ import annotations

import argparse
import ast
import io
import re
import sys
import tokenize
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSIONS = ROOT / "backend" / "app" / "migrations" / "versions"

MARKER = re.compile(r"#\s*data-safety:\s*approved by owner\s*[\u2014\u2013:-]+\s*\S", re.IGNORECASE)
MARKER_HINT = "# data-safety: approved by owner — <reason>"
FOLLOW_HINT = "write the operation out in upgrade(), or approve it"

SQL_RUNNERS = {"execute", "exec_driver_sql", "executescript", "executemany"}
DESTRUCTIVE_OPS = {"drop_table", "drop_column", "rename_table"}
# Methods of `op` / `batch_op` that only add, or only read (or are checked separately).
KNOWN_OPS = {
    "add_column",
    "alter_column",
    "batch_alter_table",
    "bulk_insert",
    "create_check_constraint",
    "create_exclude_constraint",
    "create_foreign_key",
    "create_index",
    "create_primary_key",
    "create_table",
    "create_table_comment",
    "create_unique_constraint",
    "drop_constraint",
    "drop_index",
    "execute",
    "f",
    "get_bind",
    "get_context",
    "inline_literal",
}
INDIRECTION = {"getattr", "setattr", "eval", "exec", "compile", "__import__", "globals", "vars"}
SAFE_BUILTINS = {
    "all", "any", "bool", "dict", "enumerate", "filter", "float", "format", "frozenset", "int",
    "isinstance", "len", "list", "map", "max", "min", "print", "range", "repr", "reversed", "set",
    "sorted", "str", "sum", "tuple", "zip",
}  # fmt: skip

_SQL_NOISE = re.compile(
    r"--[^\n]*"  # comments
    r"|/\*.*?\*/"
    r"|'(?:[^']|'')*'"  # quoted text
    r"|\"(?:[^\"]|\"\")*\""  # quoted names
    r"|`[^`]*`|\[[^\]]*\]"
    r"|\bON\s+(?:DELETE|UPDATE)\s+(?:SET\s+NULL|SET\s+DEFAULT|CASCADE|RESTRICT|NO\s+ACTION)\b",
    re.IGNORECASE | re.DOTALL,
)
_TRIGGER = re.compile(r"\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b", re.IGNORECASE)
_DESTRUCTIVE_SQL = re.compile(
    r"\b(DELETE|UPDATE|DROP|RENAME|TRUNCATE|REPLACE\s+INTO|OR\s+REPLACE)\b", re.IGNORECASE
)


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    message: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}: {self.message}"


@dataclass
class _Names:
    """What the names in a migration file are bound to."""

    op: set[str] = field(default_factory=set)  # alembic's `op`, and `batch_op`s
    sa_modules: set[str] = field(default_factory=set)  # `sa`, `sqlalchemy`, `sql`...
    sa_callables: set[str] = field(default_factory=set)  # `from sqlalchemy import text, delete`
    sa_objects: set[str] = field(default_factory=set)  # `t = sa.table(...)`
    other_imports: set[str] = field(default_factory=set)
    functions: set[str] = field(default_factory=set)  # module-level, followed
    local_functions: set[str] = field(default_factory=set)  # defined inside, walked anyway
    classes: set[str] = field(default_factory=set)


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


def _base(expr: ast.expr) -> ast.expr:
    """`a` for `a.b.c`; the innermost non-attribute expression."""
    while isinstance(expr, ast.Attribute):
        expr = expr.value
    return expr


def _keyword(call: ast.Call, name: str) -> ast.expr | None:
    return next((k.value for k in call.keywords if k.arg == name), None)


def _is_constant(node: ast.expr | None, value: object) -> bool:
    return isinstance(node, ast.Constant) and node.value is value


def _collect_names(tree: ast.Module) -> _Names:
    names = _Names()
    for node in tree.body:
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            names.functions.add(node.name)
        elif isinstance(node, ast.ClassDef):
            names.classes.add(node.name)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                bound = alias.asname or alias.name.split(".")[0]
                if alias.name.split(".")[0] == "sqlalchemy":
                    names.sa_modules.add(bound)
                else:
                    names.other_imports.add(bound)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            for alias in node.names:
                bound = alias.asname or alias.name
                if module == "__future__":
                    continue
                if module == "alembic" and alias.name == "op":
                    names.op.add(bound)
                elif module.split(".")[0] == "sqlalchemy":
                    names.sa_modules.add(bound)
                    names.sa_callables.add(bound)
                else:
                    names.other_imports.add(bound)
        elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and node not in tree.body:
            names.local_functions.add(node.name)
    for node in ast.walk(tree):
        if isinstance(node, ast.withitem) and isinstance(node.context_expr, ast.Call):
            if _name(node.context_expr.func) == "batch_alter_table" and isinstance(
                node.optional_vars, ast.Name
            ):
                names.op.add(node.optional_vars.id)
        elif isinstance(node, ast.Assign) and _is_sa(node.value, names):
            names.sa_objects.update(t.id for t in node.targets if isinstance(t, ast.Name))
    return names


def _is_sa(expr: ast.expr, names: _Names) -> bool:
    """Whether `expr` is SQLAlchemy: a module, a constructor, or an object one made."""
    if isinstance(expr, ast.Call):
        return _is_sa(expr.func, names)
    base = _base(expr)
    if isinstance(base, ast.Call):
        return _is_sa(base, names)
    return isinstance(base, ast.Name) and (
        base.id in names.sa_modules or base.id in names.sa_callables or base.id in names.sa_objects
    )


def _column_call(call: ast.Call) -> ast.Call | None:
    return next(
        (a for a in call.args if isinstance(a, ast.Call) and _name(a.func) == "Column"), None
    )


def _sql_text(call: ast.Call, names: _Names) -> str | None:
    """The SQL a runner is given, if it is one whole string literal (or `text()` of one)."""
    sql = call.args[0] if call.args else next((k.value for k in call.keywords), None)
    if isinstance(sql, ast.Constant) and isinstance(sql.value, str):
        return sql.value
    if (
        isinstance(sql, ast.Call)
        and _name(sql.func) == "text"
        and _is_sa(sql.func, names)
        and len(sql.args) == 1
        and not sql.keywords
        and isinstance(sql.args[0], ast.Constant)
        and isinstance(sql.args[0].value, str)
    ):
        return sql.args[0].value
    return None


def _sql_problem(sql: str) -> str | None:
    cleaned = _SQL_NOISE.sub(" ", sql)
    if _TRIGGER.search(cleaned):
        return "creates a trigger, which can change or delete rows later, on its own"
    match = _DESTRUCTIVE_SQL.search(cleaned)
    if match:
        return f"runs SQL with {' '.join(match.group(1).upper().split())}"
    return None


def _call_problem(call: ast.Call, names: _Names) -> str | None:
    """What's destructive, or can't be followed, about this call; None if it only adds."""
    func = call.func
    name = _name(func)

    if not isinstance(func, ast.Name | ast.Attribute):
        return f"a call through a list or an expression can't be followed; {FOLLOW_HINT}"

    # Destructive operations, on any receiver (`op`, `batch_op`, or an alias of them).
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
        sql = _sql_text(call, names)
        if sql is None:
            return (
                f"{name}(...) runs SQL that isn't one whole string literal (built from pieces, "
                "an f-string, a variable or bindparams), so it can't be checked; write it out "
                "as one string, or approve it"
            )
        problem = _sql_problem(sql)
        return f"{name}(...) {problem}" if problem else None
    if name == "batch_alter_table":
        for option in ("copy_from", "reflect_args"):
            if _keyword(call, option) is not None:
                return f"batch_alter_table({option}=...) decides which columns are copied"
        return None
    if name in ("delete", "update") and _is_sa(func, names):
        return f"a SQLAlchemy {name}(...) statement changes stored rows"

    if isinstance(func, ast.Name):
        if name in INDIRECTION:
            return f"{name}(...) hides which operation runs; {FOLLOW_HINT}"
        if name in names.functions or name in names.local_functions:
            return None  # followed, or walked where it's defined
        if name in names.sa_callables or name in SAFE_BUILTINS:
            return None
        if name in names.classes:
            return f"calls the class {name}, whose methods this check doesn't follow; {FOLLOW_HINT}"
        return f"calls {name}(), which this check can't follow; {FOLLOW_HINT}"

    base = _base(func)
    if isinstance(base, ast.Name):
        if base.id in names.op and name not in KNOWN_OPS:
            return f"{base.id}.{name}(...) isn't an operation that only adds; {FOLLOW_HINT}"
        if base.id in names.classes:
            return f"calls a method of the class {base.id}, which this check doesn't follow; " + (
                FOLLOW_HINT
            )
        if base.id in names.other_imports:
            return f"calls the imported {base.id}.{name}(...), which this check can't follow; " + (
                FOLLOW_HINT
            )
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


def _problems(function: ast.FunctionDef, names: _Names) -> list[tuple[ast.expr, str]]:
    called = {id(n.func) for n in ast.walk(function) if isinstance(n, ast.Call)}
    out: list[tuple[ast.expr, str]] = []
    for node in ast.walk(function):
        if isinstance(node, ast.Call):
            problem = _call_problem(node, names)
            if problem:
                out.append((node, problem))
        elif (
            isinstance(node, ast.Attribute)
            and id(node) not in called
            and (node.attr in DESTRUCTIVE_OPS | SQL_RUNNERS | {"alter_column"})
        ):
            out.append((node, f"{node.attr} is passed around instead of called; {FOLLOW_HINT}"))
    return out


def check_source(source: str, path: str = "<migration>") -> list[Finding]:
    tree = ast.parse(source, filename=path)
    reachable = _reachable_functions(tree)
    if not reachable:
        return []
    markers = _marker_lines(source)
    first_def = min(
        n.lineno - len(getattr(n, "decorator_list", []))
        for n in tree.body
        if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef)
    )
    if any(line < first_def for line in markers):
        return []  # a module-level comment before any code: the whole migration is approved
    names = _collect_names(tree)
    findings = set()
    for function in reachable:
        for node, problem in _problems(function, names):
            span = range(node.lineno - 1, (node.end_lineno or node.lineno) + 1)
            if markers.isdisjoint(span):
                findings.add(Finding(path, node.lineno, problem))
    return sorted(findings, key=lambda f: (f.line, f.message))


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
