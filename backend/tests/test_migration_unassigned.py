"""Migrations 0003 (unassigned_payments) and 0004 (students.uid) only add: the records a v0.1.0 laptop has come
through untouched, and the new table has the same safeguards as `payments`."""

from __future__ import annotations

import pytest
from alembic import command
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

from app import migrate
from app.db import dispose_engines, get_engine

ROWS = {
    "students": "SELECT id, name, phone, joined_month, left_month FROM students ORDER BY id",
    "fee_changes": "SELECT student_id, effective_month, amount_paise, kind FROM fee_changes "
    "ORDER BY id",
    "payments": "SELECT student_id, amount_paise, paid_on, for_month, method, note FROM payments "
    "ORDER BY id",
}


def _v010_database() -> dict[str, list[tuple[object, ...]]]:
    """A database at 0002 (v0.1.0's schema) with a student who left and came back."""
    command.upgrade(migrate.alembic_config(), "0002")
    with get_engine().begin() as conn:
        conn.execute(
            text(
                "INSERT INTO students (id, name, phone, joined_month, left_month) VALUES "
                "(1, 'Ananya Rao', '98765 43210', '2025-06-01', NULL), "
                "(2, 'Kabir Mehta', NULL, '2025-01-01', '2025-12-01')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO fee_changes (student_id, effective_month, amount_paise, kind) VALUES "
                "(1, '2025-06-01', 150000, 'fee'), (1, '2025-09-01', 0, 'away'), "
                "(1, '2026-01-01', 180000, 'fee'), (2, '2025-01-01', 120000, 'fee')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO payments (student_id, amount_paise, paid_on, for_month, method, note) "
                "VALUES (1, 150000, '2025-06-05', '2025-06-01', 'upi', 'first'), "
                "(2, 120000, '2025-02-03', '2025-02-01', 'cash', NULL)"
            )
        )
    with get_engine().connect() as conn:
        before = {table: [tuple(r) for r in conn.execute(text(q))] for table, q in ROWS.items()}
    dispose_engines()
    return before


def test_upgrade_adds_the_table_and_keeps_every_record() -> None:
    before = _v010_database()
    migrate.upgrade_to_head()
    assert migrate.current_revision() == migrate.head_revision()
    with get_engine().connect() as conn:
        after = {table: [tuple(r) for r in conn.execute(text(q))] for table, q in ROWS.items()}
        assert after == before
        columns = [c["name"] for c in inspect(conn).get_columns("unassigned_payments")]
        # payments.student_id is still required: nothing about payments changed.
        student_id = next(
            c for c in inspect(conn).get_columns("payments") if c["name"] == "student_id"
        )
    assert student_id["nullable"] is False
    # 0004 only adds students.uid, empty until the student is first downloaded.
    with get_engine().connect() as conn:
        uid = next(c for c in inspect(conn).get_columns("students") if c["name"] == "uid")
        assert uid["nullable"] is True
        assert conn.execute(text("SELECT count(*) FROM students WHERE uid IS NULL")).scalar() == 2
    assert columns == [
        "id",
        "student_text",
        "phone",
        "amount_paise",
        "paid_on",
        "for_month",
        "method",
        "note",
        "source",
        "created_at",
    ]
    dispose_engines()
    # Down again (for a developer): only the new table goes.
    command.downgrade(migrate.alembic_config(), "0002")
    with get_engine().connect() as conn:
        assert "unassigned_payments" not in inspect(conn).get_table_names()
        again = {table: [tuple(r) for r in conn.execute(text(q))] for table, q in ROWS.items()}
    assert again == before


GOOD = {
    "student_text": "'Kabeer'",
    "amount_paise": "150000",
    "paid_on": "'2026-06-02'",
    "for_month": "'2026-06-01'",
    "method": "'upi'",
}


@pytest.mark.parametrize(
    "bad",
    [
        {"student_text": "'  '"},
        {"amount_paise": "0"},
        {"amount_paise": "-5"},
        {"paid_on": "'garbage'"},
        {"for_month": "'2026-06-02'"},
        {"for_month": "'2026-06'"},
        {"method": "'cheque'"},
    ],
)
def test_unassigned_payments_reject_bad_rows(bad: dict[str, str]) -> None:
    migrate.upgrade_to_head()
    fields = {**GOOD, **bad}
    sql = (
        f"INSERT INTO unassigned_payments ({', '.join(fields)}) "
        f"VALUES ({', '.join(fields.values())})"
    )
    with pytest.raises(IntegrityError), get_engine().begin() as conn:
        conn.execute(text(sql))


def test_a_good_row_is_accepted() -> None:
    migrate.upgrade_to_head()
    sql = f"INSERT INTO unassigned_payments ({', '.join(GOOD)}) VALUES ({', '.join(GOOD.values())})"
    with get_engine().begin() as conn:
        conn.execute(text(sql))
        assert conn.execute(text("SELECT count(*) FROM unassigned_payments")).scalar() == 1
