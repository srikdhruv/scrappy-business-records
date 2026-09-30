"""API tests: /api/dashboard (current month frozen at June 2026) and the clock dependency."""

from __future__ import annotations

import datetime as dt

from fastapi.testclient import TestClient
from helpers import make_student, pay

from app.clock import get_current_month, get_today


def test_empty_dashboard_defaults_to_current_month(api: TestClient) -> None:
    assert api.get("/api/dashboard").json() == {
        "month": "2026-06",
        "current_month": "2026-06",
        "summary": {
            "expected_paise": 0,
            "collected_paise": 0,
            "paid_ahead_paise": 0,
            "still_due_paise": 0,
            "not_fully_paid_count": 0,
            "active_student_count": 0,
            "logged_paise": 0,
            "covered_by_credit_paise": 0,
            "sent_elsewhere_paise": 0,
        },
        "yet_to_pay": [],
        "backlog": [],
        "overpaid": [],
        "credit_moves": [],
    }


def test_dashboard_sections(api: TestClient) -> None:
    ananya = make_student(
        api,
        name="Ananya Rao",
        phone="90000 00001",
        batch_label="Mon/Wed 5pm",
        joined_month="2026-03",
    )["id"]
    kabir = make_student(api, name="Kabir Mehta", monthly_fee_paise=200000, joined_month="2026-04")[
        "id"
    ]
    meera = make_student(api, name="Meera Iyer", monthly_fee_paise=120000, joined_month="2026-05")[
        "id"
    ]
    # Ananya: March partial, April unpaid, May ₹500 over (it pays the rest of March, the
    # oldest month not fully paid), June paid, July paid ahead.
    pay(api, ananya, "2026-03", 100000)
    pay(api, ananya, "2026-05", 200000)
    pay(api, ananya, "2026-06")
    pay(api, ananya, "2026-07")
    # Kabir: all paid up to May, partial in June (two payments).
    for m in ("2026-04", "2026-05"):
        pay(api, kabir, m, 200000)
    pay(api, kabir, "2026-06", 50000)
    pay(api, kabir, "2026-06", 50000)
    # Meera: nothing paid.

    june = api.get("/api/dashboard", params={"month": "2026-06"}).json()
    assert june["summary"] == {
        "expected_paise": 150000 + 200000 + 120000,
        "collected_paise": 150000 + 100000,
        "paid_ahead_paise": 0,
        "still_due_paise": 100000 + 120000,
        "not_fully_paid_count": 2,
        "active_student_count": 3,
        "logged_paise": 150000 + 100000,
        "covered_by_credit_paise": 0,
        "sent_elsewhere_paise": 0,
    }
    assert june["yet_to_pay"] == [
        {
            "student_id": kabir,
            "student_name": "Kabir Mehta",
            "batch_label": None,
            "phone": None,
            "expected_paise": 200000,
            "paid_paise": 100000,
            "covered_by_credit_paise": 0,
            "remaining_paise": 100000,
            "status": "partial",
            "credit_paise": 0,
        },
        {
            "student_id": meera,
            "student_name": "Meera Iyer",
            "batch_label": None,
            "phone": None,
            "expected_paise": 120000,
            "paid_paise": 0,
            "covered_by_credit_paise": 0,
            "remaining_paise": 120000,
            "status": "unpaid",
            "credit_paise": 0,
        },
    ]
    assert june["backlog"] == [
        {
            "student_id": ananya,
            "student_name": "Ananya Rao",
            "batch_label": "Mon/Wed 5pm",
            "phone": "90000 00001",
            # March is paid in full now (₹1,000 for it + ₹500 of May's extra): only April.
            "months": [
                {
                    "month": "2026-04",
                    "expected_paise": 150000,
                    "paid_paise": 0,
                    "covered_by_credit_paise": 0,
                    "remaining_paise": 150000,
                    "status": "unpaid",
                },
            ],
            "total_owed_paise": 150000,
            "credit_paise": 0,  # May's extra was used, so it isn't credit
        },
        {
            "student_id": meera,
            "student_name": "Meera Iyer",
            "batch_label": None,
            "phone": None,
            "months": [
                {
                    "month": "2026-05",
                    "expected_paise": 120000,
                    "paid_paise": 0,
                    "covered_by_credit_paise": 0,
                    "remaining_paise": 120000,
                    "status": "unpaid",
                }
            ],
            "total_owed_paise": 120000,
            "credit_paise": 0,
        },
    ]
    # No money is left over anywhere, and nothing moved into or out of June.
    assert june["overpaid"] == []
    assert june["credit_moves"] == []

    # May: its payment was ₹500 over; the note says where that went.
    may = api.get("/api/dashboard", params={"month": "2026-05"}).json()
    [may_payment] = api.get(
        "/api/payments", params={"student_id": ananya, "month": "2026-05"}
    ).json()
    assert may["credit_moves"] == [
        {
            "student_id": ananya,
            "student_name": "Ananya Rao",
            "batch_label": "Mon/Wed 5pm",
            "phone": "90000 00001",
            "payment_id": may_payment["id"],
            "paid_on": "2026-05-05",
            "from_month": "2026-05",
            "to_month": "2026-03",
            "amount_paise": 50000,
            "payment_amount_paise": 200000,
            "payment_pays_until": "2026-05",
            "payment_needs_check": False,
        }
    ]
    # Collected for May counts only what pays May: ₹1,500 of Ananya's ₹2,000, and Kabir's. The
    # summary says why it differs from what was logged for May.
    assert may["summary"]["collected_paise"] == 150000 + 200000
    assert (may["summary"]["logged_paise"], may["summary"]["sent_elsewhere_paise"]) == (
        200000 + 200000,
        50000,
    )

    # March: collected counts May's ₹500 that covers it, so nothing is still due.
    march = api.get("/api/dashboard", params={"month": "2026-03"}).json()
    assert (march["summary"]["collected_paise"], march["summary"]["still_due_paise"]) == (
        150000,
        0,
    )
    assert (march["summary"]["logged_paise"], march["summary"]["covered_by_credit_paise"]) == (
        100000,
        50000,
    )
    assert [m["to_month"] for m in march["credit_moves"]] == ["2026-03"]

    # A past month: April. March is paid now, so nothing is owed from before April.
    april = api.get("/api/dashboard", params={"month": "2026-04"}).json()
    assert april["summary"]["active_student_count"] == 2
    assert [i["student_id"] for i in april["yet_to_pay"]] == [ananya]
    assert april["backlog"] == []
    assert april["overpaid"] == []

    # A future month: July. Ananya paid ahead, so she isn't listed as yet to pay.
    july = api.get("/api/dashboard", params={"month": "2026-07"}).json()
    assert july["summary"]["collected_paise"] == 150000
    assert [i["student_id"] for i in july["yet_to_pay"]] == [kabir, meera]
    assert [(b["student_id"], b["total_owed_paise"]) for b in july["backlog"]] == [
        (ananya, 150000),
        (kabir, 100000),
        (meera, 240000),
    ]
    assert july["overpaid"] == []


def test_bad_month_is_422(api: TestClient) -> None:
    assert api.get("/api/dashboard", params={"month": "June"}).status_code == 422


def test_current_month_comes_from_the_clock(client: TestClient) -> None:
    today = dt.date.today()
    assert get_current_month(get_today()) == today.replace(day=1)
    assert client.get("/api/dashboard").json()["month"] == today.strftime("%Y-%m")
