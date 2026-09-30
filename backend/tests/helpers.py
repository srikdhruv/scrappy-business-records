"""Shared helpers for the API tests."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

Json = dict[str, Any]


def make_student(api: TestClient, **fields: Any) -> Json:
    body = {"name": "Ananya Rao", "monthly_fee_paise": 150000, "joined_month": "2026-01"}
    body.update(fields)
    response = api.post("/api/students", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def pay(api: TestClient, student_id: int, month: str, amount: int = 150000, **fields: Any) -> Json:
    body = {
        "student_id": student_id,
        "amount_paise": amount,
        "paid_on": f"{month}-05",
        "for_month": month,
        "method": "upi",
    }
    body.update(fields)
    response = api.post("/api/payments", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def months_of(detail: Json) -> dict[str, tuple[int, int, str]]:
    return {
        m["month"]: (m["expected_paise"], m["paid_paise"], m["status"]) for m in detail["months"]
    }
