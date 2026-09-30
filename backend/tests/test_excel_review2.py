"""Uploads, second review: Student IDs that follow the student (not the database's ids), older
files uploaded after an edit, shortened names, lists that only look like payments, huge merged
cells and big restores."""

from __future__ import annotations

import io
import time

from fastapi.testclient import TestClient
from helpers import make_student, pay
from openpyxl import Workbook
from test_excel_export import _look_alikes, _records, _wipe
from test_excel_import import by_row, commit, preview, xlsx
from test_excel_review import _rewrite

STUDENT_HEAD = ["Name", "Phone", "Monthly fee", "Joined"]
PAYMENT_HEAD = ["Student", "Phone", "Amount", "Paid on", "For month", "Method", "Note"]


def test_a_restore_with_shifted_ids_then_the_same_file_again(api: TestClient) -> None:
    """Restored where the database ids came out different (someone added first), the same
    file uploaded again still finds each student: nobody's payment moves to a look-alike."""
    _look_alikes(api)
    content = api.get("/api/export/everything.xlsx").content
    _wipe(api)
    make_student(api, name="Zoya Qureshi")  # takes the first id: every restored id shifts
    commit(api, preview(api, content))
    after_restore = _records(api)

    again = preview(api, content)
    assert [s["status"] for s in again["students"]] == ["exists"] * 6
    assert {p["status"] for p in again["payments"]} == {"duplicate"}
    result = commit(api, again)
    assert (result["students_added"], result["payments_added"], result["unassigned_added"]) == (
        0,
        0,
        0,
    )
    assert _records(api) == after_restore


def test_without_ids_two_matches_are_never_picked_silently(api: TestClient) -> None:
    first = make_student(api, name="Priya S", joined_month="2026-01")
    second = make_student(api, name="Priya S", joined_month="2026-03")
    pay(api, second["id"], "2026-03")
    data = xlsx(
        ("Students", [STUDENT_HEAD, ["Priya S", None, 1500, "Mar 2026"]]),
        (
            "Payments",
            [PAYMENT_HEAD, ["Priya S", None, 1500, "2026-03-05", "Mar 2026", "UPI", None]],
        ),
    )
    shown = preview(api, data)
    [student] = shown["students"]
    assert student["status"] == "similar"
    assert student["reason"].startswith("2 students here are called Priya S, with no phone")
    [payment] = shown["payments"]
    # Her payment is already here, under one of them: not kept again as unassigned.
    assert payment["status"] == "duplicate"
    result = commit(api, shown)
    assert (result["students_added"], result["payments_added"], result["unassigned_added"]) == (
        0,
        0,
        0,
    )
    assert first["id"] != second["id"]


def test_an_older_download_after_a_phone_change_adds_nothing(api: TestClient) -> None:
    kabir = make_student(api, name="Kabir Mehta", phone="90000 00001")
    pay(api, kabir["id"], "2026-02")
    old = api.get("/api/export/everything.xlsx").content
    api.patch(f"/api/students/{kabir['id']}", json={"phone": "90000 00099"})

    shown = preview(api, old)
    [row] = shown["students"]
    # The phone in the file isn't his any more: he only looks like the row, and she chooses.
    assert row["status"] == "similar"
    assert row["reason"].startswith("Has the Student ID of Kabir Mehta (90000 00099)")
    # His payment in the file is his payment here: not added again, not kept as unassigned.
    assert {p["status"] for p in shown["payments"]} == {"duplicate"}
    assert commit(api, shown)["backup_file"] is None  # nothing to add

    # The same without Student IDs (a list typed by hand): the payment is still recognised.
    listing = xlsx(
        ("Students", [STUDENT_HEAD, ["Kabir Mehta", "90000 00001", 1500, "Jan 2026"]]),
        ("Payments", [PAYMENT_HEAD, ["Kabir Mehta", "90000 00001", 1500, "2026-02-05",
                                     "Feb 2026", "UPI", None]]),
    )  # fmt: skip
    shown = preview(api, listing)
    assert shown["students"][0]["status"] == "similar"
    assert shown["payments"][0]["status"] == "duplicate"
    assert shown["payments"][0]["reason"].startswith("Already logged for Kabir Mehta")
    result = commit(api, shown)
    assert (result["students_added"], result["unassigned_added"]) == (0, 0)
    assert len(api.get("/api/unassigned-payments").json()) == 0


