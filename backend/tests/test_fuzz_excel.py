"""Fuzz the Excel and unassigned-payment endpoints: no file, cell or body may produce a 500."""

from __future__ import annotations

import datetime as dt
import json
from typing import Any

from fastapi.testclient import TestClient
from helpers import make_student, pay
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from test_excel_import import xlsx
from test_fuzz import scalars, values

FUZZ = settings(
    max_examples=150,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow],
)


def _seed(api: TestClient) -> None:
    if not api.get("/api/students", params={"status": "all"}).json():
        s = make_student(api, name="Kabir Mehta", phone="90000 00001")
        pay(api, s["id"], "2026-05")
        make_student(api, name="Kabir Mehta", phone="90000 00002")


# Cells as a spreadsheet can hold them.
cell = st.one_of(
    st.none(),
    st.booleans(),
    st.integers(-(10**12), 10**12),
    st.floats(allow_nan=False, allow_infinity=False, width=32),
    st.text(st.characters(exclude_categories=("Cs", "Cc")), max_size=12),
    st.dates(dt.date(1990, 1, 1), dt.date(2110, 12, 31)),
    st.datetimes(dt.datetime(1990, 1, 1), dt.datetime(2110, 12, 31)),
    st.sampled_from(
        ["Kabir Mehta", "90000 00001", "₹1,500", "1500/-", "05/10/2026", "Oct 2026", "2026-05",
         "5 May 2026", "UPI", "Away (no fee)", "=1+1", "", "-", "0", "1"]
    ),
)  # fmt: skip
HEADINGS = [
    "Name", "Student", "Phone", "Monthly fee", "Fee", "Joined", "Left", "Notes", "Amount",
    "Paid on", "Date", "For month", "Month", "Method", "Note", "Student ID", "Fee from", "Kind",
    "Came from", "Parent", "Class",
]  # fmt: skip
TITLES = ["Students", "Payments", "Fee history", "Unassigned payments", "Sheet1"]

sheets = st.lists(
    st.tuples(
        st.sampled_from(TITLES),
        st.integers(1, 6).flatmap(
            lambda width: st.tuples(
                st.lists(st.sampled_from(HEADINGS), min_size=width, max_size=width),
                st.lists(st.lists(cell, min_size=width, max_size=width), max_size=6),
            )
        ),
    ),
    min_size=1,
    max_size=3,
    unique_by=lambda s: s[0],
)


@FUZZ
@given(book=sheets)
def test_no_500_from_any_spreadsheet(api: TestClient, book: list[Any]) -> None:
    _seed(api)
    data = xlsx(*[(title, [head, *rows]) for title, (head, rows) in book])
    response = api.post("/api/import/preview", content=data)
    assert response.status_code in (200, 422), response.text
    if response.status_code == 200:
        shown = response.json()
        # Adding whatever the preview offers never fails either.
        body = {
            "students": [{"data": s["data"], "add": True} for s in shown["students"] if s["data"]],
            "payments": [{"data": p["data"]} for p in shown["payments"] if p["data"]],
        }
        committed = api.post("/api/import/commit", json=body)
        assert committed.status_code in (200, 409, 422), committed.text


@FUZZ
@given(raw=st.binary(max_size=200))
def test_no_500_from_raw_bytes(api: TestClient, raw: bytes) -> None:
    assert api.post("/api/import/preview", content=raw).status_code == 422
    response = api.post(
        "/api/import/commit", content=raw, headers={"content-type": "application/json"}
    )
    assert response.status_code < 500  # 400 or 422: not JSON, or not the right shape


student_data = st.dictionaries(
    st.sampled_from(
        ["row", "ref", "name", "phone", "guardian_name", "batch_label", "notes", "joined_month",
         "left_month", "monthly_fee_paise", "fees"]
    ),
    values,
    max_size=8,
)  # fmt: skip
payment_data = st.dictionaries(
    st.sampled_from(
        ["row", "student_text", "phone", "student_ref", "amount_paise", "paid_on", "for_month",
         "method", "note", "unassigned", "source"]
    ),
    values,
    max_size=9,
)  # fmt: skip
decisions = st.fixed_dictionaries(
    {
        "students": st.lists(
            st.fixed_dictionaries({"data": student_data}, optional={"add": scalars}), max_size=3
        ),
        "payments": st.lists(
            st.fixed_dictionaries(
                {"data": payment_data},
                optional={"choice": st.sampled_from(["auto", "skip", "student", "unassigned", "x"]),
                          "student_id": scalars},
            ),
            max_size=3,
        ),
    },
    optional={"filename": scalars},
)  # fmt: skip


@FUZZ
@given(body=st.one_of(decisions, values))
def test_no_500_from_commit_bodies(api: TestClient, body: Any) -> None:
    _seed(api)
    response = api.post(
        "/api/import/commit",
        content=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )
    assert response.status_code in (200, 409, 422), (body, response.text)


@FUZZ
@given(
    route=st.sampled_from(
        [
            ("get", "/api/unassigned-payments"),
            ("post", "/api/unassigned-payments/{id}/assign"),
            ("delete", "/api/unassigned-payments/{id}"),
            ("get", "/api/export/students.xlsx"),
            ("get", "/api/export/payments.xlsx"),
            ("get", "/api/export/everything.xlsx"),
            ("get", "/api/import/template.xlsx"),
        ]
    ),
    id_=st.one_of(st.integers(-3, 5), st.integers(min_value=2**62, max_value=2**80)),
    body=values,
    query=st.dictionaries(
        st.sampled_from(["status", "q", "student_id", "month", "method", "sort", "order", "kind"]),
        st.one_of(st.text(max_size=12), st.integers(-(2**70), 2**70).map(str)),
        max_size=4,
    ),
)
def test_no_500_from_the_other_endpoints(
    api: TestClient, route: tuple[str, str], id_: int, body: Any, query: dict[str, str]
) -> None:
    _seed(api)
    method, path = route
    response = api.request(
        method,
        path.format(id=id_),
        params=query,
        content=json.dumps(body).encode() if method == "post" else None,
        headers={"content-type": "application/json"},
    )
    assert response.status_code < 500, (method, path, body, query, response.text)
