"""The API contract: every endpoint from docs/data-model.md exists with the right shape.

Behaviour is tested endpoint by endpoint in the test_api_*.py files.
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
    ("post", "/api/students/{student_id}/return"): "returnStudent",
    ("delete", "/api/students/{student_id}/fee-changes/{fee_change_id}"): "deleteFeeChange",
    ("get", "/api/payments"): "listPayments",
    ("post", "/api/payments"): "createPayment",
    ("get", "/api/payments/{payment_id}"): "getPayment",
    ("patch", "/api/payments/{payment_id}"): "updatePayment",
    ("delete", "/api/payments/{payment_id}"): "deletePayment",
    ("get", "/api/dashboard"): "getDashboard",
    ("get", "/api/report"): "getReport",
    ("get", "/api/report.xlsx"): "downloadReport",
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
    fee_change = "/api/students/{student_id}/fee-changes/{fee_change_id}"
    assert "204" in paths[fee_change]["delete"]["responses"]
    assert "200" in paths["/api/students/{student_id}/return"]["post"]["responses"]
    assert "404" in paths["/api/students/{student_id}"]["get"]["responses"]


def test_422_uses_validation_shape_and_404_uses_error_response(client: TestClient) -> None:
    schema = client.get("/api/openapi.json").json()
    for path, ops in schema["paths"].items():
        for method, op in ops.items():
            if (method, path) == ("get", "/api/health"):
                continue  # takes no input, so it can't fail validation
            ref = op["responses"]["422"]["content"]["application/json"]["schema"]["$ref"]
            assert ref.endswith("/HTTPValidationError"), (method, path)
            if "404" in op["responses"]:
                ref404 = op["responses"]["404"]["content"]["application/json"]["schema"]["$ref"]
                assert ref404.endswith("/ErrorResponse"), (method, path)


def test_validation_error_body(client: TestClient) -> None:
    response = client.post(
        "/api/students",
        json={
            "name": "Kabir Mehta",
            "monthly_fee_paise": 1,
            "joined_month": "2026-05",
            "left_month": "2026-04",
        },
    )
    assert response.status_code == 422
    [item] = response.json()["detail"]
    assert item["loc"] == ["body", "left_month"]
    assert item["msg"] == "Left month can't be before the joined month"


# Every schema-level rule must name its field in `loc`, with a plain message, so the UI can show
# it next to the right input (ApiError.fields).
STUDENT = {"name": "Kabir Mehta", "monthly_fee_paise": 150000, "joined_month": "2026-01"}
PAYMENT = {
    "student_id": 1,
    "amount_paise": 150000,
    "paid_on": "2026-01-05",
    "for_month": "2026-01",
    "method": "upi",
}
MAX = schemas.MAX_AMOUNT_PAISE


@pytest.mark.parametrize(
    ("method", "path", "body", "loc", "msg"),
    [
        ("post", "/api/students", {**STUDENT, "name": "   "}, "name", "Name is required"),
        ("post", "/api/students", {**STUDENT, "name": ""}, "name", "Name is required"),
        (
            "post",
            "/api/students",
            {**STUDENT, "left_month": "2025-12"},
            "left_month",
            "Left month can't be before the joined month",
        ),
        ("patch", "/api/students/1", {"name": None}, "name", "Name is required"),
        ("patch", "/api/students/1", {"name": " "}, "name", "Name is required"),
        (
            "patch",
            "/api/students/1",
            {"joined_month": None},
            "joined_month",
            "Joined month is required",
        ),
        (
            "patch",
            "/api/students/1",
            {"monthly_fee_paise": None},
            "monthly_fee_paise",
            "Monthly fee is required",
        ),
        (
            "patch",
            "/api/students/1",
            {"fee_effective_month": "2026-03"},
            "fee_effective_month",
            "Send the new monthly fee together with the month it starts",
        ),
        (
            "patch",
            "/api/students/1",
            {"joined_month": "2026-05", "left_month": "2026-04"},
            "left_month",
            "Left month can't be before the joined month",
        ),
        ("patch", "/api/payments/1", {"amount_paise": None}, "amount_paise", "Amount is required"),
        ("patch", "/api/payments/1", {"student_id": None}, "student_id", "Student is required"),
        ("patch", "/api/payments/1", {"paid_on": None}, "paid_on", "Paid-on date is required"),
        ("patch", "/api/payments/1", {"for_month": None}, "for_month", "Month is required"),
        ("patch", "/api/payments/1", {"method": None}, "method", "Payment method is required"),
    ],
)
def test_422_names_the_field(
    client: TestClient, method: str, path: str, body: dict, loc: str, msg: str
) -> None:
    response = client.request(method, path, json=body)
    assert response.status_code == 422
    [item] = response.json()["detail"]
    assert item["loc"] == ["body", loc]
    assert item["msg"] == msg


@pytest.mark.parametrize(
    ("method", "path", "body", "loc"),
    [
        ("post", "/api/payments", {**PAYMENT, "amount_paise": MAX + 1}, "amount_paise"),
        ("patch", "/api/payments/1", {"amount_paise": MAX + 1}, "amount_paise"),
        ("post", "/api/students", {**STUDENT, "monthly_fee_paise": MAX + 1}, "monthly_fee_paise"),
        ("patch", "/api/students/1", {"monthly_fee_paise": MAX + 1}, "monthly_fee_paise"),
    ],
)
def test_amounts_are_capped(
    client: TestClient, method: str, path: str, body: dict, loc: str
) -> None:
    response = client.request(method, path, json=body)
    assert response.status_code == 422
    [item] = response.json()["detail"]
    assert item["loc"] == ["body", loc]
    assert item["type"] == "less_than_equal"


def test_amount_cap_value_and_boundary() -> None:
    assert MAX == 10_00_000 * 100  # ₹10,00,000; frontend MAX_AMOUNT_PAISE must match
    assert schemas.PaymentCreate(**{**PAYMENT, "amount_paise": MAX}).amount_paise == MAX
    assert schemas.StudentCreate(**{**STUDENT, "monthly_fee_paise": MAX}).monthly_fee_paise == MAX


def test_openapi_advertises_the_cap(client: TestClient) -> None:
    components = client.get("/api/openapi.json").json()["components"]["schemas"]
    assert components["PaymentCreate"]["properties"]["amount_paise"]["maximum"] == MAX
    assert components["StudentCreate"]["properties"]["monthly_fee_paise"]["maximum"] == MAX


EVERY_ENDPOINT = [
    ("get", "/api/students", None),
    ("get", "/api/students/1", None),
    ("delete", "/api/students/1", None),
    ("get", "/api/students/1/suggest-payment", None),
    ("post", "/api/students/1/return", {"from_month": "2026-06"}),
    ("delete", "/api/students/1/fee-changes/1", None),
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


@pytest.mark.parametrize(("method", "path", "body"), EVERY_ENDPOINT)
def test_no_stubs_left(client: TestClient, method: str, path: str, body: object) -> None:
    """Every endpoint is implemented (on an empty database most answer 404, not 501)."""
    response = client.request(method, path, json=body)
    assert response.status_code < 500


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
