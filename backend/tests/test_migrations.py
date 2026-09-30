import datetime as dt

import pytest
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from sqlalchemy import inspect, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import config, migrate
from app.db import get_engine
from app.models import Base, FeeChange, Payment, PaymentMethod, Student


@pytest.fixture
def migrated() -> None:
    config.ensure_dirs()
    assert migrate.needs_upgrade()
    migrate.upgrade_to_head()


def test_upgrade_from_empty_creates_tables(migrated: None) -> None:
    tables = set(inspect(get_engine()).get_table_names())
    assert {"students", "fee_changes", "payments", "alembic_version"} <= tables
    assert migrate.current_revision() == migrate.head_revision()
    assert not migrate.needs_upgrade()


def test_upgrade_is_idempotent(migrated: None) -> None:
    migrate.upgrade_to_head()
    assert migrate.current_revision() == migrate.head_revision()


def test_migrations_match_models(migrated: None) -> None:
    """If this fails, models.py changed without a migration (or vice versa)."""
    with get_engine().connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)
    assert diff == []


def test_foreign_keys_are_enforced(migrated: None) -> None:
    with get_engine().connect() as conn:
        assert conn.execute(text("PRAGMA foreign_keys")).scalar() == 1


def _student(**overrides: object) -> Student:
    fields: dict[str, object] = {"name": "Ananya Rao", "joined_month": dt.date(2026, 1, 1)}
    fields.update(overrides)
    return Student(**fields)


def test_delete_student_cascades(migrated: None) -> None:
    with Session(get_engine()) as s:
        student = _student()
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
        # Delete with raw SQL so the database's ON DELETE CASCADE does the work, not the ORM.
        s.execute(text("DELETE FROM students WHERE id = :id"), {"id": student.id})
        s.commit()
        assert s.scalars(select(FeeChange)).all() == []
        assert s.scalars(select(Payment)).all() == []


@pytest.mark.parametrize(
    "bad",
    [
        {"joined_month": dt.date(2026, 1, 15)},
        {"left_month": dt.date(2025, 12, 1)},
        {"name": "   "},
    ],
)
def test_student_constraints(migrated: None, bad: dict[str, object]) -> None:
    with Session(get_engine()) as s:
        s.add(_student(**bad))
        with pytest.raises(IntegrityError):
            s.commit()


@pytest.mark.parametrize(
    "bad",
    [
        {"amount_paise": 0},
        {"for_month": dt.date(2026, 1, 2)},
    ],
)
def test_payment_constraints(migrated: None, bad: dict[str, object]) -> None:
    with Session(get_engine()) as s:
        student = _student()
        s.add(student)
        s.commit()
        fields: dict[str, object] = {
            "student_id": student.id,
            "amount_paise": 100,
            "paid_on": dt.date(2026, 1, 5),
            "for_month": dt.date(2026, 1, 1),
            "method": PaymentMethod.cash,
        }
        fields.update(bad)
        s.add(Payment(**fields))
        with pytest.raises(IntegrityError):
            s.commit()


def test_payment_method_is_checked(migrated: None) -> None:
    with Session(get_engine()) as s:
        student = _student()
        s.add(student)
        s.commit()
        with pytest.raises(IntegrityError):
            s.execute(
                text(
                    "INSERT INTO payments (student_id, amount_paise, paid_on, for_month, method)"
                    " VALUES (:sid, 100, '2026-01-05', '2026-01-01', 'cheque')"
                ),
                {"sid": student.id},
            )


def test_fee_change_unique_per_month(migrated: None) -> None:
    with Session(get_engine()) as s:
        student = _student()
        student.fee_changes.append(FeeChange(effective_month=dt.date(2026, 1, 1), amount_paise=1))
        student.fee_changes.append(FeeChange(effective_month=dt.date(2026, 1, 1), amount_paise=2))
        s.add(student)
        with pytest.raises(IntegrityError):
            s.commit()
