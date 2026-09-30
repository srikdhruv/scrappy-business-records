"""The CI check that migrations only add (scripts/ci/check_migrations_only_add.py, ADR 0004)."""

from __future__ import annotations

import importlib.util
import sys
import textwrap
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "ci" / "check_migrations_only_add.py"
_spec = importlib.util.spec_from_file_location("check_migrations_only_add", SCRIPT)
assert _spec and _spec.loader
scanner = sys.modules[_spec.name] = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scanner)

HEADER = '''"""A migration."""

import sqlalchemy as sa
from alembic import op

revision = "0099"
down_revision = "0002"
'''


def migration(upgrade: str, downgrade: str = "pass", header: str = HEADER) -> str:
    return (
        header
        + "\n\ndef upgrade() -> None:\n"
        + textwrap.indent(textwrap.dedent(upgrade).strip(), "    ")
        + "\n\n\ndef downgrade() -> None:\n"
        + textwrap.indent(textwrap.dedent(downgrade).strip(), "    ")
        + "\n"
    )


def problems(source: str) -> list[str]:
    return [f.message for f in scanner.check_source(source)]


# --------------------------------------------------------------------------- flagged

# name: (upgrade body, extra module code after downgrade, a fragment of the expected message)
FLAGGED: dict[str, tuple[str, str, str]] = {
    "drop table": ('op.drop_table("payments")', "", "drop_table removes"),
    "drop column": ('op.drop_column("students", "phone")', "", "drop_column removes"),
    "drop column in a batch": (
        """
        with op.batch_alter_table("payments") as batch_op:
            batch_op.drop_column("note")
        """,
        "",
        "drop_column removes",
    ),
    "rename table": ('op.rename_table("students", "pupils")', "", "renaming a table"),
    "rename column": (
        """
        with op.batch_alter_table("students") as batch_op:
            batch_op.alter_column("phone", new_column_name="mobile")
        """,
        "",
        "renaming a column",
    ),
    "change a type": (
        """
        with op.batch_alter_table("payments") as batch_op:
            batch_op.alter_column("amount_paise", type_=sa.Numeric(10, 2))
        """,
        "",
        "changes a column's type",
    ),
    "make a column required": (
        'op.alter_column("students", "phone", existing_type=sa.String(), nullable=False)',
        "",
        "makes a column required",
    ),
    "required column with no default": (
        'op.add_column("students", sa.Column("roll_no", sa.Integer(), nullable=False))',
        "",
        "no server_default",
    ),
    "delete in SQL": ('op.execute("DELETE FROM payments WHERE amount_paise < 100")', "", "DELETE"),
    "update in SQL": ('op.execute(sa.text("update students set phone = NULL"))', "", "UPDATE"),
    "drop in raw SQL": ('op.get_bind().exec_driver_sql("DROP TABLE fee_changes")', "", "DROP"),
    "rename in SQL": (
        'op.execute("ALTER TABLE students RENAME COLUMN notes TO remarks")',
        "",
        "RENAME",
    ),
    "replace into": (
        "op.execute(\"REPLACE INTO students (id, name) VALUES (1, 'x')\")",
        "",
        "REPLACE",
    ),
    "insert or replace": (
        'op.execute("INSERT OR REPLACE INTO students (id) VALUES (1)")',
        "",
        "OR REPLACE",
    ),
    "an upsert that updates": (
        'op.execute("INSERT INTO a (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET n = 2")',
        "",
        "UPDATE",
    ),
    "DELETE hidden after a comment line": (
        'op.execute("-- tidy up\\nDELETE FROM a")',
        "",
        "DELETE",
    ),
    "a trigger": (
        'op.execute("CREATE TRIGGER t AFTER INSERT ON payments BEGIN SELECT 1; END")',
        "",
        "trigger",
    ),
    "executescript on raw sqlite3": (
        'sqlite3.connect("records.db").executescript("DELETE FROM payments")',
        "import sqlite3",
        "executescript(...) runs SQL with DELETE",
    ),
    "executemany": (
        'op.get_bind().connection.executemany("UPDATE students SET name = ?", rows)',
        "",
        "executemany(...) runs SQL with UPDATE",
    ),
    "SQL from an f-string": (
        'op.execute(f"INSERT INTO {table} VALUES (1)")',
        "",
        "one whole string",
    ),
    "SQL from + pieces": ('op.execute("INSERT INTO a " + "VALUES (1)")', "", "one whole string"),
    "SQL in a variable": ("op.execute(statement)", "", "one whole string"),
    "text() of a variable": (
        "op.execute(sa.text(SQL))",
        'SQL = "DELETE FROM a"',
        "one whole string",
    ),
    "text() with bindparams": (
        'op.execute(sa.text("INSERT INTO a VALUES (:x)").bindparams(x=1))',
        "",
        "one whole string",
    ),
    "a SQLAlchemy delete": ("op.execute(sa.delete(payments))", "", "SQLAlchemy delete"),
    "a SQLAlchemy update on a table": (
        'payments = sa.table("payments", sa.column("note"))\n'
        'op.execute(payments.update().values(note=""))',
        "",
        "SQLAlchemy update",
    ),
    "delete imported from sqlalchemy": (
        'op.get_bind().execute(delete(sa.table("payments")))',
        "from sqlalchemy import delete",
        "SQLAlchemy delete",
    ),
    "batch copy_from": (
        """
        with op.batch_alter_table("students", copy_from=students_table) as batch_op:
            batch_op.add_column(sa.Column("x", sa.Integer()))
        """,
        "",
        "copy_from",
    ),
    "hidden in a helper in this file": (
        "_cleanup()",
        'def _cleanup() -> None:\n    op.drop_table("payments")',
        "drop_table removes",
    ),
    "getattr on op": ('getattr(op, "drop_" + "table")("payments")', "", "getattr(...) hides"),
    "an imported helper": (
        "cleanup()",
        "from app.migrations.helpers import cleanup",
        "can't follow",
    ),
    "an imported module's helper": ("helpers.cleanup()", "import helpers", "imported helpers"),
    "a class method": (
        "Cleanup.run()",
        'class Cleanup:\n    @staticmethod\n    def run() -> None:\n        op.drop_table("a")',
        "class Cleanup",
    ),
    "calls through a list": (
        'for step in [op.drop_table]:\n    step("payments")',
        "",
        "can't follow",
    ),
    "a call through a subscript": ('OPS[0]("payments")', "OPS = [op.drop_table]", "through a list"),
    "an operation passed around": ('list(map(op.drop_table, ["a"]))', "", "passed around"),
    "an alias of op": ('o = op\no.drop_table("payments")', "", "drop_table removes"),
    "an op it doesn't know": ("op.invoke(some_operation)", "", "op.invoke(...) isn't"),
}


