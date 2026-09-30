"""Fuzz the API: no input, however odd, may produce a 500."""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient
from helpers import make_student, pay
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

FIELDS = [
    "name",
    "phone",
    "guardian_name",
    "batch_label",
    "notes",
    "joined_month",
    "left_month",
    "monthly_fee_paise",
    "fee_effective_month",
    "student_id",
    "amount_paise",
    "paid_on",
    "for_month",
    "method",
    "note",
]

scalars = st.one_of(
    st.none(),
    st.booleans(),
    st.integers(min_value=-(2**70), max_value=2**70),
    st.floats(),  # including NaN and Infinity
    st.just(float("inf")),  # also what 1e400 parses to
    st.text(max_size=20),
    # Any code point: control characters (NUL...) and lone surrogates too.
    st.text(st.characters(codec=None, exclude_categories=()), max_size=8),
    st.sampled_from(["\x00", "x\x00", "\ud800", "a\x07b", "\x7f", "\x1b[31m"]),
    st.from_regex(r"\A\d{1,5}-\d{1,3}\Z"),  # month-ish
    st.from_regex(r"\A\d{1,5}-\d{1,2}-\d{1,2}\Z"),  # date-ish
    st.sampled_from(["2026-06", "2028-12", "2026-06-10", "upi", "cash", "", " "]),
)
values = st.one_of(
    scalars,
    st.lists(scalars, max_size=2),
    st.dictionaries(st.text(max_size=3), scalars, max_size=2),
)
bodies = st.one_of(
    st.dictionaries(st.sampled_from(FIELDS), values, max_size=6),
    values,
)
ids = st.one_of(st.integers(-3, 5), st.integers(min_value=2**62, max_value=2**80))
routes = st.sampled_from(
    [
        ("get", "/api/students"),
        ("post", "/api/students"),
        ("get", "/api/students/{id}"),
        ("patch", "/api/students/{id}"),
        ("delete", "/api/students/{id}"),
        ("get", "/api/students/{id}/suggest-payment"),
        ("get", "/api/payments"),
        ("post", "/api/payments"),
        ("get", "/api/payments/{id}"),
        ("patch", "/api/payments/{id}"),
        ("delete", "/api/payments/{id}"),
        ("get", "/api/dashboard"),
    ]
)
params = st.dictionaries(
    st.sampled_from(["month", "q", "sort", "order", "student_id", "status"]),
    st.one_of(st.text(max_size=12), st.integers(-(2**70), 2**70).map(str)),
    max_size=4,
)

FUZZ = settings(
    max_examples=400,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow],
)


def _seed(api: TestClient) -> None:
    if not api.get("/api/students", params={"status": "all"}).json():
        s = make_student(api)
        pay(api, s["id"], "2026-05")


@FUZZ
@given(route=routes, id_=ids, body=bodies, query=params)
def test_no_500_from_json(
    api: TestClient, route: tuple[str, str], id_: int, body: Any, query: dict[str, str]
) -> None:
    _seed(api)
    method, path = route
    # Raw JSON, so NaN / Infinity and lone surrogates (as \\ud800 escapes) get through.
    content = json.dumps(body).encode() if method in ("post", "patch") else None
    response = api.request(
        method,
        path.format(id=id_),
        params=query,
        content=content,
        headers={"content-type": "application/json"},
    )
    assert response.status_code < 500, (method, path, body, query, response.text)


@FUZZ
@given(route=routes, raw=st.binary(max_size=60))
def test_no_500_from_raw_bytes(api: TestClient, route: tuple[str, str], raw: bytes) -> None:
    method, path = route
    if method not in ("post", "patch"):
        return
    response = api.request(
        method,
        path.format(id=1),
        content=raw,
        headers={"content-type": "application/json"},
    )
    assert response.status_code < 500, (method, path, raw, response.text)


def test_lone_surrogates_are_rejected_not_crashing(api: TestClient) -> None:
    _seed(api)
    raw = b'{"name": "\\ud800", "monthly_fee_paise": 1, "joined_month": "2026-01"}'
    response = api.post("/api/students", content=raw, headers={"content-type": "application/json"})
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "name"]
    raw = b'{"note": "\\udfff"}'
    response = api.patch(
        "/api/payments/1", content=raw, headers={"content-type": "application/json"}
    )
    assert response.status_code == 422
    # Invalid UTF-8 in the query string (an encoded lone surrogate, and a stray byte).
    for query in ("q=%ED%A0%80", "q=%FF", "month=%FF"):
        assert api.get(f"/api/payments?{query}").status_code < 500
        assert api.get(f"/api/students?{query}").status_code < 500
