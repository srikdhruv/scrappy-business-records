"""Uploads, third review: a Student ID never outweighs the row's own name, Add is bound to
the very file previewed, the size of what Add accepts, and uids given once."""

from __future__ import annotations

import io
import threading
from typing import Any

from fastapi.testclient import TestClient
from helpers import make_student, pay
from openpyxl import load_workbook
from test_excel_import import by_row, commit, commit_body, preview, xlsx

from app.db import session_factory
from app.services.exports import ensure_uids


def _edited(content: bytes, change: Any) -> bytes:
    """A Download everything file after someone changed it in Excel."""
    book = load_workbook(io.BytesIO(content))
    change(book)
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()


def _copy_row_and_rename(book: Any, name: str) -> None:
    """Copy the first student's row (and their first payment) to a new row, and type a new
    name over it: the Student ID is copied too."""
    students, payments = book["Students"], book["Payments"]
    row = [c.value for c in students[2]]
    students.append([name, None, *row[2:]])
    paid = [c.value for c in payments[2]]
    payments.append([name, None, 2500, *paid[3:]])


def _kabir(api: TestClient) -> dict[str, Any]:
    kabir = make_student(api, name="Kabir Mehta", phone="90000 00001")
    pay(api, kabir["id"], "2026-02")
    return kabir


def test_a_copied_row_with_a_new_name_is_offered_as_someone_new(api: TestClient) -> None:
    kabir = _kabir(api)
    content = api.get("/api/export/everything.xlsx").content
    edited = _edited(content, lambda book: _copy_row_and_rename(book, "Nikhil Rao"))

    shown = preview(api, edited)
    students = by_row(shown["students"])
    assert students[2]["status"] == "exists"  # Kabir himself
    assert students[3]["status"] == "similar"
    assert students[3]["reason"].startswith("Has the same Student ID as Kabir Mehta (row 2)")
    payments = {p["student_text"]: p for p in shown["payments"]}
    assert payments["Kabir Mehta"]["status"] == "duplicate"
    nikhil_pays = payments["Nikhil Rao"]
    assert nikhil_pays["status"] == "needs_student"
    assert nikhil_pays["reason"].startswith("Its Student ID is Kabir Mehta's")

    # She adds Nikhil as new, and keeps his payment for later: nothing lands on Kabir.
    result = commit(api, shown, students={3: True})
    assert (result["students_added"], result["payments_added"], result["unassigned_added"]) == (
        1,
        0,
        1,
    )
    assert api.get(f"/api/students/{kabir['id']}").json()["total_paid_paise"] == 150000
    # Nikhil has a uid of his own: a later upload of the same file can't mix them up.
    again = preview(api, edited)
    assert by_row(again["students"])[3]["status"] == "similar"
    with session_factory()() as session:
        uids = ensure_uids(session)
    assert len(set(uids.values())) == 2


def test_a_row_renamed_over_a_student_here_is_not_them(api: TestClient) -> None:
    kabir = _kabir(api)
    content = api.get("/api/export/everything.xlsx").content

    def rename(book: Any) -> None:
        book["Students"]["A2"] = "Nikhil Rao"
        book["Payments"]["A2"] = "Nikhil Rao"
        book["Payments"]["C2"] = 2500  # a different payment

    shown = preview(api, _edited(content, rename))
    [student] = shown["students"]
    assert student["status"] == "similar"
    assert student["reason"].startswith("Has the Student ID of Kabir Mehta (90000 00001)")
    [payment] = shown["payments"]
    assert payment["status"] == "follows_student"  # to Nikhil if she adds him, else kept
    commit(api, shown)  # the defaults: skip Nikhil, keep his payment unassigned
    assert api.get(f"/api/students/{kabir['id']}").json()["total_paid_paise"] == 150000
    assert len(api.get("/api/unassigned-payments").json()) == 1


def test_add_is_refused_for_a_different_file(api: TestClient) -> None:
    head = ["Name", "Monthly fee"]
    first = preview(api, xlsx(("Students", [head, ["Diya Nair", 1200]])))
    other = preview(api, xlsx(("Students", [head, ["Diya Nair", 1200], ["Zoya Khan", 900]])))
    body = {**commit_body(other), "file_sha256": first["file_sha256"]}
    response = api.post("/api/import/commit", json=body)
    assert response.status_code == 422
    [item] = response.json()["detail"]
    assert item["msg"] == "The file changed since you previewed it. Please upload it again."
    assert api.get("/api/students").json() == []


def test_add_refuses_a_huge_body_without_reading_or_echoing_it(api: TestClient) -> None:
    huge = b'{"file": "' + b"A" * (9 * 1024 * 1024) + b'"}'
    response = api.post(
        "/api/import/commit", content=huge, headers={"content-type": "application/json"}
    )
    assert response.status_code == 422
    assert response.json() == {
        "detail": [
            {
                "loc": ["body"],
                "msg": "This is too big to add. Upload a file under 5 MB.",
                "type": "value_error",
            }
        ]
    }
    # Under the limit, a body that isn't right says what's wrong, but never echoes it.
    bad = {"file": "A" * 7_500_000, "file_sha256": "0" * 64}
    response = api.post("/api/import/commit", json=bad)
    assert response.status_code == 422
    assert len(response.content) < 2000
    assert "input" not in response.json()["detail"][0]


def test_uids_are_given_once_even_by_downloads_at_the_same_moment(api: TestClient) -> None:
    for n in range(30):
        make_student(api, name=f"Student {n}")
    found: list[dict[int, str]] = []

    def download() -> None:
        with session_factory()() as session:
            found.append(ensure_uids(session))

    threads = [threading.Thread(target=download) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(found) == 4
    assert all(f == found[0] for f in found)  # everyone saw the same uids
    assert len(set(found[0].values())) == 30
    # And a later download keeps them.
    api.get("/api/export/everything.xlsx")
    with session_factory()() as session:
        assert ensure_uids(session) == found[0]
