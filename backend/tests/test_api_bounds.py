"""Sanity limits on input (app/services/bounds.py), Unicode-aware search and sort, and the
computed student fields. "Today" is frozen at 2026-06-15 (see conftest)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from helpers import Json, make_student, pay

PAYMENT = {"amount_paise": 100, "paid_on": "2026-06-01", "for_month": "2026-06", "method": "upi"}


def error(response: object) -> tuple[list[str], str]:
    assert response.status_code == 422, response.text  # type: ignore[attr-defined]
    [item] = response.json()["detail"]  # type: ignore[attr-defined]
    return item["loc"], item["msg"]


# --------------------------------------------------------------------------- months


@pytest.mark.parametrize("month", ["1999-12", "2100-01", "0000-05", "9999-12", "2206-09"])
def test_months_outside_2000_to_2099_are_422(api: TestClient, month: str) -> None:
    s = make_student(api)
    assert api.get("/api/dashboard", params={"month": month}).status_code == 422
    assert api.get("/api/payments", params={"month": month}).status_code == 422
    body = {"name": "A", "monthly_fee_paise": 1, "joined_month": month}
    assert error(api.post("/api/students", json=body))[0] == ["body", "joined_month"]
    response = api.post(
        "/api/payments", json={**PAYMENT, "student_id": s["id"], "for_month": month}
    )
    assert error(response)[0] == ["body", "for_month"]


def test_for_month_at_most_24_months_ahead(api: TestClient) -> None:
    s = make_student(api)
    ok = api.post("/api/payments", json={**PAYMENT, "student_id": s["id"], "for_month": "2028-06"})
    assert ok.status_code == 201
    response = api.post(
        "/api/payments", json={**PAYMENT, "student_id": s["id"], "for_month": "2028-07"}
    )
    assert error(response) == (
        ["body", "for_month"],
        "Month can't be later than June 2028 (two years from now)",
    )
    response = api.patch(f"/api/payments/{ok.json()['id']}", json={"for_month": "2030-01"})
    assert error(response)[0] == ["body", "for_month"]
    assert api.get(f"/api/payments/{ok.json()['id']}").json()["for_month"] == "2028-06"


@pytest.mark.parametrize("field", ["joined_month", "left_month"])
def test_student_months_at_most_24_months_ahead(api: TestClient, field: str) -> None:
    body = {"name": "A", "monthly_fee_paise": 1, "joined_month": "2026-01", field: "2028-07"}
    assert error(api.post("/api/students", json=body))[0] == ["body", field]
    s = make_student(api)
    assert error(api.patch(f"/api/students/{s['id']}", json={field: "2028-07"}))[0] == [
        "body",
        field,
    ]
    assert api.patch(f"/api/students/{s['id']}", json={"left_month": "2028-06"}).status_code == 200


def test_fee_effective_month_at_most_24_months_ahead(api: TestClient) -> None:
    s = make_student(api)
    response = api.patch(
        f"/api/students/{s['id']}",
        json={"monthly_fee_paise": 1, "fee_effective_month": "2028-07"},
    )
    assert error(response)[0] == ["body", "fee_effective_month"]


# --------------------------------------------------------------------------- paid_on


@pytest.mark.parametrize(
    ("paid_on", "ok"),
    [
        ("1999-12-31", False),
        ("2000-01-01", True),
        ("2026-06-16", True),  # tomorrow: a laptop clock may be a little behind
        ("2026-06-17", False),
        ("9999-12-31", False),
    ],
)
def test_paid_on_window(api: TestClient, paid_on: str, ok: bool) -> None:
    s = make_student(api)
    response = api.post(
        "/api/payments", json={**PAYMENT, "student_id": s["id"], "paid_on": paid_on}
    )
    if ok:
        assert response.status_code == 201
    else:
        assert error(response)[0] == ["body", "paid_on"]
        p = pay(api, s["id"], "2026-06")
        assert error(api.patch(f"/api/payments/{p['id']}", json={"paid_on": paid_on}))[0] == [
            "body",
            "paid_on",
        ]


# --------------------------------------------------------------------------- ids and amounts

HUGE = 10**20


def test_huge_ids_are_not_found(api: TestClient) -> None:
    for method, path in [
        ("get", f"/api/students/{HUGE}"),
        ("patch", f"/api/students/{HUGE}"),
        ("delete", f"/api/students/{HUGE}"),
        ("get", f"/api/students/{HUGE}/suggest-payment"),
        ("get", f"/api/payments/{HUGE}"),
        ("patch", f"/api/payments/{HUGE}"),
        ("delete", f"/api/payments/{HUGE}"),
    ]:
        response = api.request(method, path, json={} if method == "patch" else None)
        assert response.status_code == 404, (method, path)
    assert api.get("/api/payments", params={"student_id": HUGE}).json() == []
    response = api.post("/api/payments", json={**PAYMENT, "student_id": HUGE})
    assert response.status_code == 404


def test_huge_amounts_are_422(api: TestClient) -> None:
    s = make_student(api)
    response = api.post(
        "/api/payments", json={**PAYMENT, "student_id": s["id"], "amount_paise": HUGE}
    )
    assert error(response)[0] == ["body", "amount_paise"]
    body = {"name": "A", "monthly_fee_paise": HUGE, "joined_month": "2026-01"}
    assert error(api.post("/api/students", json=body))[0] == ["body", "monthly_fee_paise"]


# --------------------------------------------------------------------------- unicode


def test_search_and_sort_ignore_case_and_accents(api: TestClient) -> None:
    names = ["Zara Khan", "Émile Ölund", "anika Rao", "Eshan Iyer"]
    for name in names:
        s = make_student(api, name=name)
        pay(api, s["id"], "2026-06", note="Café" if name.startswith("Z") else None)

    students = [s["name"] for s in api.get("/api/students").json()]
    assert students == ["anika Rao", "Émile Ölund", "Eshan Iyer", "Zara Khan"]
    by_student = api.get("/api/payments", params={"sort": "student", "order": "asc"}).json()
    assert [p["student_name"] for p in by_student] == students

    def found(q: str) -> list[str]:
        return [p["student_name"] for p in api.get("/api/payments", params={"q": q}).json()]

    assert found("ölund") == ["Émile Ölund"]
    assert found("OLUND") == ["Émile Ölund"]
    assert found("emile") == ["Émile Ölund"]
    assert found("cafe") == ["Zara Khan"]  # note
    assert [s["name"] for s in api.get("/api/students", params={"q": "EMILE"}).json()] == [
        "Émile Ölund"
    ]


# --------------------------------------------------------------------------- computed fields


def test_student_computed_fields(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-03")
    pay(api, s["id"], "2026-03", 200000)  # 500 over
    pay(api, s["id"], "2026-07", 150000)  # paid ahead: not credit
    for row in (api.get(f"/api/students/{s['id']}").json(), api.get("/api/students").json()[0]):
        assert row["current_month"] == "2026-06"
        assert row["tenure_months"] == 4  # March to June
        assert row["credit_paise"] == 50000
        # Balance still counts everything: 350000 paid - 4 x 150000 due.
        assert row["balance_paise"] == -250000
    future = make_student(api, name="Kabir Mehta", joined_month="2026-08")
    assert future["tenure_months"] == 0


@pytest.mark.parametrize("body", [{"name": None}, {"monthly_fee_paise": None}])
def test_explicit_null_names_the_field(api: TestClient, body: Json) -> None:
    s = make_student(api)
    [field] = body
    assert error(api.patch(f"/api/students/{s['id']}", json=body))[0] == ["body", field]


# --------------------------------------------------------------------------- odd JSON values


def send_raw(api: TestClient, method: str, path: str, raw: str) -> object:
    headers = {"content-type": "application/json"}
    return api.request(method, path, content=raw.encode(), headers=headers)


@pytest.mark.parametrize("number", ["NaN", "Infinity", "-Infinity", "1e400"])
def test_non_finite_numbers_are_422(api: TestClient, number: str) -> None:
    s = make_student(api)
    raw = (
        f'{{"student_id": {s["id"]}, "amount_paise": {number}, "paid_on": "2026-06-01",'
        ' "for_month": "2026-06", "method": "upi"}'
    )
    assert error(send_raw(api, "post", "/api/payments", raw))[0] == ["body", "amount_paise"]
    raw = f'{{"monthly_fee_paise": {number}}}'
    path = f"/api/students/{s['id']}"
    assert error(send_raw(api, "patch", path, raw))[0] == ["body", "monthly_fee_paise"]


@pytest.mark.parametrize(
    ("field", "value"),
    [("name", "\x00"), ("name", "x\x00"), ("phone", "90000\x0000001"), ("notes", "a\x07b")],
)
def test_control_characters_are_422(api: TestClient, field: str, value: str) -> None:
    s = make_student(api)
    loc, msg = error(api.patch(f"/api/students/{s['id']}", json={field: value}))
    assert (loc, msg) == (["body", field], "This text has a character that can't be saved")
    p = pay(api, s["id"], "2026-06")
    assert error(api.patch(f"/api/payments/{p['id']}", json={"note": value}))[0] == [
        "body",
        "note",
    ]


def test_tabs_and_line_breaks_are_fine(api: TestClient) -> None:
    s = make_student(api, notes="Line one\nLine two\r\n\tindented")
    assert s["notes"] == "Line one\nLine two\r\n\tindented"


@pytest.mark.parametrize("field", ["student_id", "amount_paise"])
@pytest.mark.parametrize("value", [True, 1.5, "100"])
def test_ids_and_amounts_must_be_whole_numbers(api: TestClient, field: str, value: object) -> None:
    s = make_student(api)
    body = {**PAYMENT, "student_id": s["id"], field: value}
    assert error(api.post("/api/payments", json=body))[0] == ["body", field]
    fee = {"name": "A", "monthly_fee_paise": value, "joined_month": "2026-01"}
    assert error(api.post("/api/students", json=fee))[0] == ["body", "monthly_fee_paise"]
