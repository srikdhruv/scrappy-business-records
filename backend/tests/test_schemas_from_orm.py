"""Read models must build straight from ORM rows, where months are `date`s and timestamps are
naive UTC datetimes."""

import datetime as dt
import json
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app import migrate
from app.db import get_engine
from app.errors import unprocessable
from app.models import FeeChange, Payment, PaymentMethod, Student
from app.schemas import (
    FeeChangeRead,
    LedgerMonth,
    MonthStatus,
    PaymentRead,
    StudentRead,
)


@pytest.fixture
def session() -> Session:
    migrate.upgrade_to_head()
    with Session(get_engine()) as s:
        student = Student(name="Kabir Mehta", joined_month=dt.date(2026, 1, 1))
        student.fee_changes.append(FeeChange(effective_month=dt.date(2026, 1, 1), amount_paise=1))
        student.payments.append(
            Payment(
                amount_paise=150000,
                paid_on=dt.date(2026, 2, 5),
                for_month=dt.date(2026, 2, 1),
                method=PaymentMethod.cash,
            )
        )
        s.add(student)
        s.commit()
    # A fresh session, so every value is read back from the database.
    with Session(get_engine()) as s:
        yield s


def _is_utc_z(value: str) -> bool:
    return value.endswith("Z") and dt.datetime.fromisoformat(value).utcoffset() == dt.timedelta(0)


def test_fee_change_read(session: Session) -> None:
    fee = session.scalars(select(FeeChange)).one()
    assert FeeChangeRead.model_validate(fee).effective_month == "2026-01"


def test_payment_read(session: Session) -> None:
    payment = session.scalars(select(Payment).options(joinedload(Payment.student))).one()
    read = PaymentRead.model_validate(payment)
    assert read.for_month == "2026-02"
    assert read.paid_on == dt.date(2026, 2, 5)
    assert read.student_name == "Kabir Mehta"
    body = json.loads(read.model_dump_json())
    assert _is_utc_z(body["created_at"])
    assert _is_utc_z(body["updated_at"])


def test_student_read(session: Session) -> None:
    student = session.scalars(select(Student)).one()
    # The computed fields come from the ledger; the stored ones straight from the row.
    row = SimpleNamespace(
        **{c.key: getattr(student, c.key) for c in Student.__table__.columns},
        is_active=True,
        monthly_fee_paise=1,
        balance_paise=0,
        status="up_to_date",
        credit_paise=0,
        tenure_months=1,
        current_month=dt.date(2026, 1, 1),
    )
    read = StudentRead.model_validate(row)
    assert read.joined_month == "2026-01"
    assert read.left_month is None
    assert read.created_at.tzinfo == dt.UTC
    assert _is_utc_z(json.loads(read.model_dump_json())["created_at"])


def test_ledger_month_from_date() -> None:
    month = LedgerMonth.model_validate(
        {
            "month": dt.date(2026, 3, 1),
            "expected_paise": 100,
            "paid_paise": 0,
            "remaining_paise": 100,
            "excess_paise": 0,
            "status": MonthStatus.unpaid,
            "is_due": True,
        }
    )
    assert month.month == "2026-03"


def test_unprocessable_matches_fastapi_validation_shape() -> None:
    error = unprocessable("left_month cannot be before joined_month", field="left_month")
    assert error.status_code == 422
    assert error.detail == [
        {
            "loc": ["body", "left_month"],
            "msg": "left_month cannot be before joined_month",
            "type": "value_error",
        }
    ]
