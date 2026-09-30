"""The demo data seeds cleanly and has the intended mix."""

from __future__ import annotations

import datetime as dt
import sqlite3
from collections import Counter
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app import config, migrate, seed
from app.db import get_engine
from app.models import Payment, PaymentMethod, Student
from app.months import add_months
from app.schemas import BalanceStatus, MonthStatus
from app.services import ledger
from app.services.students import to_record

TODAY = dt.date(2026, 9, 29)
NOW = dt.date(2026, 9, 1)


@pytest.fixture
def session() -> Iterator[Session]:
    config.ensure_dirs()
    migrate.upgrade_to_head()
    with Session(get_engine()) as s:
        yield s


def load(session: Session) -> list[Student]:
    stmt = select(Student).options(
        selectinload(Student.fee_changes), selectinload(Student.payments)
    )
    return list(session.scalars(stmt))


def test_seed_mix(session: Session) -> None:
    assert seed.seed(session, TODAY) == len(seed.ROSTER) == 25
    students = load(session)
    records = [to_record(s) for s in students]
    by_name = {s.name: s for s in students}
    payments = [p for s in students for p in s.payments]

    # Fictional details.
    assert all(s.phone is None or s.phone.startswith("90000 000") for s in students)
    assert len({s.batch_label for s in students}) == 5
    fees = {f.amount_paise for s in students for f in s.fee_changes}
    assert min(fees) >= 1200_00 and max(fees) <= 3000_00

    # Twelve months of history, all paid on or before today.
    assert min(s.joined_month for s in students) == add_months(NOW, -11)
    assert max(p.paid_on for p in payments) <= TODAY

    # Mostly UPI, some cash.
    methods = Counter(p.method for p in payments)
    assert methods[PaymentMethod.upi] > 0.6 * len(payments)
    assert methods[PaymentMethod.cash] >= 5

    # One left, one fee change, two joined this month.
    assert [s.name for s in students if s.left_month] == ["Rohan Desai"]
    assert [s.name for s in students if len(s.fee_changes) > 1] == ["Kabir Mehta"]
    assert sorted(s.name for s in students if s.joined_month == NOW) == [
        "Advait Srinivasan",
        "Anika Kulkarni",
    ]

    # One advance payment (for next month).
    ahead = [(s.name, p.for_month) for s in students for p in s.payments if p.for_month > NOW]
    assert ahead == [("Aarav Bhat", add_months(NOW, 1))]

    # The dashboard for this month.
    board = ledger.build_dashboard(records, NOW, NOW)
    assert [(o.student.name, o.line.excess_paise) for o in board.overpaid] == [
        ("Vihaan Joshi", 500_00)
    ]
    backlog = {b.student.name: len(b.lines) for b in board.backlog}
    assert backlog["Arjun Menon"] == 3
    assert backlog["Dev Malhotra"] == 2
    assert "Kavya Pillai" in backlog  # an old partial payment
    assert sum(1 for n in backlog.values() if n >= 2) == 2
    yet = {e.student.name: e.line.status for e in board.yet_to_pay}
    assert yet["Pooja Gowda"] is MonthStatus.partial
    assert yet["Anika Kulkarni"] is MonthStatus.unpaid
    assert "Advait Srinivasan" not in yet
    assert 4 <= len(yet) <= 10  # a realistic handful still to pay this month
    assert board.summary.active_student_count == 24

    # Standing: Aarav has credit (paid ahead), the backlog students owe, Rohan is settled.
    status = {r.name: ledger.student_ledger(r, NOW).status for r in records}
    assert status["Aarav Bhat"] is BalanceStatus.credit
    assert status["Arjun Menon"] is BalanceStatus.owes
    assert status["Rohan Desai"] is BalanceStatus.up_to_date
    assert Counter(status.values())[BalanceStatus.up_to_date] >= 12

    # One month was paid in two parts.
    tanvi = Counter(p.for_month for p in by_name["Tanvi Shetty"].payments)
    assert max(tanvi.values()) == 2


def test_seed_is_deterministic() -> None:
    def snapshot() -> list[tuple[object, ...]]:
        return [
            (
                s.name,
                s.joined_month,
                s.left_month,
                *((p.for_month, p.amount_paise, p.paid_on, p.method) for p in s.payments),
            )
            for s in seed.build_students(TODAY)
        ]

    assert snapshot() == snapshot()


def test_seed_early_in_the_month_never_dates_payments_in_the_future() -> None:
    today = dt.date(2026, 3, 1)
    payments = [p for s in seed.build_students(today) for p in s.payments]
    assert max(p.paid_on for p in payments) == today


def test_seed_refuses_non_empty_database_unless_forced(session: Session) -> None:
    seed.seed(session, TODAY)
    with pytest.raises(RuntimeError, match="already has 25 students"):
        seed.seed(session, TODAY)
    before = session.scalars(select(Payment.id)).all()
    assert seed.seed(session, TODAY, force=True) == 25
    assert len(load(session)) == 25
    assert len(session.scalars(select(Payment.id)).all()) == len(before)


def test_main(capsys: pytest.CaptureFixture[str], scrappy_home: Path) -> None:
    assert seed.main([]) == 0
    assert "Added 25 demo students" in capsys.readouterr().out
    assert seed.main([]) == 1
    assert "Use --force" in capsys.readouterr().err
    assert seed.main(["--force"]) == 0
    out = capsys.readouterr().out
    assert "Backed up the database" in out
    [backup] = (scrappy_home / "backups").glob("records-before-seed-*.db")
    with sqlite3.connect(backup) as conn:
        assert conn.execute("SELECT count(*) FROM students").fetchone() == (25,)


def test_main_refuses_without_scrappy_home(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("SCRAPPY_HOME")
    assert seed.main(["--force"]) == 1
    assert "set SCRAPPY_HOME" in capsys.readouterr().err