@pytest.mark.parametrize(("upgrade", "extra", "expected"), FLAGGED.values(), ids=FLAGGED.keys())
def test_destructive_or_unfollowable_changes_are_flagged(
    upgrade: str, extra: str, expected: str
) -> None:
    source = migration(upgrade) + (f"\n\n{extra}\n" if extra else "")
    found = problems(source)
    assert any(expected in p for p in found), (found, source)


def test_the_finding_names_the_line() -> None:
    source = migration('op.create_table("x", sa.Column("id", sa.Integer()))\nop.drop_table("y")')
    [finding] = scanner.check_source(source, "0099_x.py")
    assert source.splitlines()[finding.line - 1].strip() == 'op.drop_table("y")'
    assert str(finding).startswith(f"0099_x.py:{finding.line}: drop_table")


# --------------------------------------------------------------------------- allowed

ALLOWED = {
    "a new table, like the Excel import's": """
        op.create_table(
            "unassigned_payments",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("amount_paise", sa.Integer(), nullable=False),
            sa.Column("note", sa.Text(), nullable=True),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_unassigned_payments")),
        )
        with op.batch_alter_table("unassigned_payments") as batch_op:
            batch_op.create_index("ix_unassigned_payments_amount", ["amount_paise"])
    """,
    "a nullable column": 'op.add_column("students", sa.Column("email", sa.String()))',
    "an explicitly nullable column": """
        op.add_column("students", sa.Column("email", sa.String(), nullable=True))
    """,
    "a required column with a default": """
        with op.batch_alter_table("fee_changes") as batch_op:
            batch_op.add_column(
                sa.Column("kind", sa.String(8), server_default="fee", nullable=False)
            )
    """,
    "a batch that recreates the table and only adds": """
        with op.batch_alter_table("students", recreate="always") as batch_op:
            batch_op.add_column(sa.Column("nickname", sa.String(), nullable=True))
            batch_op.create_check_constraint("nickname_short", "length(nickname) < 50")
    """,
    "a new default, or a column made optional": """
        with op.batch_alter_table("students") as batch_op:
            batch_op.alter_column("batch_label", server_default="Morning")
            batch_op.alter_column("phone", existing_type=sa.String(), nullable=True)
    """,
    "an index, a constraint, and dropping an index": """
        op.create_index("ix_payments_method", "payments", ["method"])
        op.drop_index("ix_old")
        op.create_unique_constraint("uq_x", "students", ["phone"])
    """,
    "SQL that only adds": """
        op.execute("INSERT INTO unassigned_payments (amount_paise) SELECT 1 WHERE 0")
        op.execute(sa.text("CREATE INDEX ix_y ON payments (paid_on)"))
    """,
    "a new table whose links clear or cascade": """
        op.execute(
            "CREATE TABLE notes (id INTEGER PRIMARY KEY, student_id INTEGER"
            " REFERENCES students (id) ON DELETE SET NULL ON UPDATE CASCADE)"
        )
    """,
    "the words only in quoted text, names or comments": """
        op.execute(
            "INSERT INTO audit (\\"update\\", message) -- no DELETE here\\n"
            "VALUES (1, 'please DROP by and UPDATE the delete button')"
        )
    """,
    "the replace() function": (
        "op.execute(\"INSERT INTO a (name) SELECT replace(name, '  ', ' ') FROM b\")"
    ),
    "one string split over lines": """
        op.execute(
            "INSERT INTO a (id) "
            "SELECT id FROM b"
        )
    """,
    "a dictionary's update, and a list's": """
        defaults = {"kind": "fee"}
        defaults.update({"x": 1})
        names = []
        names.append("x")
        op.bulk_insert(sa.table("a", sa.column("kind")), [defaults])
    """,
    "rows added with bulk_insert": "op.bulk_insert(table, [{'id': 1}])",
    "a local helper and builtins": """
        def column(name):
            return sa.Column(name, sa.String(), nullable=True)

        for name in sorted(["a", "b"]):
            op.add_column("students", column(name))
    """,
}


