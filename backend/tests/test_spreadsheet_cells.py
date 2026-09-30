# ruff: noqa: RUF001  (the curly apostrophes and dashes are the point)
"""Reading cells forgivingly (app/services/spreadsheet.py), and the shared student matcher
(app/services/text.py), which must find exactly who frontend/src/lib/search.ts finds."""

from __future__ import annotations

import datetime as dt

import pytest

from app.models import PaymentMethod
from app.services import spreadsheet as cells
from app.services.spreadsheet import CellError, normalize_heading
from app.services.text import name_key, phone_digits, student_matches


@pytest.mark.parametrize(
    ("value", "paise"),
    [
        (1500, 150000),
        (1500.0, 150000),
        (1500.5, 150050),
        (0, 0),
        ("1500", 150000),
        ("₹1,500", 150000),
        ("₹ 1,500", 150000),
        ("1500/-", 150000),
        ("1,500/-", 150000),
        ("1500 /-", 150000),
        ("Rs. 1,500.00", 150000),
        ("rs 1500", 150000),
        ("INR 1500", 150000),
        ("1,50,000", 15000000),
        ("99.9", 9990),
        (None, None),
        ("  ", None),
    ],
)
def test_money(value: object, paise: int | None) -> None:
    assert cells.money(value) == paise


@pytest.mark.parametrize(
    "value",
    ["abc", "-1500", -1, "1500.555", 1500.555, True, float("nan"), "₹", "15 00 x", "₹500 700"],
)
def test_money_rejects(value: object) -> None:
    with pytest.raises(CellError):
        cells.money(value)


@pytest.mark.parametrize(
    ("value", "day"),
    [
        (dt.date(2026, 10, 5), dt.date(2026, 10, 5)),
        (dt.datetime(2026, 10, 5, 14, 30), dt.date(2026, 10, 5)),
        ("5 Oct 2026", dt.date(2026, 10, 5)),
        ("05 October 2026", dt.date(2026, 10, 5)),
        ("5th Oct, 2026", dt.date(2026, 10, 5)),
        ("5-Oct-26", dt.date(2026, 10, 5)),
        ("05/10/2026", dt.date(2026, 10, 5)),  # day first, as in India
        ("5/10/26", dt.date(2026, 10, 5)),
        ("05-10-2026", dt.date(2026, 10, 5)),
        ("5.10.2026", dt.date(2026, 10, 5)),
        ("2026-10-05", dt.date(2026, 10, 5)),
        ("2026-10-05 00:00:00", dt.date(2026, 10, 5)),
        ("Oct 5, 2026", dt.date(2026, 10, 5)),
        (46300, dt.date(2026, 10, 5)),  # an Excel day number, from a cell without a date format
        ("46300", dt.date(2026, 10, 5)),  # ...that became text
        ("05/10/2026 10:30", dt.date(2026, 10, 5)),  # a time after it is ignored
        ("5 Oct 2026 4:15 pm", dt.date(2026, 10, 5)),
        (None, None),
    ],
)
def test_dates(value: object, day: dt.date | None) -> None:
    assert cells.date(value) == day


@pytest.mark.parametrize("value", ["31/02/2026", "13/13/2026", "yesterday", "Oct 2026x", 5, True])
def test_dates_rejected(value: object) -> None:
    with pytest.raises(CellError):
        cells.date(value)


@pytest.mark.parametrize(
    ("value", "month"),
    [
        ("Oct 2026", "2026-10"),
        ("October 2026", "2026-10"),
        ("oct-26", "2026-10"),
        ("Oct'26", "2026-10"),
        ("Sept 2026", "2026-09"),
        ("2026-10", "2026-10"),
        ("2026/10", "2026-10"),
        ("10/2026", "2026-10"),
        ("10/26", "2026-10"),
        ("05/10/2026", "2026-10"),
        (dt.date(2026, 10, 1), "2026-10"),
        (dt.datetime(2026, 10, 17), "2026-10"),
        (None, None),
    ],
)
def test_months(value: object, month: str | None) -> None:
    assert cells.month(value) == month


