"""API tests: /api/students (the current month is frozen at June 2026; see conftest)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from helpers import Json, make_student, months_of, pay

# --------------------------------------------------------------------------- create / read


def test_create_returns_detail_with_first_fee_change(api: TestClient) -> None:
    s = make_student(
        api,
        name="  Kabir Mehta ",
        phone="98765 43210",
        guardian_name="",
        batch_label="Sat 10am - Jayanagar Studio",
        joined_month="2026-04",
    )
    assert s["name"] == "Kabir Mehta"
    assert s["guardian_name"] is None
    assert s["joined_month"] == "2026-04"
    assert s["left_month"] is None
    assert s["is_active"] is True
    assert s["monthly_fee_paise"] == 150000
    assert [(f["effective_month"], f["amount_paise"]) for f in s["fee_history"]] == [
        ("2026-04", 150000)
    ]
    assert [m["month"] for m in s["months"]] == ["2026-04", "2026-05", "2026-06"]
    assert all(m["status"] == "unpaid" and m["is_due"] for m in s["months"])
    assert (s["balance_paise"], s["status"]) == (-450000, "owes")
    assert (s["payment_count"], s["total_paid_paise"]) == (0, 0)
    assert s["created_at"] and s["updated_at"]

    fetched = api.get(f"/api/students/{s['id']}").json()
    assert fetched == s


def test_create_left_student(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-01", left_month="2026-02")
    assert s["is_active"] is False
    assert s["balance_paise"] == -300000
    assert months_of(s)["2026-03"] == (0, 0, "not_applicable")


@pytest.mark.parametrize(
    "body",
    [
        {"name": "", "monthly_fee_paise": 1, "joined_month": "2026-01"},
        {"name": "A", "monthly_fee_paise": -1, "joined_month": "2026-01"},
        {"name": "A", "monthly_fee_paise": 1, "joined_month": "2026-13"},
        {"name": "A", "monthly_fee_paise": 1},
        {"name": "A", "monthly_fee_paise": 1, "joined_month": "2026-05", "left_month": "2026-04"},
        {"name": "A", "monthly_fee_paise": 1, "joined_month": "2026-01", "surname": "B"},
        {"name": "A", "monthly_fee_paise": 1.5, "joined_month": "2026-01"},
    ],
)
def test_create_validation(api: TestClient, body: Json) -> None:
    assert api.post("/api/students", json=body).status_code == 422


def test_missing_student_is_404(api: TestClient) -> None:
    for method, path in [
        ("get", "/api/students/99"),
        ("patch", "/api/students/99"),
        ("delete", "/api/students/99"),
        ("get", "/api/students/99/suggest-payment"),
    ]:
        response = api.request(method, path, json={} if method == "patch" else None)
        assert response.status_code == 404, (method, path)
        assert response.json() == {"detail": "No student with id 99"}


def test_detail_ledger_with_payments(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-03")
    pay(api, s["id"], "2026-03")
    pay(api, s["id"], "2026-04", 100000)
    pay(api, s["id"], "2026-05", 200000)
    pay(api, s["id"], "2026-08")  # paid ahead
    d = api.get(f"/api/students/{s['id']}").json()
    assert months_of(d) == {
        "2026-03": (150000, 150000, "paid"),
        "2026-04": (150000, 100000, "partial"),
        "2026-05": (150000, 200000, "overpaid"),
        "2026-06": (150000, 0, "unpaid"),
        "2026-07": (150000, 0, "unpaid"),
        "2026-08": (150000, 150000, "paid"),
    }
    by_month = {m["month"]: m for m in d["months"]}
    assert by_month["2026-04"]["remaining_paise"] == 50000
    assert by_month["2026-05"]["excess_paise"] == 50000
    assert [m["is_due"] for m in d["months"]] == [True] * 4 + [False] * 2
    # 600000 paid - 4 x 150000 due
    assert (d["balance_paise"], d["status"]) == (0, "up_to_date")
    assert (d["payment_count"], d["total_paid_paise"]) == (4, 600000)


# --------------------------------------------------------------------------- list


def test_list_filters_search_and_sorting(api: TestClient) -> None:
    make_student(api, name="meera Iyer", phone="98765 40001", joined_month="2026-06")
    make_student(api, name="Ananya Rao", guardian_name="Lakshmi Rao")
    left = make_student(api, name="Rohan Desai", left_month="2026-03")
    make_student(api, name="Zara Khan", monthly_fee_paise=0)

    names = lambda **params: [s["name"] for s in api.get("/api/students", params=params).json()]  # noqa: E731
    assert names() == ["Ananya Rao", "meera Iyer", "Zara Khan"]  # default: active, by name
    assert names(status="left") == ["Rohan Desai"]
    assert names(status="all") == ["Ananya Rao", "meera Iyer", "Rohan Desai", "Zara Khan"]
    assert names(q="MEERA") == ["meera Iyer"]
    assert names(q="lakshmi") == ["Ananya Rao"]  # guardian
    assert names(q="9876540001") == ["meera Iyer"]  # phone, spaces ignored
    assert names(q="40001") == ["meera Iyer"]
    assert names(q="rohan") == []  # archived students need status=left/all
    assert names(q="rohan", status="all") == ["Rohan Desai"]
    assert names(q="   ") == ["Ananya Rao", "meera Iyer", "Zara Khan"]
    assert names(q="%") == []

    rows = {s["name"]: s for s in api.get("/api/students", params={"status": "all"}).json()}
    assert rows["Rohan Desai"]["id"] == left["id"]
    assert rows["Rohan Desai"]["is_active"] is False
    assert (rows["Ananya Rao"]["balance_paise"], rows["Ananya Rao"]["status"]) == (-900000, "owes")
    assert rows["Zara Khan"]["status"] == "up_to_date"
    assert "months" not in rows["Ananya Rao"]  # list items are the short shape


def test_list_bad_filter_is_422(api: TestClient) -> None:
    assert api.get("/api/students", params={"status": "gone"}).status_code == 422


def test_balance_status_credit(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-06")
    pay(api, s["id"], "2026-06", 200000)
    row = api.get("/api/students").json()[0]
    assert (row["balance_paise"], row["status"]) == (50000, "credit")


# --------------------------------------------------------------------------- update


def test_patch_is_partial(api: TestClient) -> None:
    s = make_student(api, phone="98765 43210", notes="Loves tabla")
    updated = api.patch(f"/api/students/{s['id']}", json={"batch_label": "Tue/Thu 6pm"}).json()
    assert updated["batch_label"] == "Tue/Thu 6pm"
    assert updated["phone"] == "98765 43210"
    assert updated["notes"] == "Loves tabla"
    cleared = api.patch(f"/api/students/{s['id']}", json={"phone": "", "notes": None}).json()
    assert (cleared["phone"], cleared["notes"]) == (None, None)
    assert cleared["name"] == "Ananya Rao"


def test_patch_fee_defaults_to_current_month(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-01", monthly_fee_paise=150000)
    d = api.patch(f"/api/students/{s['id']}", json={"monthly_fee_paise": 180000}).json()
    assert [(f["effective_month"], f["amount_paise"]) for f in d["fee_history"]] == [
        ("2026-01", 150000),
        ("2026-06", 180000),
    ]
    assert d["monthly_fee_paise"] == 180000
    assert months_of(d)["2026-05"][0] == 150000  # earlier months keep their old fee
    assert months_of(d)["2026-06"][0] == 180000


def test_patch_fee_from_a_past_month_and_upsert(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-01", monthly_fee_paise=150000)
    url = f"/api/students/{s['id']}"
    api.patch(url, json={"monthly_fee_paise": 200000, "fee_effective_month": "2026-03"})
    d = api.patch(url, json={"monthly_fee_paise": 180000, "fee_effective_month": "2026-03"}).json()
    assert [(f["effective_month"], f["amount_paise"]) for f in d["fee_history"]] == [
        ("2026-01", 150000),
        ("2026-03", 180000),
    ]
    assert d["balance_paise"] == -(2 * 150000 + 4 * 180000)
    # Correcting the joining fee updates the first row.
    d = api.patch(url, json={"monthly_fee_paise": 120000, "fee_effective_month": "2026-01"}).json()
    assert d["fee_history"][0]["amount_paise"] == 120000


def test_patch_same_fee_records_nothing(api: TestClient) -> None:
    s = make_student(api)
    d = api.patch(f"/api/students/{s['id']}", json={"monthly_fee_paise": 150000}).json()
    assert len(d["fee_history"]) == 1


def test_patch_fee_before_joined_is_422(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-03")
    response = api.patch(
        f"/api/students/{s['id']}",
        json={"monthly_fee_paise": 1, "fee_effective_month": "2026-02"},
    )
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "fee_effective_month"]


def test_patch_fee_for_future_joiner_defaults_to_joined_month(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-08")
    d = api.patch(f"/api/students/{s['id']}", json={"monthly_fee_paise": 99900}).json()
    assert [(f["effective_month"], f["amount_paise"]) for f in d["fee_history"]] == [
        ("2026-08", 99900)
    ]


@pytest.mark.parametrize(
    "body",
    [
        {"name": None},
        {"name": " "},
        {"joined_month": None},
        {"monthly_fee_paise": None},
        {"monthly_fee_paise": -5},
        {"fee_effective_month": "2026-03"},
        {"joined_month": "2026-05", "left_month": "2026-04"},
        {"left_month": "2026/04"},
        {"unknown": 1},
    ],
)
def test_patch_validation(api: TestClient, body: Json) -> None:
    s = make_student(api)
    assert api.patch(f"/api/students/{s['id']}", json=body).status_code == 422


def test_left_month_checked_against_stored_joined_month(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-03")
    url = f"/api/students/{s['id']}"
    response = api.patch(url, json={"left_month": "2026-02"})
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "left_month"]

    api.patch(url, json={"left_month": "2026-04"})
    response = api.patch(url, json={"joined_month": "2026-05"})  # later than the stored left
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "joined_month"]
    # Nothing changed.
    d = api.get(url).json()
    assert (d["joined_month"], d["left_month"]) == ("2026-03", "2026-04")


def test_archive_and_unarchive(api: TestClient) -> None:
    s = make_student(api)
    url = f"/api/students/{s['id']}"
    d = api.patch(url, json={"left_month": "2026-02"}).json()
    assert (d["is_active"], d["balance_paise"]) == (False, -300000)
    d = api.patch(url, json={"left_month": None}).json()
    assert (d["is_active"], d["left_month"], d["balance_paise"]) == (True, None, -900000)


def test_moving_joined_month_earlier_moves_the_first_fee(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-03", monthly_fee_paise=150000)
    url = f"/api/students/{s['id']}"
    api.patch(url, json={"monthly_fee_paise": 180000, "fee_effective_month": "2026-05"})
    d = api.patch(url, json={"joined_month": "2026-01"}).json()
    assert [(f["effective_month"], f["amount_paise"]) for f in d["fee_history"]] == [
        ("2026-01", 150000),
        ("2026-05", 180000),
    ]
    assert months_of(d)["2026-01"] == (150000, 0, "unpaid")


def test_moving_joined_month_later_moves_the_first_fee(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-01", monthly_fee_paise=100000)
    url = f"/api/students/{s['id']}"
    api.patch(url, json={"monthly_fee_paise": 200000, "fee_effective_month": "2026-05"})
    pay(api, s["id"], "2026-01", 100000)

    d = api.patch(url, json={"joined_month": "2026-03"}).json()
    assert [(f["effective_month"], f["amount_paise"]) for f in d["fee_history"]] == [
        ("2026-03", 100000),
        ("2026-05", 200000),
    ]
    # The January payment is still there; January is no longer owed, so it shows as overpaid.
    assert months_of(d)["2026-01"] == (0, 100000, "overpaid")
    assert months_of(d)["2026-03"] == (100000, 0, "unpaid")


@pytest.mark.parametrize("joined", ["2026-05", "2026-06"])
def test_moving_joined_month_onto_a_later_fee_is_422(api: TestClient, joined: str) -> None:
    s = make_student(api, joined_month="2026-01", monthly_fee_paise=100000)
    url = f"/api/students/{s['id']}"
    api.patch(url, json={"monthly_fee_paise": 200000, "fee_effective_month": "2026-05"})
    response = api.patch(url, json={"joined_month": joined, "notes": "moved"})
    assert response.status_code == 422
    [error] = response.json()["detail"]
    assert error["loc"] == ["body", "joined_month"]
    assert "2026-05" in error["msg"]
    d = api.get(url).json()  # nothing changed
    assert (d["joined_month"], d["notes"], len(d["fee_history"])) == ("2026-01", None, 2)


def test_moving_joined_month_and_changing_fee_together(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-03", monthly_fee_paise=150000)
    d = api.patch(
        f"/api/students/{s['id']}",
        json={
            "joined_month": "2026-02",
            "monthly_fee_paise": 90000,
            "fee_effective_month": "2026-02",
        },
    ).json()
    assert [(f["effective_month"], f["amount_paise"]) for f in d["fee_history"]] == [
        ("2026-02", 90000)
    ]


# --------------------------------------------------------------------------- delete


def test_delete_cascades_to_payments(api: TestClient) -> None:
    keep = make_student(api, name="Kabir Mehta")
    s = make_student(api)
    pay(api, s["id"], "2026-01")
    pay(api, s["id"], "2026-02")
    pay(api, keep["id"], "2026-01")
    assert api.get(f"/api/students/{s['id']}").json()["payment_count"] == 2

    response = api.delete(f"/api/students/{s['id']}")
    assert response.status_code == 204
    assert response.content == b""
    assert api.get(f"/api/students/{s['id']}").status_code == 404
    remaining = api.get("/api/payments").json()
    assert [p["student_id"] for p in remaining] == [keep["id"]]
    assert api.delete(f"/api/students/{s['id']}").status_code == 404


# --------------------------------------------------------------------------- suggest-payment


def test_suggest_payment(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-04")
    url = f"/api/students/{s['id']}/suggest-payment"
    assert api.get(url).json() == {"for_month": "2026-04", "amount_paise": 150000}
    pay(api, s["id"], "2026-04")
    pay(api, s["id"], "2026-05", 50000)
    assert api.get(url).json() == {"for_month": "2026-05", "amount_paise": 100000}
    pay(api, s["id"], "2026-05", 100000)
    pay(api, s["id"], "2026-06")
    assert api.get(url).json() == {"for_month": "2026-06", "amount_paise": 150000}


def test_suggest_payment_after_fee_change(api: TestClient) -> None:
    s = make_student(api, joined_month="2026-06")
    api.patch(f"/api/students/{s['id']}", json={"monthly_fee_paise": 250000})
    url = f"/api/students/{s['id']}/suggest-payment"
    assert api.get(url).json() == {"for_month": "2026-06", "amount_paise": 250000}