@pytest.mark.parametrize("upgrade", ALLOWED.values(), ids=ALLOWED.keys())
def test_adding_is_allowed(upgrade: str) -> None:
    assert problems(migration(upgrade)) == []


def test_sqlalchemy_names_imported_directly_are_known() -> None:
    header = HEADER + "from sqlalchemy import Column, Integer, text\n"
    source = migration(
        'op.add_column("a", Column("b", Integer()))\nop.execute(text("CREATE INDEX i ON a (b)"))',
        header=header,
    )
    assert problems(source) == []


def test_downgrade_is_not_checked() -> None:
    source = migration(
        'op.add_column("students", sa.Column("email", sa.String()))',
        downgrade='op.drop_column("students", "email")\nop.drop_table("unassigned_payments")',
    )
    assert problems(source) == []


def test_released_migrations_pass() -> None:
    versions = sorted(scanner.VERSIONS.glob("*.py"))
    assert any("0002_fee_change_kind" in p.name for p in versions)
    for path in versions:
        assert scanner.check_file(path) == [], path.name


def test_main(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert scanner.main([]) == 0
    bad = tmp_path / "0099_bad.py"
    bad.write_text(migration('op.drop_table("payments")'), encoding="utf-8")
    assert scanner.main([str(bad)]) == 1
    out = capsys.readouterr()
    assert "::error file=" in out.out
    assert "data-safety: approved by owner" in out.err


# --------------------------------------------------------------------------- the marker

APPROVAL = "# data-safety: approved by owner — merged duplicate students, 2026-10-02"


def test_marker_on_the_line_approves_it() -> None:
    assert problems(migration(f'op.drop_table("old_imports")  {APPROVAL}')) == []


def test_marker_on_the_line_above_approves_it() -> None:
    assert problems(migration(f'{APPROVAL}\nop.drop_table("old_imports")')) == []


def test_marker_inside_a_multi_line_call_approves_it() -> None:
    source = migration(f'op.execute(\n    "DELETE FROM old_imports"  {APPROVAL}\n)')
    assert problems(source) == []


def test_module_comment_before_any_def_approves_the_whole_migration() -> None:
    source = migration(
        'op.drop_table("a")\nop.execute("UPDATE b SET c = 1")',
        header=HEADER + f"\n{APPROVAL}\n",
    )
    assert problems(source) == []


def test_marker_in_a_helper_above_upgrade_only_approves_its_line() -> None:
    helper = f'\n\ndef _tidy() -> None:\n    op.drop_table("old_imports")  {APPROVAL}\n'
    source = migration('_tidy()\nop.drop_table("payments")', header=HEADER + helper)
    assert problems(source) == ["drop_table removes the owner's data"]
    [finding] = scanner.check_source(source)
    assert 'op.drop_table("payments")' in source.splitlines()[finding.line - 1]


def test_marker_after_the_first_def_is_not_file_wide() -> None:
    helper = f"\n\ndef _unused() -> None:\n    pass\n\n\n{APPROVAL}\n"
    source = migration('op.drop_table("payments")', header=HEADER + helper)
    assert problems(source) == ["drop_table removes the owner's data"]


def test_marker_only_approves_its_own_line() -> None:
    source = migration(f'op.drop_table("a")  {APPROVAL}\n\n\nop.drop_table("b")')
    assert problems(source) == ["drop_table removes the owner's data"]


@pytest.mark.parametrize(
    "comment",
    [
        "# data-safety: approved by owner — ",
        "# data-safety: approved by owner",
        "# data-safety: approved",
        "# approved by owner — fine",
    ],
)
def test_marker_needs_the_exact_words_and_a_reason(comment: str) -> None:
    assert problems(migration(f'op.drop_table("a")  {comment}'))


def test_marker_in_a_string_is_not_a_marker() -> None:
    source = migration(f'op.execute("DELETE FROM a -- {APPROVAL[2:]}")')
    assert problems(source)


def test_file_without_upgrade_is_skipped() -> None:
    assert problems('"""Not a migration."""\nx = 1\n') == []
