"""The API contract: every endpoint from docs/data-model.md exists with the right shape.

Endpoints still answering 501 are filled in by the backend PR; update `NOT_YET_IMPLEMENTED`
as they land.
"""

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import schemas

EXPECTED_OPERATIONS = {
    ("get", "/api/health"): "getHealth",
    ("get", "/api/students"): "listStudents",
    ("post", "/api/students"): "createStudent",
    ("get", "/api/students/{student_id}"): "getStudent",
    ("patch", "/api/students/{student_id}"): "updateStudent",
    ("delete", "/api/students/{student_id}"): "deleteStudent",
    ("get", "/api/students/{student_id}/suggest-payment"): "suggestPayment",
    ("get", "/api/payments"): "listPayments",
    ("post", "/api/payments"): "createPayment",
    ("get", "/api/payments/{payment_id}"): "getPayment",
    ("patch", "/api/payments/{payment_id}"): "updatePayment",
    ("delete", "/api/payments/{payment_id}"): "deletePayment",
    ("get", "/api/dashboard"): "getDashboard",
}


def test_all_operations_declared(client: TestClient) -> None:
    paths = client.get("/api/openapi.json").json()["paths"]
    found = {
        (method, path): op["operationId"]
        for path, ops in paths.items()
        for method, op in ops.items()
    }
    assert found == EXPECTED_OPERATIONS


def test_status_codes(client: TestClient) -> None:
    paths = client.get("/api/openapi.json").json()["paths"]
    assert "201" in paths["/api/students"]["post"]["responses"]
    assert "201" in paths["/api/payments"]["post"]["responses"]
    assert "204" in paths["/api/students/{student_id}"]["delete"]["responses"]
    assert "204" in paths["/api/payments/{payment_id}"]["delete"]["responses"]
    assert "404" in paths["/api/students/{student_id}"]["get"]["responses"]


NOT_YET_IMPLEMENTED = [
    ("get", "/api/students", None),
    ("get", "/api/students/1", None),
    ("delete", "/api/students/1", None),
    ("get", "/api/students/1/suggest-payment", None),
    ("get", "/api/payments", None),
    ("get", "/api/payments/1", None),
    ("delete", "/api/payments/1", None),
    ("get", "/api/dashboard", None),
    ("post", "/api/students", {"name": "Kabir Mehta", "monthly_fee_paise": 150000,
                               "joined_month": "2026-01"}),
    ("patch", "/api/students/1", {"notes": "x"}),
    ("post", "/api/payments", {"student_id": 1, "amount_paise": 150000,
                               "paid_on": "2026-01-05", "for_month": "2026-01",
                               "method": "upi"}),
    ("patch", "/api/payments/1", {"note": "x"}),
]  # fmt: skip


@pytest.mark.parametrize(("method", "path", "body"), NOT_YET_IMPLEMENTED)
def test_stubs_answer_501(client: TestClient, method: str, path: str, body: object) -> None:
    response = client.request(method, path, json=body)
    assert response.status_code == 501


@pytest.mark.parametrize("month", ["2026-1", "2026-13", "26-01", "2026-00", "2026-01-01", ""])
def test_bad_month_query_is_422(client: TestClient, month: str) -> None:
    assert client.get("/api/dashboard", params={"month": month}).status_code == 422


def test_student_create_validation() -> None:
    ok = schemas.StudentCreate(
        name="  Kabir Mehta ",
        monthly_fee_paise=150000,
        joined_month="2026-01",
        phone="  ",
    )
    assert ok.name == "Kabir Mehta"
    assert ok.phone is None
    with pytest.raises(ValidationError):
        schemas.StudentCreate(name="", monthly_fee_paise=1, joined_month="2026-01")
    with pytest.raises(ValidationError):
        schemas.StudentCreate(name="A", monthly_fee_paise=-1, joined_month="2026-01")
    with pytest.raises(ValidationError):
        schemas.StudentCreate(
            name="A", monthly_fee_paise=1, joined_month="2026-05", left_month="2026-04"
        )
    with pytest.raises(ValidationError):
        schemas.StudentCreate(name="A", monthly_fee_paise=1, joined_month="2026-01", extra=1)


def test_student_update_is_partial() -> None:
    update = schemas.StudentUpdate(left_month=None)
    assert update.model_fields_set == {"left_month"}
    with pytest.raises(ValidationError):
        schemas.StudentUpdate(name=None)
    with pytest.raises(ValidationError):
        schemas.StudentUpdate(fee_effective_month="2026-03")


def test_payment_validation() -> None:
    base = {"student_id": 1, "paid_on": "2026-01-05", "for_month": "2026-01", "method": "cash"}
    assert schemas.PaymentCreate(amount_paise=1, **base).method == schemas.PaymentMethod.cash
    with pytest.raises(ValidationError):
        schemas.PaymentCreate(amount_paise=0, **base)
    with pytest.raises(ValidationError):
        schemas.PaymentCreate(amount_paise=1, **{**base, "method": "cheque"})
    with pytest.raises(ValidationError):
        schemas.PaymentUpdate(amount_paise=None)
