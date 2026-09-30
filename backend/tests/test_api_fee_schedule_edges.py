"""Edge cases of coming back and fee changes: coming back more than once, a payment for a month
away still to come, a fee from a later month, two clicks at once, and a database clash. The
current month is frozen at June 2026 (see conftest)."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from helpers import Json, make_student, months_of, pay
from sqlalchemy.exc import IntegrityError

from app.errors import CLASH_MESSAGE
from app.services import students as students_service


def fees_of(detail: Json) -> list[tuple[str, int]]:
    return [(f["effective_month"], f["amount_paise"]) for f in detail["fee_history"]]


def come_back(api: TestClient, student_id: int, from_month: str) -> Json:
    response = api.post(f"/api/students/{student_id}/return", json={"from_month": from_month})
    assert response.status_code == 200, response.text
    return response.json()


def test_leave_come_back_leave_again_at_the_same_month_come_back_straight_away(
    api: TestClient,
) -> None:
    s = make_student(api, monthly_fee_paise=200000, joined_month="2026-01", left_month="2026-03")
    come_back(api, s["id"], "2026-05")  # away in April
    assert api.patch(f"/api/students/{s['id']}", json={"left_month": "2026-03"}).status_code == 200
    # Back straight after leaving again: the earlier return's ₹0 April must not become the fee.
    d = come_back(api, s["id"], "2026-04")
    assert fees_of(d) == [("2026-01", 200000), ("2026-04", 200000), ("2026-05", 200000)]
    assert [m["status"] for m in d["months"][3:]] == ["unpaid", "unpaid", "unpaid"]
    assert d["owed_paise"] == 6 * 200000


def test_coming_back_again_ignores_the_months_away_of_an_earlier_return(api: TestClient) -> None:
    s = make_student(api, monthly_fee_paise=200000, joined_month="2026-01", left_month="2026-03")
    for m in ("2026-01", "2026-02", "2026-03"):
        pay(api, s["id"], m, 200000)
    come_back(api, s["id"], "2026-07")  # ₹0 from April, ₹2,000 from July
    api.patch(f"/api/students/{s['id']}", json={"left_month": "2026-03"})
    d = come_back(api, s["id"], "2026-05")
    assert months_of(d)["2026-04"] == (0, 0, "not_applicable")
    assert months_of(d)["2026-05"] == (200000, 0, "unpaid")
    assert months_of(d)["2026-06"] == (200000, 0, "unpaid")
    assert d["owed_paise"] == 400000


def test_coming_back_on_a_different_fee(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-01", left_month="2026-02")
    url = f"/api/students/{s['id']}/return"
    too_big = api.post(url, json={"from_month": "2026-05", "monthly_fee_paise": 100000001})
    assert too_big.status_code == 422
    response = api.post(url, json={"from_month": "2026-05", "monthly_fee_paise": 250000})
    assert response.status_code == 200
    assert fees_of(response.json()) == [("2026-01", 150000), ("2026-03", 0), ("2026-05", 250000)]


def test_a_payment_for_a_month_away_still_to_come_is_extra_not_paid_ahead(
    api: TestClient,
) -> None:
    s = make_student(api, monthly_fee_paise=100000, joined_month="2026-01", left_month="2026-05")
    for m in ("2026-01", "2026-02", "2026-03", "2026-04", "2026-05"):
        pay(api, s["id"], m, 100000)
    come_back(api, s["id"], "2026-09")  # away June to August
    pay(api, s["id"], "2026-08", 100000)  # a month away, still to come
    d = api.get(f"/api/students/{s['id']}").json()
    assert months_of(d)["2026-08"] == (0, 100000, "overpaid")
    assert (d["paid_ahead_paise"], d["credit_paise"], d["status"]) == (0, 100000, "credit")
    # A later month they're enrolled in counts as paid ahead only up to its fee.
    pay(api, s["id"], "2026-09", 150000)
    d = api.get(f"/api/students/{s['id']}").json()
    assert (d["paid_ahead_paise"], d["credit_paise"]) == (100000, 150000)


def test_no_fee_now_then_a_fee_later(api: TestClient) -> None:
    s = make_student(api, monthly_fee_paise=100000, joined_month="2026-01", left_month="2026-02")
    d = come_back(api, s["id"], "2026-12")
    assert d["monthly_fee_paise"] == 0
    nxt = d["next_fee_change"]
    assert (nxt["effective_month"], nxt["amount_paise"]) == ("2026-12", 100000)
    [listed] = [x for x in api.get("/api/students").json() if x["id"] == s["id"]]
    assert listed["next_fee_change"]["effective_month"] == "2026-12"
    assert make_student(api, name="Kabir Mehta")["next_fee_change"] is None
    # The dashboard counts only students with a fee due this month.
    board = api.get("/api/dashboard").json()
    assert board["summary"]["active_student_count"] == 1  # Kabir


def test_two_clicks_at_once_come_back_once(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-01", left_month="2026-02")

    def click(_: int) -> int:
        response = api.post(f"/api/students/{s['id']}/return", json={"from_month": "2026-05"})
        return response.status_code

    with ThreadPoolExecutor(max_workers=6) as pool:
        codes = sorted(pool.map(click, range(6)))
    assert codes == [200, 422, 422, 422, 422, 422]
    d = api.get(f"/api/students/{s['id']}").json()
    assert fees_of(d) == [("2026-01", 150000), ("2026-03", 0), ("2026-05", 150000)]


def test_fee_changes_at_once_never_500(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-01")

    def change(amount: int) -> int:
        return api.patch(
            f"/api/students/{s['id']}",
            json={"monthly_fee_paise": amount, "fee_effective_month": "2026-09"},
        ).status_code

    with ThreadPoolExecutor(max_workers=6) as pool:
        codes = list(pool.map(change, [160000 + i for i in range(6)]))
    assert codes == [200] * 6
    [_, sep] = api.get(f"/api/students/{s['id']}").json()["fee_history"]
    assert sep["effective_month"] == "2026-09"

    later = api.get(f"/api/students/{s['id']}").json()["fee_history"][1]["id"]
    url = f"/api/students/{s['id']}/fee-changes/{later}"
    with ThreadPoolExecutor(max_workers=4) as pool:
        removed = sorted(pool.map(lambda _: api.delete(url).status_code, range(4)))
    assert removed == [204, 404, 404, 404]


def test_no_500_from_changes_at_the_same_moment(api: TestClient) -> None:
    """Many changes to one student at once (double clicks, two tabs): never a 500."""
    s = make_student(api, joined_month="2026-01", left_month="2026-02")
    sid = s["id"]
    fee = {"monthly_fee_paise": 1, "fee_effective_month": "2026-09"}
    payment = {"student_id": sid, "amount_paise": 100, "paid_on": "2026-06-01",
               "for_month": "2026-06", "method": "cash"}  # fmt: skip
    calls: list[tuple[str, str, Json | None]] = [
        ("post", f"/api/students/{sid}/return", {"from_month": "2026-05"}),
        ("post", f"/api/students/{sid}/return", {"from_month": "2026-04"}),
        ("patch", f"/api/students/{sid}", fee),
        ("patch", f"/api/students/{sid}", {**fee, "monthly_fee_paise": 2}),
        ("patch", f"/api/students/{sid}", {"left_month": "2026-03"}),
        ("delete", f"/api/students/{sid}/fee-changes/{s['fee_history'][0]['id'] + 1}", None),
        ("post", "/api/payments", payment),
    ] * 6

    def call(c: tuple[str, str, Json | None]) -> int:
        return api.request(c[0], c[1], json=c[2]).status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        codes = list(pool.map(call, calls))
    assert all(code < 500 for code in codes), codes


def test_a_clash_in_the_database_is_a_plain_409(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def clash(*_args: object) -> None:
        raise IntegrityError("INSERT ...", None, Exception("UNIQUE constraint failed"))

    monkeypatch.setattr(students_service, "delete_fee_change", clash)
    response = api.delete("/api/students/1/fee-changes/1")
    assert response.status_code == 409
    assert response.json() == {"detail": CLASH_MESSAGE}
