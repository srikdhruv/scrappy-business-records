"""Unassigned payments: kept from an upload, counted nowhere, then assigned or deleted."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from helpers import make_student, pay
from test_excel_import import commit, preview, xlsx

Json = dict[str, Any]

HEAD = ["Student", "Phone", "Amount", "Paid on", "For month", "Method", "Note"]


def upload_strays(api: TestClient, *rows: list[Any]) -> list[Json]:
    shown = preview(api, xlsx(("Payments", [HEAD, *rows])), "statement.xlsx")
    commit(api, shown)
    return api.get("/api/unassigned-payments").json()


def test_unassigned_payments_count_nowhere(api: TestClient) -> None:
    kabir = make_student(api, name="Kabir Mehta")
    board = api.get("/api/dashboard").json()
    strays = upload_strays(api, ["Mr Mehta", None, 1500, "2026-06-02", "Jun 2026", "UPI", "gpay"])
    assert len(strays) == 1
    assert api.get("/api/dashboard").json() == board  # not in Collected, nor anyone's totals
    assert api.get(f"/api/students/{kabir['id']}").json()["total_paid_paise"] == 0
    assert api.get("/api/payments").json() == []


def test_list_shows_the_row_as_written_with_likely_students(api: TestClient) -> None:
    kabir = make_student(api, name="Kabir Mehta", phone="90000 00001")
    make_student(api, name="Kabira Singh")
    make_student(api, name="Diya Nair")
    [row] = upload_strays(
        api, ["K Mehta", "90000 00009", "₹1,500", "2 Jun 2026", "Jun 2026", "Cash", "for June"]
    )
    assert {k: row[k] for k in ("student_text", "phone", "amount_paise", "paid_on", "for_month",
                                "method", "note", "source")} == {
        "student_text": "K Mehta",
        "phone": "90000 00009",
        "amount_paise": 150000,
        "paid_on": "2026-06-02",
        "for_month": "2026-06",
        "method": "cash",
        "note": "for June",
        "source": "Upload: statement.xlsx",
    }  # fmt: skip
    assert row["suggested_student_ids"] == [kabir["id"]]  # the Students search finds him


def test_assign_moves_it_into_payments_at_once(api: TestClient) -> None:
    kabir = make_student(api, name="Kabir Mehta", joined_month="2026-06")
    [row] = upload_strays(api, ["Kabeer", None, 1500, "2026-06-02", "Jun 2026", "UPI", "note"])
    response = api.post(
        f"/api/unassigned-payments/{row['id']}/assign", json={"student_id": kabir["id"]}
    )
    assert response.status_code == 201, response.text
    payment = response.json()
    assert (payment["student_id"], payment["amount_paise"], payment["for_month"]) == (
        kabir["id"],
        150000,
        "2026-06",
    )
    assert payment["note"] == "note" and payment["method"] == "upi"
    assert api.get("/api/unassigned-payments").json() == []
    detail = api.get(f"/api/students/{kabir['id']}").json()
    assert detail["status"] == "up_to_date" and detail["total_paid_paise"] == 150000
    # Assigning it again: it's gone.
    again = api.post(
        f"/api/unassigned-payments/{row['id']}/assign", json={"student_id": kabir["id"]}
    )
    assert again.status_code == 404


def test_assign_refuses_a_duplicate_and_keeps_the_row(api: TestClient) -> None:
    kabir = make_student(api, name="Kabir Mehta")
    pay(api, kabir["id"], "2026-06", paid_on="2026-06-02")
    [row] = upload_strays(api, ["Kabeer", None, 1500, "2026-06-02", "Jun 2026", "UPI", None])
    response = api.post(
        f"/api/unassigned-payments/{row['id']}/assign", json={"student_id": kabir["id"]}
    )
    assert response.status_code == 422
    [item] = response.json()["detail"]
    assert item["loc"] == ["body", "student_id"]
    assert item["msg"].startswith("Kabir Mehta already has this payment")
    assert len(api.get("/api/unassigned-payments").json()) == 1
    assert len(api.get("/api/payments").json()) == 1


def test_assign_to_a_missing_student_and_delete(api: TestClient) -> None:
    [row] = upload_strays(api, ["Nobody", None, 1500, "2026-06-02", "Jun 2026", "UPI", None])
    missing = api.post(f"/api/unassigned-payments/{row['id']}/assign", json={"student_id": 999})
    assert missing.status_code == 422
    assert missing.json()["detail"][0]["msg"] == "That student no longer exists. Choose another."
    for bad in ({"student_id": 0}, {"student_id": "1"}, {}, {"student_id": 1, "x": 1}):
        assert api.post(f"/api/unassigned-payments/{row['id']}/assign", json=bad).status_code == 422
    assert api.delete(f"/api/unassigned-payments/{row['id']}").status_code == 204
    assert api.delete(f"/api/unassigned-payments/{row['id']}").status_code == 404
    assert api.delete("/api/unassigned-payments/99999999999999999999").status_code in (404, 422)
    assert api.get("/api/unassigned-payments").json() == []


def test_the_same_stray_uploaded_twice_is_kept_once(api: TestClient) -> None:
    rows = [["Nobody", None, 1500, "2026-06-02", "Jun 2026", "UPI", None]]
    upload_strays(api, *rows)
    shown = preview(api, xlsx(("Payments", [HEAD, *rows])))
    [row] = shown["payments"]
    assert (row["status"], row["reason"]) == (
        "duplicate",
        "Already waiting in Unassigned payments",
    )
    commit(api, shown)
    assert len(api.get("/api/unassigned-payments").json()) == 1
