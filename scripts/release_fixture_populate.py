"""Fill a fresh database through a *released* version's own API. Run by
`scripts/make_release_fixture.py`, never by hand: it runs inside a checkout of the release tag,
with that tag's Python environment, so `import app` is the released code, and the database is
created by that release's own startup (backups, migrations) and API.

    SCRAPPY_HOME=<empty folder> python release_fixture_populate.py --today 2026-09-30

Everything is fictional (made-up names, 98765 xxxxx phone numbers) and relative to `--today`,
so the same tag and day always give the same rows.

It must cover every kind of data a release can store. When a release adds a new kind (a new
table, a new field, a new way to save something), add it here, guarded by `has(...)` so older
tags, which don't have that endpoint or field, still work.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
from typing import Any

from fastapi.testclient import TestClient

from app.clock import get_today
from app.main import create_app


def month(today: dt.date, offset: int) -> str:
    """ "YYYY-MM", `offset` months from today's month."""
    index = today.year * 12 + today.month - 1 + offset
    return f"{index // 12:04d}-{index % 12 + 1:02d}"


class Api:
    def __init__(self, client: TestClient, today: dt.date) -> None:
        self.client = client
        self.today = today
        spec = client.get("/api/openapi.json").json()
        self.paths: dict[str, Any] = spec["paths"]
        self.schemas: dict[str, Any] = spec.get("components", {}).get("schemas", {})

    def has(self, path: str, method: str = "get", field: str | None = None) -> bool:
        """Whether this release has the endpoint (and, for a request body, the field)."""
        op = self.paths.get(path, {}).get(method)
        if op is None:
            return False
        if field is None:
            return True
        ref = op["requestBody"]["content"]["application/json"]["schema"]["$ref"]
        return field in self.schemas[ref.rsplit("/", 1)[1]]["properties"]

    def call(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        response = self.client.request(method, path, json=body)
        if response.status_code >= 400:
            sys.exit(f"{method} {path} {body} -> {response.status_code}: {response.text}")
        return response.json() if response.content else None

    def student(self, **fields: Any) -> int:
        return self.call("POST", "/api/students", fields)["id"]

    def pay(
        self,
        student_id: int,
        for_month: str,
        amount_paise: int,
        method: str = "upi",
        paid_on: str | None = None,
        note: str | None = None,
    ) -> int:
        body: dict[str, Any] = {
            "student_id": student_id,
            "amount_paise": amount_paise,
            "for_month": for_month,
            "paid_on": paid_on or min(f"{for_month}-05", self.today.isoformat()),
            "method": method,
        }
        if note is not None:
            body["note"] = note
        return self.call("POST", "/api/payments", body)["id"]


def populate(api: Api) -> None:
    t = api.today
    m = lambda offset: month(t, offset)  # noqa: E731
    batch_a = "Mon/Wed 5pm \N{EN DASH} Koramangala"
    batch_b = "Sat 10am \N{EN DASH} Jayanagar Studio"

    # --- An active student with a long, mostly paid history, a raise and a scheduled raise.
    ananya = api.student(
        name="Ananya Rao",
        monthly_fee_paise=150000,
        joined_month=m(-8),
        phone="98765 43210",
        guardian_name="Lakshmi Rao",
        batch_label=batch_a,
        notes="Prefers the evening batch.\nSister may join next year.",
    )
    api.call(
        "PATCH",
        f"/api/students/{ananya}",
        {"monthly_fee_paise": 180000, "fee_effective_month": m(-3)},
    )
    # Scheduled: a fee change that hasn't started yet.
    api.call(
        "PATCH",
        f"/api/students/{ananya}",
        {"monthly_fee_paise": 200000, "fee_effective_month": m(2)},
    )
    for offset in range(-8, -3):
        api.pay(ananya, m(offset), 150000, "upi")
    api.pay(ananya, m(-3), 180000, "cash", note="Paid at class")
    # Partial, then the rest in a second payment.
    api.pay(ananya, m(-2), 100000, "upi", note="Part 1 of 2")
    api.pay(ananya, m(-2), 80000, "upi", paid_on=f"{m(-2)}-20", note="Part 2 of 2")
    # This month: partial only.
    api.pay(ananya, m(0), 90000, "other", note="Bank transfer (NEFT)")

    # --- Left: joined, paid, then left. A payment after leaving (for a month after left).
    kabir = api.student(
        name="Kabir Mehta",
        monthly_fee_paise=250000,
        joined_month=m(-10),
        phone="98765 43211",
        guardian_name="Sunil Mehta",
        batch_label=batch_b,
    )
    for offset in range(-10, -3):
        api.pay(kabir, m(offset), 250000, "cash")
    api.call("PATCH", f"/api/students/{kabir}", {"left_month": m(-3), "notes": "Moved to Pune."})
    api.pay(kabir, m(-1), 250000, "upi", note="Paid after leaving by mistake")

    # --- Left, then came back: months away (an 'away' fee change) and a new fee from the return.
    diya = api.student(
        name="Diya D'Souza",
        monthly_fee_paise=120000,
        joined_month=m(-9),
        phone="98765 43212",
        guardian_name="Maria D'Souza",
        batch_label=batch_a,
    )
    for offset in range(-9, -6):
        api.pay(diya, m(offset), 120000, "upi")
    api.call("PATCH", f"/api/students/{diya}", {"left_month": m(-7)})
    if api.has("/api/students/{student_id}/return", "post"):
        api.call(
            "POST",
            f"/api/students/{diya}/return",
            {"from_month": m(-3), "monthly_fee_paise": 130000},
        )
    else:
        api.call("PATCH", f"/api/students/{diya}", {"left_month": None})
    for offset in range(-3, 0):
        api.pay(diya, m(offset), 130000, "upi")

    # --- A free place: ₹0 fee. Plus a month off (a ₹0 fee the owner set) for someone else.
    api.student(
        name="Ishaan Gupta",
        monthly_fee_paise=0,
        joined_month=m(-5),
        notes="Scholarship \N{EN DASH} no fee.",
    )

    # --- Joined this month; paid in advance for next month too, and overpaid this month.
    vihaan = api.student(
        name="Vihaan Joshi",
        monthly_fee_paise=200000,
        joined_month=m(0),
        phone="98765 43213",
        guardian_name="Neha Joshi",
        batch_label=batch_b,
    )
    api.pay(vihaan, m(0), 250000, "cash", note="Gave ₹2,500 for ₹2,000")
    api.pay(vihaan, m(1), 200000, "upi", paid_on=t.isoformat(), note="Advance")
    api.pay(vihaan, m(2), 200000, "upi", paid_on=t.isoformat(), note="Advance")

    # --- Unicode names; a payment for a month before they joined; a month off.
    zoe = api.student(
        name="Zoë Fernandes",
        monthly_fee_paise=100000,
        joined_month=m(-4),
        phone="+91 98765 43214",
        batch_label="Weekend \N{EN DASH} Café studio",
    )
    api.pay(zoe, m(-5), 100000, "cash", paid_on=f"{m(-5)}-28", note="Trial month, before joining")
    api.pay(zoe, m(-4), 100000, "upi")
    api.call(
        "PATCH",
        f"/api/students/{zoe}",
        {"monthly_fee_paise": 0, "fee_effective_month": m(-2)},
    )
    api.call(
        "PATCH",
        f"/api/students/{zoe}",
        {"monthly_fee_paise": 100000, "fee_effective_month": m(-1)},
    )

    anika = api.student(
        name="अनिका शर्मा",
        monthly_fee_paise=150000,
        joined_month=m(-6),
        phone="98765 43215",
        guardian_name="राजेश शर्मा",
        notes="नोट: शनिवार को आती है 🙂",
    )
    api.pay(anika, m(-6), 150000, "upi", note="पहली फ़ीस")
    api.pay(anika, m(-4), 300000, "cash", note="Two months together")

    # --- Owes a backlog: never paid anything.
    api.student(
        name="Arjun Menon",
        monthly_fee_paise=120000,
        joined_month=m(-4),
        phone="98765 43216",
        guardian_name="Vivek Menon",
        batch_label=batch_a,
    )

    # --- A student with every field empty but the required ones.
    tara = api.student(name="Tara", monthly_fee_paise=80000, joined_month=m(-1))

    # --- Edits and deletes, through the API as the owner would, so ids have gaps and edited
    # rows differ from how they were first saved: a renumbering would show. (SQLite reuses the
    # highest id, so each deleted row has a newer row saved after it before it goes.)
    rohan = api.student(
        name="Rohan Desai",
        monthly_fee_paise=250000,
        joined_month=m(-2),
        phone="98765 43218",
        notes="Added by mistake",
    )
    api.pay(rohan, m(-2), 250000, "upi")
    api.pay(rohan, m(-1), 250000, "cash")
    api.call("PATCH", f"/api/students/{rohan}", {"monthly_fee_paise": 260000})
    mistake = api.pay(kabir, m(-6), 250000, "upi", note="Logged twice")

    # --- Amounts that aren't round: paise, ₹1,499.50, ₹9,999.99 and the largest allowed
    # (MAX_AMOUNT_PAISE, ₹10,00,000), so rounding to rupees (or anything else) shows.
    most = 100_000_000
    nisha = api.student(
        name="Nisha Kulkarni",
        monthly_fee_paise=149_950,
        joined_month=m(-3),
        phone="98765 43217",
        batch_label=batch_b,
    )
    api.pay(nisha, m(-3), 149_950, "upi", note="₹1,499.50")
    api.pay(nisha, m(-2), 1, "other", note="1 paisa test transfer")
    api.pay(nisha, m(-2), 149_949, "upi")
    api.pay(nisha, m(-1), 999_999, "cash", note="₹9,999.99")
    api.pay(nisha, m(1), most, "other", note="Largest allowed amount")
    for amount, offset in ((999_999, -1), (most, 3), (1, 4)):
        api.call(
            "PATCH",
            f"/api/students/{nisha}",
            {"monthly_fee_paise": amount, "fee_effective_month": m(offset)},
        )

    # A payment edited (amount, method, note and month).
    edited = api.pay(tara, m(-1), 80000, "upi", note="Typo")
    api.call(
        "PATCH",
        f"/api/payments/{edited}",
        {"amount_paise": 79_950, "method": "cash", "note": "Edited: ₹50 off", "for_month": m(0)},
    )
    # A scheduled fee change, to be removed before it starts.
    api.call(
        "PATCH",
        f"/api/students/{tara}",
        {"monthly_fee_paise": 90000, "fee_effective_month": m(3)},
    )
    scheduled = api.call("GET", f"/api/students/{tara}")["fee_history"][-1]
    kiran = api.student(name="Kiran Bose", monthly_fee_paise=110000, joined_month=m(0))
    api.pay(kiran, m(0), 110000, "upi")

    # --- Batches (since v0.2): some made from the old labels, some by hand, with every field;
    # a student moved between batches, a batch's fee charged to one student, and a batch
    # deleted (its students are then in no batch).
    if api.has("/api/batches", "post"):
        api.call("POST", "/api/batches/from-labels")
        evening = next(
            b for b in api.call("GET", "/api/batches") if b["name"].startswith("Mon/Wed")
        )
        api.call(
            "PATCH",
            f"/api/batches/{evening['id']}",
            {
                "location": "Koramangala",
                "days": ["mon", "wed"],
                "start_time": "17:00",
                "end_time": "18:00",
                "default_fee_paise": 180000,
                "notes": "Hall B \N{EN DASH} upstairs",
                "apply_fee": {"from_month": m(1), "student_ids": [ananya]},
            },
        )
        café = api.call(
            "POST",
            "/api/batches",
            {
                "name": "Café Seniors \N{EN DASH} रविवार",
                "location": "Café studio",
                "days": ["sat", "sun"],
                "start_time": "09:30",
                "end_time": "11:00",
                "default_fee_paise": 149_950,
            },
        )
        api.call("PATCH", f"/api/students/{anika}", {"batch_id": café["id"]})
        api.call("PATCH", f"/api/students/{zoe}", {"batch_id": café["id"]})
        gone = api.call("POST", "/api/batches", {"name": "Trial batch"})
        api.call("PATCH", f"/api/students/{kiran}", {"batch_id": gone["id"]})
        api.call("DELETE", f"/api/batches/{gone['id']}")

    # Now the deletes: a student with payments and fee changes (theirs go with them), a
    # payment, and the scheduled fee change.
    api.call("DELETE", f"/api/students/{rohan}")
    api.call("DELETE", f"/api/payments/{mistake}")
    api.call("DELETE", f"/api/students/{tara}/fee-changes/{scheduled['id']}")

    # In-app feedback (saved on the laptop; make_release_fixture.py turns sending off). A fixed
    # id, and no picture: a screenshot is a file beside the database, not a row. Its
    # diagnostics (a random install ID, the log's last lines) differ from run to run.
    if api.has("/api/feedback", "post"):
        api.call(
            "POST",
            "/api/feedback",
            {
                "id": "00000000-0000-4000-8000-000000000001",
                "category": "idea",
                "message": "Could the dashboard show last month too?\nThanks — Ananya's mum",
                "route": "/?month=" + m(-1),
                "client": {"local_time": f"{api.today.isoformat()}T10:30:00+05:30"},
            },
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--today", required=True, type=dt.date.fromisoformat)
    args = parser.parse_args()
    if not os.environ.get("SCRAPPY_HOME") or not os.environ.get("SCRAPPY_BACKUP_DIR"):
        sys.exit("Set SCRAPPY_HOME and SCRAPPY_BACKUP_DIR to an empty folder first.")

    app = create_app()
    app.dependency_overrides[get_today] = lambda: args.today
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        populate(Api(client, args.today))


if __name__ == "__main__":
    main()
