"""Lists, the dashboard and the report run a fixed number of SQL queries, however many rows
there are (no query per student or per payment)."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from fastapi.testclient import TestClient
from helpers import make_student, pay
from sqlalchemy import event

from app.db import get_engine


@contextmanager
def count_queries() -> Iterator[list[str]]:
    statements: list[str] = []

    def record(_conn: Any, _cursor: Any, statement: str, *_args: Any) -> None:
        statements.append(statement)

    engine = get_engine()
    event.listen(engine, "before_cursor_execute", record)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", record)


def add_students(api: TestClient, n: int, start: int) -> None:
    for i in range(start, start + n):
        s = make_student(api, name=f"Student {i:03d}", joined_month="2026-01")
        for month in ("2026-01", "2026-02", "2026-03"):
            pay(api, s["id"], month, note=f"n{i}")


ENDPOINTS = [
    "/api/payments",
    "/api/payments?sort=student&order=asc&q=student",
    "/api/students?status=all",
    "/api/dashboard",
    "/api/dashboard?month=2026-02",
    "/api/report?month=2026-02",
]


@pytest.mark.parametrize("url", ENDPOINTS)
def test_query_count_does_not_grow_with_rows(api: TestClient, url: str) -> None:
    add_students(api, 2, start=0)
    with count_queries() as small:
        assert api.get(url).status_code == 200
    add_students(api, 10, start=100)
    with count_queries() as large:
        response = api.get(url)
    assert response.status_code == 200
    assert len(response.json()) > 0
    assert len(large) == len(small), large
    assert len(large) <= 3


def test_single_rows_and_writes_use_few_queries(api: TestClient) -> None:
    s = make_student(api)
    for month in ("2026-01", "2026-02", "2026-03", "2026-04"):
        p = pay(api, s["id"], month)
    with count_queries() as detail:
        api.get(f"/api/students/{s['id']}")
    with count_queries() as payment:
        api.get(f"/api/payments/{p['id']}")
    with count_queries() as update:
        body = api.patch(f"/api/payments/{p['id']}", json={"amount_paise": 5}).json()
    assert body["updated_at"].endswith("Z")
    assert len(detail) <= 3
    # A payment comes with where its money went, so the student's fee changes and payments are
    # loaded with it: the student (joined to the payment), fee changes, payments.
    assert len(payment) <= 3
    assert len(update) <= 5


@pytest.mark.parametrize("url", ["/api/batches", "/api/batches/summary?month=2026-02"])
def test_batch_queries_do_not_grow_with_rows(api: TestClient, url: str) -> None:
    ids = [api.post("/api/batches", json={"name": f"Batch {i}"}).json()["id"] for i in range(3)]

    def add(n: int, start: int) -> None:
        for i in range(start, start + n):
            s = make_student(api, name=f"Student {i:03d}", batch_id=ids[i % 3])
            pay(api, s["id"], "2026-02")

    add(2, start=0)
    with count_queries() as small:
        assert api.get(url).status_code == 200
    add(10, start=100)
    api.post("/api/batches", json={"name": "One more"})
    with count_queries() as large:
        assert api.get(url).status_code == 200
    assert len(large) == len(small), large
    # The batches, and for the month's numbers the students (with their batch) and their fee
    # changes and payments.
    assert len(large) <= 4