@pytest.mark.parametrize("value", ["13/2026", "Octember 2026", "Oct 1999", "2100-01", "x", 12])
def test_months_rejected(value: object) -> None:
    with pytest.raises(CellError):
        cells.month(value)


@pytest.mark.parametrize(
    ("value", "method"),
    [
        ("UPI", PaymentMethod.upi),
        ("GPay", PaymentMethod.upi),
        ("Google Pay", PaymentMethod.upi),
        ("PhonePe", PaymentMethod.upi),
        (" cash ", PaymentMethod.cash),
        ("Cheque", PaymentMethod.other),
        (None, PaymentMethod.other),
    ],
)
def test_methods(value: object, method: PaymentMethod) -> None:
    assert cells.method(value) == method


@pytest.mark.parametrize(
    ("heading", "normal"),
    [
        ("Monthly fee ₹ (current)", "monthly fee"),
        ("Amount (Rs.)", "amount"),
        ("Parent / Guardian", "parent/guardian"),
        ("  PAID ON  ", "paid on"),
        ("Student ID (for restoring)", "student id"),
        ("Dinner", "dinner"),
    ],
)
def test_headings(heading: str, normal: str) -> None:
    assert normalize_heading(heading) == normal


def test_text_cells() -> None:
    assert cells.text(9876543210) == "9876543210"
    assert cells.text(9876543210.0) == "9876543210"
    assert cells.text("  Kabir ") == "Kabir"
    assert cells.text("   ") is None


# --------------------------------------------------------------------------- the matcher

# The same examples as frontend/src/lib/search.test.ts.
ARJUN = {
    "name": "Arjun Menon",
    "phone": "90000 00006",
    "guardian_name": "Lakshmi Menon",
    "batch_label": "Tue/Thu 5pm – Indiranagar",
}
EMILE = {"name": "Émile Dsouza", "phone": "+91 98765-43210", "guardian_name": None}
OBRIEN = {"name": "Siobhan O’Brien", "guardian_name": "Maria D'Souza Smith-Jones"}


@pytest.mark.parametrize(
    ("query", "student"),
    [
        ("", ARJUN),
        ("arjun", ARJUN),
        ("ARJUN", ARJUN),
        ("menon arjun", ARJUN),
        ("arj men", ARJUN),
        ("lakshmi", ARJUN),
        ("indiranagar", ARJUN),
        ("5pm tue", ARJUN),
        ("9000000006", ARJUN),
        ("90000 00006", ARJUN),
        ("90000-00006", ARJUN),
        ("00006", ARJUN),
        ("emile", EMILE),
        ("EMILE dsouza", EMILE),
        ("9876543210", EMILE),
        ("98765 43210", EMILE),
        ("+91 98765 43210", EMILE),
        ("919876543210", EMILE),
        ("+919876543210", EMILE),
        ("09876543210", EMILE),
        ("+91 90000 00006", ARJUN),
        ("obrien", OBRIEN),
        ("o'brien", OBRIEN),
        ("O’Brien", OBRIEN),
        ("dsouza", OBRIEN),
        ("d'souza", OBRIEN),
        ("smith jones", OBRIEN),
    ],
)
def test_matches_like_the_students_search(query: str, student: dict) -> None:
    assert student_matches(query, **student)


@pytest.mark.parametrize(
    ("query", "student"),
    [("arjun kabir", ARJUN), ("9000000007", ARJUN), ("12345", EMILE), ("menon", EMILE)],
)
def test_does_not_match_like_the_students_search(query: str, student: dict) -> None:
    assert not student_matches(query, **student)


def test_a_class_time_is_not_a_phone_number() -> None:
    assert not student_matches("5pm", **{**ARJUN, "batch_label": None})


def test_same_name_and_phone() -> None:
    assert name_key("Rao  Ananya") == name_key("ananya rao") == ("ananya", "rao")
    assert name_key("Émile O’Brien") == name_key("emile obrien")
    assert name_key("  ") == ()
    assert phone_digits("+91 98765-43210") == phone_digits("098765 43210") == "9876543210"
