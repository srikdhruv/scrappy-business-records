"""The released v0.1.0 data gives the right numbers under the credit-allocation rules.

Credit allocation (PRD ledger rule 10) changed no table and added no migration: it is worked
out from the payments every time. So a database written by v0.1.0 is read as it is. These
tests write rows the way v0.1.0 did (plain SQL against the v0.1.0 schema, which is still the
head), then check what every screen's API now says, and that reading never changed a row.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from conftest import FROZEN_TODAY
from fastapi.testclient import TestClient

from app import config, migrate
from app.clock import get_today
from app.db import dispose_engines
from app.main import create_app

V0_1_0_HEAD = "0002"
"""The last migration in v0.1.0 (`20260930_0002_fee_change_kind`)."""


# Since v0.1.0 only Excel uploads added to the database: a new table (0003,
# unassigned_payments) and a new nullable column (0004, students.uid). Neither is read by the
# ledger, and credit allocation itself stores nothing.
ADDED_SINCE_V0_1_0 = ("0003", "0004")


def test_no_migration_since_v0_1_0() -> None:
    # Credit allocation must not change how data is stored.
    assert migrate.head_revision() == ADDED_SINCE_V0_1_0[-1]
    assert V0_1_0_HEAD == "0002"


# Students as v0.1.0 stored them (the current month in these tests is June 2026).
STUDENTS = [
    # id, name, joined, left, fee
    (1, "Ananya Rao", "2026-01-01", None, 150000),  # May paid twice, June unpaid
    (2, "Kabir Mehta", "2026-02-01", None, 200000),  # March unpaid; April partial; June double
    (3, "Meera Iyer", "2026-03-01", "2026-04-01", 120000),  # left; paid for May by mistake
    (4, "Rohan Desai", "2026-01-01", "2026-02-01", 100000),  # left; paid ₹500 extra: credit
    (5, "Diya Nair", "2026-04-01", None, 180000),  # paid ahead for July, exactly
]
PAYMENTS = [
    # id, student, amount, paid_on, for_month
    (1, 1, 150000, "2026-01-04", "2026-01-01"),
    (2, 1, 150000, "2026-02-03", "2026-02-01"),
    (3, 1, 150000, "2026-03-05", "2026-03-01"),
    (4, 1, 150000, "2026-04-02", "2026-04-01"),
    (5, 1, 150000, "2026-05-06", "2026-05-01"),
    (6, 1, 150000, "2026-05-20", "2026-05-01"),  # May again, instead of June
    (7, 2, 200000, "2026-02-05", "2026-02-01"),
    (8, 2, 100000, "2026-04-05", "2026-04-01"),
    (9, 2, 200000, "2026-05-05", "2026-05-01"),
    (10, 2, 400000, "2026-06-02", "2026-06-01"),  # June twice over
    (11, 3, 120000, "2026-03-05", "2026-03-01"),
    (12, 3, 120000, "2026-05-10", "2026-05-01"),  # after leaving: meant for April
    (13, 4, 100000, "2026-01-05", "2026-01-01"),
    (14, 4, 150000, "2026-02-05", "2026-02-01"),  # ₹500 over, and nothing else to pay
    (15, 5, 180000, "2026-04-05", "2026-04-01"),
    (16, 5, 180000, "2026-05-05", "2026-05-01"),
    (17, 5, 180000, "2026-06-05", "2026-06-01"),
    (18, 5, 180000, "2026-06-10", "2026-07-01"),
]


def _write_v0_1_0_rows(db: Path) -> None:
    with sqlite3.connect(db) as conn:
        for sid, name, joined, left, fee in STUDENTS:
            conn.execute(
                "INSERT INTO students (id, name, joined_month, left_month, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, '2026-06-01 09:00:00', '2026-06-01 09:00:00')",
                (sid, name, joined, left),
            )
            conn.execute(
                "INSERT INTO fee_changes (student_id, effective_month, amount_paise, kind,"
                " created_at) VALUES (?, ?, ?, 'fee', '2026-06-01 09:00:00')",
                (sid, joined, fee),
            )
        for pid, sid, amount, paid_on, month in PAYMENTS:
            conn.execute(
                "INSERT INTO payments (id, student_id, amount_paise, paid_on, for_month, method,"
                " note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'upi', NULL,"
                " '2026-06-01 09:00:00', '2026-06-01 09:00:00')",
                (pid, sid, amount, paid_on, month),
            )


def _dump(db: Path) -> list[tuple[object, ...]]:
    with sqlite3.connect(db) as conn:
        return [
            row
            for table in ("students", "fee_changes", "payments")
            for row in conn.execute(f"SELECT * FROM {table} ORDER BY id")
        ]


@pytest.fixture
def v010_api() -> Iterator[tuple[TestClient, Path]]:
    config.ensure_dirs()
    migrate.upgrade_to_head()
    db = config.db_path()
    _write_v0_1_0_rows(db)
    dispose_engines()
    app = create_app()
    app.dependency_overrides[get_today] = lambda: FROZEN_TODAY
    with TestClient(app) as client:
        yield client, db


def test_v0_1_0_data_gives_the_allocated_numbers(v010_api: tuple[TestClient, Path]) -> None:
    api, db = v010_api
    before = _dump(db)

    rows = {s["name"]: s for s in api.get("/api/students", params={"status": "all"}).json()}
    standing = {
        name: (r["status"], r["owed_paise"], r["credit_paise"], r["paid_ahead_paise"])
        for name, r in rows.items()
    }
    assert standing == {
        # May's second payment pays June.
        "Ananya Rao": ("up_to_date", 0, 0, 0),
        # June's ₹2,000 extra pays March; April's last ₹1,000 is still owed.
        "Kabir Mehta": ("owes", 100000, 0, 0),
        # The May payment, after leaving, pays April.
        "Meera Iyer": ("up_to_date", 0, 0, 0),
        # ₹500 over in the last month, with nothing left to pay: credit.
        "Rohan Desai": ("credit", 0, 50000, 0),
        # Paid ahead for July, exactly: nothing moves.
        "Diya Nair": ("up_to_date", 0, 0, 180000),
    }
    # The net balance is the same number v0.1.0 showed.
    assert rows["Kabir Mehta"]["balance_paise"] == 900000 - 5 * 200000

    kabir = api.get(f"/api/students/{rows['Kabir Mehta']['id']}").json()
    by = {m["month"]: m for m in kabir["months"]}
    assert [(c["payment_id"], c["amount_paise"]) for c in by["2026-03"]["credit_sources"]] == [
        (10, 200000)
    ]
    assert (by["2026-04"]["status"], by["2026-04"]["remaining_paise"]) == ("partial", 100000)
    assert by["2026-06"]["extra_sent"] == [{"to_month": "2026-03", "amount_paise": 200000}]

    june = api.get("/api/dashboard").json()
    assert [i["student_name"] for i in june["yet_to_pay"]] == []
    assert [(b["student_name"], b["total_owed_paise"]) for b in june["backlog"]] == [
        ("Kabir Mehta", 100000)
    ]
    assert [(o["student_name"], o["extra_unused_paise"]) for o in june["overpaid"]] == [
        ("Rohan Desai", 50000)
    ]
    assert {(m["student_name"], m["from_month"], m["to_month"]) for m in june["credit_moves"]} == {
        ("Ananya Rao", "2026-05", "2026-06"),
        ("Kabir Mehta", "2026-06", "2026-03"),
    }

    payments = {p["id"]: p for p in api.get("/api/payments").json()}
    assert payments[12]["extra_sent"] == [{"to_month": "2026-04", "amount_paise": 120000}]
    assert payments[14]["extra_unused_paise"] == 50000

    # Reading never writes: every stored row is exactly as v0.1.0 left it.
    assert _dump(db) == before
