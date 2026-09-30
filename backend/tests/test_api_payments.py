"""API tests: /api/payments."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from helpers import Json, make_student, pay


def test_create_and_read(api: TestClient) -> None:
    s = make_student(api, name="Kabir Mehta")
    p = pay(api, s["id"], "2026-03", 150000, paid_on="2026-03-02", method="cash", note="  ")
    assert p == {
        "id": p["id"],
        "student_id": s["id"],
        "student_name": "Kabir Mehta",
        "amount_paise": 150000,
        "paid_on": "2026-03-02",
        "for_month": "2026-03",
        "method": "cash",
        "note": None,
        # Exactly March's fee: all of it pays March.
        "paid_direct_paise": 150000,
        "needs_check": False,
        "months_ahead": 0,
        "extra_sent": [],
        "extra_unused_paise": 0,
        "created_at": p["created_at"],
        "updated_at": p["updated_at"],
    }
    assert api.get(f"/api/payments/{p['id']}").json() == p


def test_create_for_missing_student_is_404(api: TestClient) -> None:
    response = api.post(
        "/api/payments",
        json={
            "student_id": 42,
            "amount_paise": 100,
            "paid_on": "2026-01-05",
            "for_month": "2026-01",
            "method": "upi",
        },
    )
    assert response.status_code == 404
    assert response.json() == {"detail": "No student with id 42"}


@pytest.mark.parametrize(
    "change",
    [
        {"amount_paise": 0},
        {"amount_paise": -100},
        {"for_month": "2026-1"},
        {"for_month": None},
        {"paid_on": "2026-02-30"},
        {"method": "cheque"},
        {"student_id": 0},
        {"extra": True},
    ],
)
def test_create_validation(api: TestClient, change: Json) -> None:
    s = make_student(api)
    body = {
        "student_id": s["id"],
        "amount_paise": 100,
        "paid_on": "2026-01-05",
        "for_month": "2026-01",
        "method": "upi",
        **change,
    }
    assert api.post("/api/payments", json=body).status_code == 422


def test_missing_payment_is_404(api: TestClient) -> None:
    assert api.get("/api/payments/7").json() == {"detail": "No payment with id 7"}
    assert api.patch("/api/payments/7", json={"note": "x"}).status_code == 404
    assert api.delete("/api/payments/7").status_code == 404


def test_update_is_partial(api: TestClient) -> None:
    a = make_student(api, name="Ananya Rao")
    b = make_student(api, name="Kabir Mehta")
    p = pay(api, a["id"], "2026-01", note="first")
    url = f"/api/payments/{p['id']}"

    u = api.patch(url, json={"amount_paise": 120000, "for_month": "2026-02"}).json()
    assert (u["amount_paise"], u["for_month"], u["note"], u["method"]) == (
        120000,
        "2026-02",
        "first",
        "upi",
    )
    u = api.patch(url, json={"student_id": b["id"], "note": None, "method": "other"}).json()
    assert (u["student_id"], u["student_name"], u["note"], u["method"]) == (
        b["id"],
        "Kabir Mehta",
        None,
        "other",
    )
    u = api.patch(url, json={"paid_on": "2026-02-10"}).json()
    assert u["paid_on"] == "2026-02-10"
    assert api.get(url).json() == u

    # The ledger follows the payment to its new student and month.
    detail = api.get(f"/api/students/{b['id']}").json()
    feb = next(m for m in detail["months"] if m["month"] == "2026-02")
    assert (feb["paid_paise"], feb["status"]) == (120000, "partial")
    assert api.get(f"/api/students/{a['id']}").json()["payment_count"] == 0


@pytest.mark.parametrize(
    "body",
    [{"student_id": 999}, {"amount_paise": None}, {"amount_paise": 0}, {"method": None}, {"x": 1}],
)
def test_update_validation(api: TestClient, body: Json) -> None:
    s = make_student(api)
    p = pay(api, s["id"], "2026-01")
    expected = 404 if "student_id" in body else 422
    assert api.patch(f"/api/payments/{p['id']}", json=body).status_code == expected
    assert api.get(f"/api/payments/{p['id']}").json() == p


def test_delete(api: TestClient) -> None:
    s = make_student(api)
    p = pay(api, s["id"], "2026-01")
    response = api.delete(f"/api/payments/{p['id']}")
    assert response.status_code == 204
    assert response.content == b""
    assert api.get(f"/api/payments/{p['id']}").status_code == 404
    assert api.get(f"/api/students/{s['id']}").json()["payment_count"] == 0


# --------------------------------------------------------------------------- list


@pytest.fixture
def book(api: TestClient) -> dict[str, int]:
    """Three students and six payments."""
    ananya = make_student(api, name="Ananya Rao")["id"]
    kabir = make_student(api, name="kabir Mehta")["id"]
    zara = make_student(api, name="Zara Khan")["id"]
    ids = {
        "a1": pay(api, ananya, "2026-01", 150000, paid_on="2026-01-03", method="upi")["id"],
        "a2": pay(api, ananya, "2026-02", 150000, paid_on="2026-02-04", method="cash")["id"],
        "k1": pay(
            api,
            kabir,
            "2026-01",
            90000,
            paid_on="2026-01-20",
            method="other",
            note="Half, rest later",
        )["id"],
        "k2": pay(api, kabir, "2026-03", 250000, paid_on="2026-02-04", method="upi")["id"],
        "z1": pay(api, zara, "2026-02", 50000, paid_on="2026-03-01", method="cash", note="100%")[
            "id"
        ],
        "z2": pay(api, zara, "2026-02", 100000, paid_on="2026-03-01", method="upi")["id"],
    }
    return {"ananya": ananya, "kabir": kabir, "zara": zara, **ids}


def ids(api: TestClient, **params: object) -> list[int]:
    response = api.get("/api/payments", params=params)
    assert response.status_code == 200, response.text
    return [p["id"] for p in response.json()]


def test_default_sort_is_newest_paid_on_first(api: TestClient, book: dict[str, int]) -> None:
    # Ties on paid_on: the newest entry first.
    b = book
    assert ids(api) == [b["z2"], b["z1"], b["k2"], b["a2"], b["k1"], b["a1"]]
    assert ids(api, order="asc") == [b["a1"], b["k1"], b["k2"], b["a2"], b["z2"], b["z1"]]


@pytest.mark.parametrize(
    ("sort", "order", "expected"),
    [
        ("amount", "asc", ["z1", "k1", "z2", "a2", "a1", "k2"]),
        ("amount", "desc", ["k2", "a2", "a1", "z2", "k1", "z1"]),
        ("for_month", "asc", ["k1", "a1", "z2", "z1", "a2", "k2"]),
        ("for_month", "desc", ["k2", "z2", "z1", "a2", "k1", "a1"]),
        # By name, ignoring case; within a student, the latest paid_on first.
        ("student", "asc", ["a2", "a1", "k2", "k1", "z2", "z1"]),
        ("student", "desc", ["z2", "z1", "k2", "k1", "a2", "a1"]),
        ("method", "asc", ["z1", "a2", "k1", "z2", "k2", "a1"]),
        ("paid_on", "desc", ["z2", "z1", "k2", "a2", "k1", "a1"]),
    ],
)
def test_sorting(
    api: TestClient, book: dict[str, int], sort: str, order: str, expected: list[str]
) -> None:
    assert ids(api, sort=sort, order=order) == [book[k] for k in expected]


def test_filters_and_search(api: TestClient, book: dict[str, int]) -> None:
    b = book
    assert set(ids(api, student_id=b["kabir"])) == {b["k1"], b["k2"]}
    assert set(ids(api, month="2026-02")) == {b["a2"], b["z1"], b["z2"]}
    assert ids(api, month="2026-02", student_id=b["zara"], sort="amount", order="asc") == [
        b["z1"],
        b["z2"],
    ]
    assert set(ids(api, q="KABIR")) == {b["k1"], b["k2"]}
    assert ids(api, q="rest later") == [b["k1"]]  # note
    assert ids(api, q="100%") == [b["z1"]]  # % is matched literally
    assert ids(api, q="_") == []
    assert set(ids(api, q="rao", month="2026-01")) == {b["a1"]}
    assert ids(api, q="nobody") == []
    assert ids(api, student_id=999) == []
    assert len(ids(api, q="  ")) == 6


@pytest.mark.parametrize(
    "params",
    [{"sort": "note"}, {"order": "up"}, {"month": "2026-13"}, {"student_id": 0}],
)
def test_list_validation(api: TestClient, params: Json) -> None:
    assert api.get("/api/payments", params=params).status_code == 422


def test_amount_cap(api: TestClient) -> None:
    """Rs 10,00,000 (100000000 paise) is the most one payment or monthly fee can be."""
    s = make_student(api, monthly_fee_paise=100_000_000)
    assert s["monthly_fee_paise"] == 100_000_000
    p = pay(api, s["id"], "2026-01", 100_000_000)
    too_much = {"amount_paise": 100_000_001}
    response = api.patch(f"/api/payments/{p['id']}", json=too_much)
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "amount_paise"]
    body = {"student_id": s["id"], "paid_on": "2026-01-05", "for_month": "2026-01", "method": "upi"}
    assert api.post("/api/payments", json={**body, **too_much}).status_code == 422
    fee = api.patch(f"/api/students/{s['id']}", json={"monthly_fee_paise": 100_000_001})
    assert fee.status_code == 422
    assert fee.json()["detail"][0]["loc"] == ["body", "monthly_fee_paise"]
