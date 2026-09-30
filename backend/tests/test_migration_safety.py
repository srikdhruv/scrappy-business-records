"""Migrations must never lose the user's data.

SQLite rebuilds a table (batch mode) by copying it and dropping the original. With foreign keys
on, dropping `students` would cascade-delete every payment and fee change. These tests run real
extra migrations on top of head against a seeded database.
"""

import datetime as dt
import shutil
from pathlib import Path

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import config, migrate
from app.db import dispose_engines, get_engine
from app.models import FeeChange, Payment, PaymentMethod, Student

EXTRA_REVISION = """
import sqlalchemy as sa
from alembic import op

revision = "9001"
down_revision = "{down}"
branch_labels = None
depends_on = None


def upgrade() -> None:
{body}


def downgrade() -> None:
    pass
"""


@pytest.fixture
def seeded() -> None:
    """Head schema with one student, one fee change and one payment."""
    migrate.upgrade_to_head()
    with Session(get_engine()) as s:
        student = Student(name="Ananya Rao", phone="90000 00010", joined_month=dt.date(2026, 1, 1))
        student.fee_changes.append(
            FeeChange(effective_month=dt.date(2026, 1, 1), amount_paise=150000)
        )
        student.payments.append(
            Payment(
                amount_paise=150000,
                paid_on=dt.date(2026, 1, 5),
                for_month=dt.date(2026, 1, 1),
                method=PaymentMethod.upi,
            )
        )
        s.add(student)
        s.commit()
    dispose_engines()


def _scripts_with_extra_revision(tmp_path: Path, body: str) -> Path:
    """A copy of the real migrations plus one extra revision on top of head."""
    scripts = tmp_path / "migrations"
    shutil.copytree(migrate.MIGRATIONS_DIR, scripts, ignore=shutil.ignore_patterns("__pycache__"))
    (scripts / "versions" / "9001_test.py").write_text(
        EXTRA_REVISION.format(down=migrate.head_revision(), body=body)
    )
    return scripts


def _counts() -> tuple[int, ...]:
    with get_engine().connect() as conn:
        return tuple(
            conn.execute(text(f"SELECT count(*) FROM {table}")).scalar_one()
            for table in ("students", "fee_changes", "payments")
        )


def test_batch_migration_recreating_students_keeps_children(seeded: None, tmp_path: Path) -> None:
    scripts = _scripts_with_extra_revision(
        tmp_path,
        '    with op.batch_alter_table("students", recreate="always") as batch:\n'
        '        batch.alter_column("phone", type_=sa.String(50), existing_nullable=True)',
    )
    migrate.upgrade_to_head(script_location=scripts)

    assert migrate.current_revision() == "9001"
    assert _counts() == (1, 1, 1)
    with get_engine().connect() as conn:
        assert conn.execute(text("PRAGMA foreign_keys")).scalar() == 1
        assert conn.execute(text("PRAGMA foreign_key_check")).fetchall() == []
        assert conn.execute(text("SELECT phone FROM students")).scalar() == "90000 00010"


def test_migration_breaking_foreign_keys_is_rolled_back(seeded: None, tmp_path: Path) -> None:
    scripts = _scripts_with_extra_revision(
        tmp_path,
        '    op.add_column("students", sa.Column("extra", sa.Integer()))\n'
        "    op.execute(\n"
        '        "INSERT INTO payments (student_id, amount_paise, paid_on, for_month, method)"\n'
        "        \" VALUES (999, 100, '2026-01-05', '2026-01-01', 'cash')\"\n"
        "    )",
    )
    with pytest.raises(RuntimeError, match="foreign keys"):
        migrate.upgrade_to_head(script_location=scripts)

    # Everything, the DDL included, was rolled back.
    assert migrate.current_revision() == migrate.head_revision()
    assert _counts() == (1, 1, 1)
    columns = {c["name"] for c in inspect(get_engine()).get_columns("students")}
    assert "extra" not in columns


def test_needs_upgrade_does_not_create_the_database() -> None:
    assert migrate.needs_upgrade()
    assert not config.db_path().exists()


def _insert(table: str, fields: dict[str, str]) -> None:
    sql = f"INSERT INTO {table} ({', '.join(fields)}) VALUES ({', '.join(fields.values())})"
    with get_engine().connect() as conn, pytest.raises(IntegrityError):
        conn.execute(text(sql))


@pytest.mark.parametrize(
    ("column", "value"),
    [
        ("joined_month", "'garbage'"),
        ("joined_month", "'2026-10'"),
        ("joined_month", "20261001"),
        ("joined_month", "'2026-10-05'"),
        ("left_month", "'garbage'"),
        ("left_month", "'2026-12-31'"),
    ],
)
def test_month_columns_reject_non_months(seeded: None, column: str, value: str) -> None:
    fields = {"name": "'Kabir Mehta'", "joined_month": "'2026-01-01'", column: value}
    _insert("students", fields)


@pytest.mark.parametrize(
    ("column", "value"),
    [
        ("for_month", "'2026-10'"),
        ("for_month", "'garbage'"),
        ("paid_on", "'garbage'"),
        ("paid_on", "'2026-02-30'"),
    ],
)
def test_payment_dates_reject_non_dates(seeded: None, column: str, value: str) -> None:
    fields = {
        "student_id": "1",
        "amount_paise": "100",
        "paid_on": "'2026-01-05'",
        "for_month": "'2026-01-01'",
        "method": "'cash'",
        column: value,
    }
    _insert("payments", fields)


def test_effective_month_rejects_non_months(seeded: None) -> None:
    fields = {"student_id": "1", "effective_month": "'2026-02'", "amount_paise": "1"}
    _insert("fee_changes", fields)
