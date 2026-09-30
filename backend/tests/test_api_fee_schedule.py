"""API tests: coming back after leaving (`POST /students/{id}/return`) and removing a scheduled
fee change (`DELETE /students/{id}/fee-changes/{fee_change_id}`). The current month is frozen at
June 2026 (see conftest)."""

from __future__ import annotations

from fastapi.testclient import TestClient
from helpers import Json, make_student, months_of, pay


def fees_of(detail: Json) -> list[tuple[str, int]]:
    return [(f["effective_month"], f["amount_paise"]) for f in detail["fee_history"]]


def come_back(api: TestClient, student_id: int, from_month: str) -> Json:
    response = api.post(f"/api/students/{student_id}/return", json={"from_month": from_month})
    assert response.status_code == 200, response.text
    return response.json()


def set_fee(api: TestClient, student_id: int, amount: int, month: str) -> Json:
    response = api.patch(
        f"/api/students/{student_id}",
        json={"monthly_fee_paise": amount, "fee_effective_month": month},
    )
    assert response.status_code == 200, response.text
    return response.json()


# --------------------------------------------------------------------------- coming back


def test_coming_back_never_makes_the_months_away_owed(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-01", left_month="2026-02")
    pay(api, s["id"], "2026-01")
    pay(api, s["id"], "2026-02")

    d = come_back(api, s["id"], "2026-05")

    assert d["left_month"] is None and d["is_active"] is True
    assert fees_of(d) == [("2026-01", 150000), ("2026-03", 0), ("2026-05", 150000)]
    assert months_of(d) == {
        "2026-01": (150000, 150000, "paid"),
        "2026-02": (150000, 150000, "paid"),
        "2026-03": (0, 0, "not_applicable"),  # away: no fee, never owed
        "2026-04": (0, 0, "not_applicable"),
        "2026-05": (150000, 0, "unpaid"),
        "2026-06": (150000, 0, "unpaid"),
    }
    assert (d["status"], d["owed_paise"], d["monthly_fee_paise"]) == ("owes", 300000, 150000)
    # The dashboard agrees: nothing owed from the months away.
    board = api.get("/api/dashboard").json()
    [backlog] = board["backlog"]
    assert [m["month"] for m in backlog["months"]] == ["2026-05"]


def test_back_the_month_after_leaving_adds_no_fee_change(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-01", left_month="2026-03")
    d = come_back(api, s["id"], "2026-04")
    assert d["left_month"] is None
    assert fees_of(d) == [("2026-01", 150000)]
    assert d["owed_paise"] == 6 * 150000  # every month, as if they never left


def test_coming_back_in_a_later_month(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-01", left_month="2026-03")
    for m in ("2026-01", "2026-02", "2026-03"):
        pay(api, s["id"], m)
    d = come_back(api, s["id"], "2026-08")
    assert fees_of(d) == [("2026-01", 150000), ("2026-04", 0), ("2026-08", 150000)]
    assert (d["status"], d["owed_paise"]) == ("up_to_date", 0)
    suggestion = api.get(f"/api/students/{s['id']}/suggest-payment").json()
    # Not July (away, no fee): August, when they're back.
    assert suggestion == {"for_month": "2026-08", "amount_paise": 150000, "reason": "next_unpaid"}


def test_fee_changes_already_set_after_leaving(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-01", left_month="2026-02")
    set_fee(api, s["id"], 180000, "2026-04")  # a raise set before they left, in the gap
    set_fee(api, s["id"], 200000, "2026-09")  # and another after they're back
    d = come_back(api, s["id"], "2026-05")
    # The gap's raise is replaced by the 0 fee, and is the fee they come back on; the later
    # change is kept.
    assert fees_of(d) == [
        ("2026-01", 150000),
        ("2026-03", 0),
        ("2026-05", 180000),
        ("2026-09", 200000),
    ]


def test_a_fee_change_in_the_return_month_is_kept(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-01", left_month="2026-02")
    set_fee(api, s["id"], 180000, "2026-05")
    before = {
        f["effective_month"]: f["id"]
        for f in api.get(f"/api/students/{s['id']}").json()["fee_history"]
    }
    d = come_back(api, s["id"], "2026-05")
    assert fees_of(d) == [("2026-01", 150000), ("2026-03", 0), ("2026-05", 180000)]
    assert {f["effective_month"]: f["id"] for f in d["fee_history"]}["2026-05"] == before["2026-05"]


def test_a_payment_for_a_month_away_is_extra(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-01", left_month="2026-02")
    pay(api, s["id"], "2026-03")  # logged for a month they were away
    d = come_back(api, s["id"], "2026-06")
    assert months_of(d)["2026-03"] == (0, 150000, "overpaid")
    assert d["credit_paise"] == 150000


def test_coming_back_for_a_student_still_leaving(api: TestClient) -> None:
    # Leaving after July (not left yet): back from August is the same as staying.
    s = make_student(api, joined_month="2026-01", left_month="2026-07")
    d = come_back(api, s["id"], "2026-08")
    assert d["left_month"] is None
    assert fees_of(d) == [("2026-01", 150000)]


def test_coming_back_validation(api: TestClient) -> None:
    staying = make_student(api, joined_month="2026-01")
    left = make_student(api, name="Kabir Mehta", joined_month="2026-01", left_month="2026-03")
    too_early = "They can only be back from April 2026 on, the month after they left"
    too_late = "The month they're back from can't be later than June 2028 (two years from now)"
    cases = [
        (staying["id"], "2026-06", "They haven't been marked as left"),
        (left["id"], "2026-03", too_early),
        (left["id"], "2026-01", too_early),
        (left["id"], "2028-07", too_late),
    ]
    for student_id, month, msg in cases:
        response = api.post(f"/api/students/{student_id}/return", json={"from_month": month})
        assert response.status_code == 422, (month, response.text)
        [item] = response.json()["detail"]
        assert (item["loc"], item["msg"]) == (["body", "from_month"], msg)
    # Nothing changed.
    after = api.get(f"/api/students/{left['id']}").json()
    assert after["left_month"] == "2026-03"
    assert fees_of(after) == [("2026-01", 150000)]

    for body in (
        {},
        {"from_month": "2026-13"},
        {"from_month": None},
        {"from_month": "2026-06", "x": 1},
    ):
        assert api.post(f"/api/students/{left['id']}/return", json=body).status_code == 422
    missing = api.post("/api/students/99/return", json={"from_month": "2026-06"})
    assert (missing.status_code, missing.json()) == (404, {"detail": "No student with id 99"})


# --------------------------------------------------------------------------- removing a fee change


def test_removing_a_scheduled_fee_change(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-01")
    d = set_fee(api, s["id"], 180000, "2026-08")
    scheduled = d["fee_history"][1]
    response = api.delete(f"/api/students/{s['id']}/fee-changes/{scheduled['id']}")
    assert response.status_code == 204
    assert response.content == b""
    after = api.get(f"/api/students/{s['id']}").json()
    assert fees_of(after) == [("2026-01", 150000)]
    pay(api, s["id"], "2026-08", 150000)
    assert months_of(api.get(f"/api/students/{s['id']}").json())["2026-08"] == (
        150000,
        150000,
        "paid",
    )


def test_removing_a_scheduled_change_brings_back_the_fee_before_it(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-01")
    set_fee(api, s["id"], 0, "2026-09")  # a month off, set in advance
    d = set_fee(api, s["id"], 150000, "2026-10")
    zero = next(f for f in d["fee_history"] if f["effective_month"] == "2026-09")
    assert api.delete(f"/api/students/{s['id']}/fee-changes/{zero['id']}").status_code == 204
    # 1,500 from January, and a leftover 1,500 from October: September is 1,500 again.
    after = api.get(f"/api/students/{s['id']}").json()
    assert fees_of(after) == [("2026-01", 150000), ("2026-10", 150000)]


def test_the_first_fee_and_started_fees_cant_be_removed(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-01")
    set_fee(api, s["id"], 160000, "2026-03")  # already started
    d = set_fee(api, s["id"], 170000, "2026-06")  # starts this month
    first, past, now = d["fee_history"]
    for fee, msg in [
        (first, "The first fee can't be removed. To change it, use Edit."),
        (past, "Only a fee change that hasn't started yet can be removed. To change a fee that "
               "has started, set a new fee with Edit."),
        (now, "Only a fee change that hasn't started yet can be removed. To change a fee that "
              "has started, set a new fee with Edit."),
    ]:  # fmt: skip
        response = api.delete(f"/api/students/{s['id']}/fee-changes/{fee['id']}")
        assert response.status_code == 422
        [item] = response.json()["detail"]
        assert (item["loc"], item["msg"]) == (["path", "fee_change_id"], msg)
    assert len(api.get(f"/api/students/{s['id']}").json()["fee_history"]) == 3


def test_the_first_fee_of_a_future_joiner_cant_be_removed(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-09")
    [first] = s["fee_history"]
    response = api.delete(f"/api/students/{s['id']}/fee-changes/{first['id']}")
    assert response.status_code == 422


def test_removing_another_students_fee_change_is_404(api: TestClient) -> None:
    a = make_student(api, joined_month="2026-01")
    b = make_student(api, name="Kabir Mehta", joined_month="2026-01")
    theirs = set_fee(api, b["id"], 180000, "2026-09")["fee_history"][1]
    response = api.delete(f"/api/students/{a['id']}/fee-changes/{theirs['id']}")
    assert response.status_code == 404
    assert response.json() == {"detail": f"No fee change with id {theirs['id']}"}
    assert len(api.get(f"/api/students/{b['id']}").json()["fee_history"]) == 2
    assert api.delete("/api/students/99/fee-changes/1").status_code == 404
    assert api.delete(f"/api/students/{a['id']}/fee-changes/{2**70}").status_code in (404, 422)
