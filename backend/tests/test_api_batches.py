"""Batches: create, edit and delete them, place students in them, each batch's fees for a month
(which add up to the dashboard's), and turning the old labels into batches."""

from __future__ import annotations

import sqlite3
from typing import Any

import pytest
from fastapi.testclient import TestClient
from helpers import Json, make_student, pay

from app import backup, config

# The `api` fixture's current month is June 2026.


def make_batch(api: TestClient, **fields: Any) -> Json:
    body: dict[str, Any] = {"name": "Mon/Wed Evening"}
    body.update(fields)
    response = api.post("/api/batches", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def detail_of(api: TestClient, student_id: int) -> Json:
    return api.get(f"/api/students/{student_id}").json()


def fees_of(api: TestClient, student_id: int) -> list[tuple[str, int, str]]:
    return [
        (f["effective_month"], f["amount_paise"], f["kind"])
        for f in detail_of(api, student_id)["fee_history"]
    ]


def error(response: Any) -> tuple[list[str], str]:
    [item] = response.json()["detail"]
    return item["loc"], item["msg"]


# --------------------------------------------------------------------------- create, edit, delete


def test_create_and_read_a_batch(api: TestClient) -> None:
    batch = make_batch(
        api,
        name="  Tue/Thu Juniors ",
        location="HSR Layout",
        days=["thu", "tue", "thu"],
        start_time="17:00",
        end_time="18:30",
        default_fee_paise=180000,
        notes="Hall B",
    )
    assert batch["name"] == "Tue/Thu Juniors"
    assert batch["days"] == ["tue", "thu"]  # Monday first, each once
    assert (batch["start_time"], batch["end_time"]) == ("17:00", "18:30")
    assert batch["default_fee_paise"] == 180000
    assert (batch["student_count"], batch["active_student_count"]) == (0, 0)
    assert batch["created_at"].endswith("Z")
    assert api.get(f"/api/batches/{batch['id']}").json() == batch

    only_name = make_batch(api, name="Saturday")
    assert only_name["days"] == []
    assert only_name["location"] is None and only_name["default_fee_paise"] is None


def test_batches_are_sorted_by_name_with_counts(api: TestClient) -> None:
    b = make_batch(api, name="sunday seniors")
    a = make_batch(api, name="Évening")
    make_student(api, name="Kabir Mehta", batch_id=b["id"])
    make_student(api, name="Rohan Desai", batch_id=b["id"], left_month="2026-03")
    listed = api.get("/api/batches").json()
    assert [x["id"] for x in listed] == [a["id"], b["id"]]  # accents and capitals ignored
    assert (listed[1]["student_count"], listed[1]["active_student_count"]) == (2, 1)


@pytest.mark.parametrize(
    ("body", "field", "msg"),
    [
        ({"name": "   "}, "name", "Name is required"),
        ({"name": "A", "start_time": "5pm"}, "start_time", "Enter a time like 17:30"),
        ({"name": "A", "end_time": "24:00"}, "end_time", "Enter a time like 17:30"),
        (
            {"name": "A", "start_time": "18:00", "end_time": "17:00"},
            "end_time",
            "The end time must be after the start time",
        ),
        ({"name": "A", "default_fee_paise": 100000001}, "default_fee_paise", None),
        ({"name": "A", "default_fee_paise": -1}, "default_fee_paise", None),
        ({"name": "A", "days": ["someday"]}, "days", None),
    ],
)
def test_create_rejects_bad_input(
    api: TestClient, body: dict[str, Any], field: str, msg: str | None
) -> None:
    response = api.post("/api/batches", json=body)
    assert response.status_code == 422
    loc, message = response.json()["detail"][0]["loc"], response.json()["detail"][0]["msg"]
    assert loc[:2] == ["body", field]
    if msg:
        assert message == msg


def test_names_are_unique_ignoring_capitals_and_spaces(api: TestClient) -> None:
    make_batch(api, name="Tue/Thu 5pm")
    for name in ("tue/thu 5PM", "Tue/Thu  5pm", "Tue/Thu5pm"):
        response = api.post("/api/batches", json={"name": name})
        assert response.status_code == 422
        assert error(response) == (
            ["body", "name"],
            "There's already a batch called Tue/Thu 5pm. Choose another name.",
        )
    other = make_batch(api, name="Saturday")
    response = api.patch(f"/api/batches/{other['id']}", json={"name": "TUE/THU 5PM"})
    assert response.status_code == 422
    # Renaming a batch to its own name, in other capitals, is fine.
    response = api.patch(f"/api/batches/{other['id']}", json={"name": "SATURDAY"})
    assert response.status_code == 200 and response.json()["name"] == "SATURDAY"


def test_the_database_refuses_a_duplicate_name_too(api: TestClient) -> None:
    make_batch(api, name="Saturday")
    with sqlite3.connect(config.db_path()) as conn, pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO batches (name) VALUES ('saturday')")


def test_update_is_partial(api: TestClient) -> None:
    batch = make_batch(api, start_time="17:00", end_time="18:00", location="Koramangala")
    response = api.patch(
        f"/api/batches/{batch['id']}", json={"days": ["sat", "mon"], "location": " "}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["days"] == ["mon", "sat"] and body["location"] is None
    assert (body["start_time"], body["end_time"], body["name"]) == ("17:00", "18:00", batch["name"])
    # Checked against the stored start time.
    response = api.patch(f"/api/batches/{batch['id']}", json={"end_time": "16:00"})
    assert error(response) == (["body", "end_time"], "The end time must be after the start time")
    response = api.patch(f"/api/batches/{batch['id']}", json={"start_time": "19:00"})
    assert error(response)[0] == ["body", "start_time"]
    for body in ({"name": None}, {"days": None}):
        assert api.patch(f"/api/batches/{batch['id']}", json=body).status_code == 422
    assert api.patch(f"/api/batches/{batch['id']}", json={"colour": "red"}).status_code == 422


def test_missing_batches_are_404(api: TestClient) -> None:
    for method in ("get", "patch", "delete"):
        response = api.request(method, "/api/batches/999", json={} if method == "patch" else None)
        assert response.status_code == 404
        assert response.json() == {"detail": "No batch with id 999"}
    assert api.get(f"/api/batches/{2**70}").status_code in (404, 422)


def test_deleting_a_batch_keeps_its_students_in_no_batch(api: TestClient) -> None:
    batch = make_batch(api)
    other = make_batch(api, name="Other")
    a = make_student(api, name="Ananya Rao", batch_id=batch["id"])
    b = make_student(api, name="Kabir Mehta", batch_id=other["id"])
    pay(api, a["id"], "2026-05")
    assert api.delete(f"/api/batches/{batch['id']}").status_code == 204
    after = detail_of(api, a["id"])
    assert (after["batch_id"], after["batch_name"]) == (None, None)
    assert after["payment_count"] == 1  # nothing of theirs went
    assert detail_of(api, b["id"])["batch_id"] == other["id"]
    assert [x["id"] for x in api.get("/api/batches").json()] == [other["id"]]


def test_the_database_itself_takes_students_out_of_a_deleted_batch(api: TestClient) -> None:
    """ON DELETE SET NULL, for a batch deleted outside the app's own code."""
    batch = make_batch(api)
    s = make_student(api, batch_id=batch["id"])
    with sqlite3.connect(config.db_path()) as conn:
        conn.execute("PRAGMA foreign_keys=ON")
        [link] = [
            r for r in conn.execute("PRAGMA foreign_key_list(students)") if r[3] == "batch_id"
        ]
        assert (link[2], link[4], link[6]) == ("batches", "id", "SET NULL")
        conn.execute("DELETE FROM batches WHERE id = ?", (batch["id"],))
    assert detail_of(api, s["id"])["batch_id"] is None


# --------------------------------------------------------------------------- students in batches


def test_students_are_placed_in_a_batch(api: TestClient) -> None:
    batch = make_batch(api, name="Saturday Morning")
    s = make_student(api, batch_id=batch["id"], batch_label="Sat 10am")
    assert (s["batch_id"], s["batch_name"], s["batch_label"]) == (
        batch["id"],
        "Saturday Morning",
        "Sat 10am",
    )
    [listed] = api.get("/api/students").json()
    assert listed["batch_name"] == "Saturday Morning"

    other = make_batch(api, name="Sunday")
    moved = api.patch(f"/api/students/{s['id']}", json={"batch_id": other["id"]}).json()
    assert (moved["batch_id"], moved["batch_name"]) == (other["id"], "Sunday")
    assert moved["batch_label"] == "Sat 10am"  # the old label is kept as typed
    # Any other change leaves the batch alone.
    assert (
        api.patch(f"/api/students/{s['id']}", json={"notes": "x"}).json()["batch_id"]
        == (other["id"])
    )
    removed = api.patch(f"/api/students/{s['id']}", json={"batch_id": None}).json()
    assert (removed["batch_id"], removed["batch_name"]) == (None, None)


@pytest.mark.parametrize("bad", [999, 2**62])
def test_a_missing_batch_is_a_422(api: TestClient, bad: int) -> None:
    body = {"name": "Ananya Rao", "monthly_fee_paise": 1, "joined_month": "2026-01"}
    response = api.post("/api/students", json={**body, "batch_id": bad})
    assert error(response) == (
        ["body", "batch_id"],
        "That batch doesn't exist any more. Choose another one, or No batch.",
    )
    s = make_student(api)
    response = api.patch(f"/api/students/{s['id']}", json={"batch_id": bad})
    assert error(response)[0] == ["body", "batch_id"]
    for wrong in ("1", 1.5, True, 0, -1):
        assert api.post("/api/students", json={**body, "batch_id": wrong}).status_code == 422


def test_students_list_filters_by_batch_and_location(api: TestClient) -> None:
    kora = make_batch(api, name="Mon/Wed", location="Koramangala ")
    kora2 = make_batch(api, name="Fri", location="koramangala")
    hsr = make_batch(api, name="Tue/Thu", location="HSR Layout")
    a = make_student(api, name="Ananya Rao", batch_id=kora["id"])
    b = make_student(api, name="Kabir Mehta", batch_id=kora2["id"])
    c = make_student(api, name="Meera Iyer", batch_id=hsr["id"])
    d = make_student(api, name="Diya Nair")

    def names(**params: str) -> list[str]:
        response = api.get("/api/students", params={"status": "all", **params})
        assert response.status_code == 200, response.text
        return [s["name"] for s in response.json()]

    assert names(batch=str(kora["id"])) == [a["name"]]
    assert names(batch="none") == [d["name"]]
    assert names(batch="NONE") == [d["name"]]
    assert names(location="KORAMANGALA") == [a["name"], b["name"]]
    assert names(location="hsr  layout") == [c["name"]]
    assert names(location="hsrlayout", batch=str(kora["id"])) == []
    assert names(batch=str(2**70)) == []
    assert names(batch="") == names()
    response = api.get("/api/students", params={"batch": "Mon/Wed"})
    assert error(response) == (["query", "batch"], "Choose a batch by its number, or none")


# --------------------------------------------------------------------------- the default fee


def test_a_new_default_fee_changes_no_students_fee(api: TestClient) -> None:
    batch = make_batch(api, default_fee_paise=150000)
    s = make_student(api, batch_id=batch["id"])
    before = fees_of(api, s["id"])
    response = api.patch(f"/api/batches/{batch['id']}", json={"default_fee_paise": 180000})
    assert response.status_code == 200 and response.json()["default_fee_paise"] == 180000
    assert fees_of(api, s["id"]) == before


def test_applying_the_fee_to_chosen_students(api: TestClient) -> None:
    batch = make_batch(api, default_fee_paise=150000)
    regular = make_student(api, name="Ananya Rao", batch_id=batch["id"])
    discount = make_student(api, name="Kabir Mehta", batch_id=batch["id"], monthly_fee_paise=120000)
    joins_later = make_student(api, name="Meera Iyer", batch_id=batch["id"], joined_month="2026-09")
    leaves = make_student(api, name="Rohan Desai", batch_id=batch["id"], left_month="2026-06")
    response = api.patch(
        f"/api/batches/{batch['id']}",
        json={
            "default_fee_paise": 180000,
            "apply_fee": {
                "from_month": "2026-07",
                "student_ids": [regular["id"], joins_later["id"], leaves["id"]],
            },
        },
    )
    assert response.status_code == 200, response.text
    assert fees_of(api, regular["id"]) == [("2026-01", 150000, "fee"), ("2026-07", 180000, "fee")]
    assert fees_of(api, discount["id"]) == [("2026-01", 120000, "fee")]  # not chosen
    # Joins after July: their fee from the month they join.
    assert fees_of(api, joins_later["id"]) == [("2026-09", 180000, "fee")]
    # Left before July: nothing to charge.
    assert fees_of(api, leaves["id"]) == [("2026-01", 150000, "fee")]


def test_applying_the_fee_skips_months_away(api: TestClient) -> None:
    batch = make_batch(api, default_fee_paise=150000)
    s = make_student(api, batch_id=batch["id"], joined_month="2026-01", left_month="2026-02")
    back = api.post(f"/api/students/{s['id']}/return", json={"from_month": "2026-05"})
    assert back.status_code == 200, back.text
    assert fees_of(api, s["id"]) == [
        ("2026-01", 150000, "fee"),
        ("2026-03", 0, "away"),
        ("2026-05", 150000, "fee"),
    ]
    response = api.patch(
        f"/api/batches/{batch['id']}",
        json={
            "default_fee_paise": 180000,
            "apply_fee": {"from_month": "2026-04", "student_ids": [s["id"]]},
        },
    )
    assert response.status_code == 200
    # April is still a month away: the new fee starts when they came back.
    assert fees_of(api, s["id"]) == [
        ("2026-01", 150000, "fee"),
        ("2026-03", 0, "away"),
        ("2026-05", 180000, "fee"),
    ]


def test_applying_the_fee_is_all_or_nothing(api: TestClient) -> None:
    batch = make_batch(api, default_fee_paise=150000)
    other = make_batch(api, name="Other")
    mine = make_student(api, name="Ananya Rao", batch_id=batch["id"])
    theirs = make_student(api, name="Kabir Mehta", batch_id=other["id"])
    response = api.patch(
        f"/api/batches/{batch['id']}",
        json={
            "default_fee_paise": 180000,
            "apply_fee": {"from_month": "2026-07", "student_ids": [mine["id"], theirs["id"]]},
        },
    )
    assert error(response)[0] == ["body", "apply_fee"]
    assert fees_of(api, mine["id"]) == [("2026-01", 150000, "fee")]
    assert api.get(f"/api/batches/{batch['id']}").json()["default_fee_paise"] == 150000

    too_late = api.patch(
        f"/api/batches/{batch['id']}",
        json={
            "default_fee_paise": 180000,
            "apply_fee": {"from_month": "2029-01", "student_ids": [mine["id"]]},
        },
    )
    assert too_late.status_code == 422
    no_fee = api.patch(
        f"/api/batches/{batch['id']}",
        json={"apply_fee": {"from_month": "2026-07", "student_ids": [mine["id"]]}},
    )
    assert error(no_fee) == (
        ["body", "apply_fee"],
        "Send the new fee together with the students to charge it to",
    )


# --------------------------------------------------------------------------- a month's numbers


def _summaries(api: TestClient, month: str) -> Json:
    response = api.get("/api/batches/summary", params={"month": month})
    assert response.status_code == 200, response.text
    return response.json()


SUMMED = (
    "expected_paise",
    "collected_paise",
    "still_due_paise",
    "paid_ahead_paise",
    "not_fully_paid_count",
    "active_student_count",
)


def _mixed_school(api: TestClient) -> tuple[Json, Json]:
    a = make_batch(api, name="Mon/Wed", default_fee_paise=150000)
    b = make_batch(api, name="Sat", default_fee_paise=120000)
    s1 = make_student(api, name="Ananya Rao", batch_id=a["id"])
    s2 = make_student(api, name="Kabir Mehta", batch_id=a["id"], monthly_fee_paise=200000)
    s3 = make_student(
        api, name="Meera Iyer", batch_id=b["id"], monthly_fee_paise=120000, joined_month="2026-06"
    )
    s4 = make_student(api, name="Diya Nair", joined_month="2026-03")  # no batch
    s5 = make_student(api, name="Rohan Desai", batch_id=b["id"], left_month="2026-04")
    for m in ("2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"):
        pay(api, s1["id"], m)
    pay(api, s2["id"], "2026-06", 100000)  # partial; earlier months owed
    pay(api, s3["id"], "2026-06", 360000)  # June and two months ahead
    pay(api, s4["id"], "2026-05", 300000)  # May twice: covers March
    pay(api, s5["id"], "2026-02", 150000)
    return a, b


@pytest.mark.parametrize(
    "month", ["2026-02", "2026-04", "2026-05", "2026-06", "2026-07", "2026-09"]
)
def test_batches_add_up_to_the_dashboard(api: TestClient, month: str) -> None:
    _mixed_school(api)
    overview = _summaries(api, month)
    dashboard = api.get("/api/dashboard", params={"month": month}).json()["summary"]
    parts = [*overview["batches"], overview["no_batch"]]
    for key in SUMMED:
        assert sum(p[key] for p in parts) == dashboard[key], key


def test_a_batch_summary(api: TestClient) -> None:
    a, b = _mixed_school(api)
    june = _summaries(api, "2026-06")
    assert (june["month"], june["current_month"]) == ("2026-06", "2026-06")
    first, second = june["batches"]
    assert first == {
        "batch_id": a["id"],
        "student_count": 2,
        "active_student_count": 2,
        "expected_paise": 350000,
        "collected_paise": 250000,
        "still_due_paise": 100000,
        "paid_ahead_paise": 0,
        "not_fully_paid_count": 1,
        "paid_percent": 71,  # 2,500 of 3,500: rounded down
    }
    # Rohan left in April, so June is Meera's alone, and she's paid.
    assert second["batch_id"] == b["id"]
    assert (second["student_count"], second["paid_percent"]) == (1, 100)
    assert june["no_batch"]["batch_id"] is None
    # Paid ahead for July and August.
    july = _summaries(api, "2026-07")["batches"][1]
    assert (july["paid_ahead_paise"], july["paid_percent"]) == (120000, 100)


def test_a_batch_with_nothing_expected_has_no_percent(api: TestClient) -> None:
    make_batch(api)
    [empty] = _summaries(api, "2026-06")["batches"]
    assert empty["expected_paise"] == 0 and empty["paid_percent"] is None
    assert empty["student_count"] == 0


def test_paid_percent_only_says_100_when_everything_is_paid(api: TestClient) -> None:
    batch = make_batch(api)
    s = make_student(api, batch_id=batch["id"], monthly_fee_paise=100000, joined_month="2026-06")
    pay(api, s["id"], "2026-06", 99999)
    [one] = _summaries(api, "2026-06")["batches"]
    assert one["paid_percent"] == 99


def test_summary_month_is_checked(api: TestClient) -> None:
    assert api.get("/api/batches/summary", params={"month": "2026-13"}).status_code == 422
    assert api.get("/api/batches/summary").json()["month"] == "2026-06"


# --------------------------------------------------------------------------- old labels


def _backups() -> list[str]:
    folder = config.backup_dir()
    return (
        sorted(p.name for p in folder.glob("records-pre-batches-*.db")) if folder.exists() else []
    )


def test_label_preview_groups_ignoring_capitals_and_spaces(api: TestClient) -> None:
    make_student(api, name="Ananya Rao", batch_label="Tue/Thu 5pm")
    make_student(api, name="Kabir Mehta", batch_label="tue/thu  5PM")
    make_student(api, name="Meera Iyer", batch_label=" Tue/Thu 5pm ")
    make_student(api, name="Diya Nair", batch_label="Sat 10am")
    make_student(api, name="Rohan Desai")  # no label
    placed = make_batch(api, name="Sunday")
    make_student(api, name="Arjun Menon", batch_label="Sat 10am", batch_id=placed["id"])
    preview = api.get("/api/batches/from-labels").json()
    assert preview == {
        "groups": [
            {
                "name": "Sat 10am",
                "labels": ["Sat 10am"],
                "student_count": 1,
                "student_names": ["Diya Nair"],
                "existing_batch_id": None,
            },
            {
                "name": "Tue/Thu 5pm",
                "labels": ["Tue/Thu 5pm", "tue/thu 5PM"],
                "student_count": 3,
                "student_names": ["Ananya Rao", "Kabir Mehta", "Meera Iyer"],
                "existing_batch_id": None,
            },
        ],
        "student_count": 4,
        "new_batch_count": 2,
    }
    # The preview changes nothing.
    assert len(api.get("/api/batches").json()) == 1
    assert _backups() == []


def test_converting_labels(api: TestClient) -> None:
    a = make_student(api, name="Ananya Rao", batch_label="Tue/Thu 5pm")
    b = make_student(api, name="Kabir Mehta", batch_label="TUE/THU 5pm")
    c = make_student(api, name="Diya Nair", batch_label="Saturday")
    existing = make_batch(api, name="saturday", location="Jayanagar")
    response = api.post("/api/batches/from-labels")
    assert response.status_code == 200, response.text
    result = response.json()
    assert (result["batches_created"], result["students_placed"]) == (1, 3)
    assert result["backup_file"] in _backups()

    batches = {x["name"]: x for x in api.get("/api/batches").json()}
    assert set(batches) == {"saturday", "Tue/Thu 5pm"}
    tt = batches["Tue/Thu 5pm"]
    assert (tt["student_count"], tt["days"], tt["default_fee_paise"]) == (2, [], None)
    for s, batch_id in ((a, tt["id"]), (b, tt["id"]), (c, existing["id"])):
        after = detail_of(api, s["id"])
        assert after["batch_id"] == batch_id
        assert after["batch_label"] == s["batch_label"]  # kept exactly as typed

    # Again: nothing left to do, and no second backup.
    again = api.post("/api/batches/from-labels").json()
    assert again == {"batches_created": 0, "students_placed": 0, "backup_file": None}
    assert len(_backups()) == 1
    assert api.get("/api/batches/from-labels").json()["groups"] == []


def test_the_backup_holds_the_data_from_before(api: TestClient) -> None:
    make_student(api, name="Ananya Rao", batch_label="Tue/Thu 5pm")
    name = api.post("/api/batches/from-labels").json()["backup_file"]
    with sqlite3.connect(config.backup_dir() / name) as conn:
        assert conn.execute("SELECT count(*) FROM batches").fetchone() == (0,)
        assert conn.execute("SELECT batch_id, batch_label FROM students").fetchall() == [
            (None, "Tue/Thu 5pm")
        ]


def test_no_backup_no_change(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    s = make_student(api, batch_label="Tue/Thu 5pm")

    def broken(reason: str) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(backup, "backup", broken)
    response = api.post("/api/batches/from-labels")
    assert response.status_code == 422
    assert "Couldn't save a backup first" in error(response)[1]
    assert api.get("/api/batches").json() == []
    assert detail_of(api, s["id"])["batch_id"] is None


def test_the_monthly_report_shows_each_students_batch(api: TestClient) -> None:
    batch = make_batch(api, name="Saturday Morning")
    make_student(api, name="Ananya Rao", batch_id=batch["id"], batch_label="Sat 10am")
    make_student(api, name="Kabir Mehta", batch_label="Tue 5pm")
    rows = api.get("/api/report", params={"month": "2026-06"}).json()["rows"]
    by_name = {r["student_name"]: (r["batch_name"], r["batch_label"]) for r in rows}
    assert by_name == {
        "Ananya Rao": ("Saturday Morning", "Sat 10am"),
        "Kabir Mehta": (None, "Tue 5pm"),
    }


def test_numbers_in_names_sort_as_numbers(api: TestClient) -> None:
    for name in ("Batch 10", "batch 2", "Batch 1"):
        make_batch(api, name=name)
    names = [b["name"] for b in api.get("/api/batches").json()]
    assert names == ["Batch 1", "batch 2", "Batch 10"]