def test_shortened_names_look_similar(api: TestClient) -> None:
    make_student(api, name="Ananya Rao")
    make_student(api, name="Aarav Bhat")
    data = xlsx(
        (
            "Students",
            [
                STUDENT_HEAD,
                ["Ananya R", None, 1500, None],
                ["A Bhat", None, 1500, None],
                ["Kavya Rao", None, 1500, None],  # shares a word, but isn't a short form
            ],
        )
    )
    rows = by_row(preview(api, data)["students"])
    assert rows[2]["status"] == "similar"
    assert rows[2]["reason"] == "Name is like Ananya Rao (one of them is shortened)"
    assert rows[3]["status"] == "similar"
    assert rows[4]["status"] == "new"


def test_a_students_list_with_a_date_is_students(api: TestClient) -> None:
    data = xlsx(
        (
            "Sheet1",
            [["Name", "Mobile", "Fee", "Date"], ["Diya Nair", "90000 00005", 1200, "1/4/2026"]],
        )
    )
    shown = preview(api, data)
    assert shown["payments"] == []
    assert shown["students"][0]["status"] == "new"


def test_a_second_person_of_the_same_name_can_be_added(api: TestClient) -> None:
    data = xlsx(
        ("Students", [STUDENT_HEAD, ["Priya S", None, 1500, None], ["Priya S", None, 1200, None]])
    )
    shown = preview(api, data)
    rows = by_row(shown["students"])
    assert rows[3]["status"] == "similar" and rows[3]["add_by_default"] is False
    assert commit(api, shown, students={3: True})["students_added"] == 2


def test_a_huge_merged_range_in_a_tiny_file_is_quick(api: TestClient) -> None:
    data = xlsx(("Students", [STUDENT_HEAD, ["Kabir Mehta", None, 1500, None]]))
    # One merge over a million rows and every column (written into the file's XML directly:
    # Excel stores it in a few bytes).
    huge = _rewrite(
        data,
        "xl/worksheets/sheet1.xml",
        lambda xml: xml.replace(
            b"</sheetData>",
            b'</sheetData><mergeCells count="1"><mergeCell ref="F1:XFD1048576"/></mergeCells>',
        ),
    )
    started = time.monotonic()
    shown = preview(api, huge)
    assert time.monotonic() - started < 5
    assert shown["students"][0]["status"] == "new"


def test_a_big_restore_previews_in_part_and_adds_everything(api: TestClient) -> None:
    """A Download everything file bigger than any hand-made list: the preview lists the rows
    that need a choice and the first few of the rest, with counts; Add reads the file again
    and adds all of it."""
    book = Workbook()
    ws = book.active
    ws.title = "Students"
    ws.append(["Name", "Phone", "Monthly fee", "Joined", "Student ID"])
    for n in range(1500):
        ws.append([f"Student {n:04d} Rao", f"9{n:09d}", 1000, "Jan 2025", f"{n:032x}"])
    payments = book.create_sheet("Payments")
    payments.append(["Student", "Amount", "Paid on", "For month", "Method", "Student ID"])
    for n in range(30_000):
        month = 1 + n // 1500 % 12
        payments.append([f"Student {n % 1500:04d} Rao", 1000, f"2025-{month:02d}-05",
                         f"2025-{month:02d}", "UPI", f"{n % 1500:032x}"])  # fmt: skip
    out = io.BytesIO()
    book.save(out)
    started = time.monotonic()
    shown = preview(api, out.getvalue())
    assert shown["all_rows_shown"] is False
    assert shown["student_counts"] == {"new": 1500}
    assert shown["payment_counts"]["ready"] + shown["payment_counts"].get("duplicate", 0) == 30_000
    assert len(shown["payments"]) <= 300
    result = commit(api, shown)
    assert result["students_added"] == 1500
    assert result["payments_added"] + result["skipped"] == 30_000
    assert time.monotonic() - started < 90
