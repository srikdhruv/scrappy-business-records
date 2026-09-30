"""The real app with the clock frozen, for the feature guide's pictures (`make guide-screenshots`).

    uv run --project backend python scripts/guide_server.py seed  --today 2026-09-15
    uv run --project backend python scripts/guide_server.py serve --today 2026-09-15 --port 57001
    uv run --project backend python scripts/guide_server.py sample-upload --today 2026-09-15 \
        --out new-students.xlsx

`seed` fills `$SCRAPPY_HOME` with the fictional demo data as of `--today`; `serve` runs the same
FastAPI app as `python -m app`, with `app.clock.get_today` overridden to `--today`, so every
number and date on screen is the same whenever the pictures are retaken. The app itself has no
way to change its clock: this override lives only here, the way the tests freeze time.
`sample-upload` writes a small Excel file to upload over the demo data, with one row of each
kind the upload preview shows (new, already here, looks similar, a problem, a payment for
someone not found).

`seed` and `serve` need `SCRAPPY_HOME` (and `SCRAPPY_BACKUP_DIR`) set to a throwaway folder.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import sys

import uvicorn
from sqlalchemy.orm import Session

from app import config, migrate
from app.clock import get_today
from app.db import get_engine
from app.main import create_app
from app.seed import seed


def sample_upload(today: dt.date, out: str | None) -> int:
    """A made-up list of new students and their payments, as someone might keep in Excel."""
    from openpyxl import Workbook

    if not out:
        print("Say where to write it: --out file.xlsx", file=sys.stderr)
        return 1
    month = today.replace(day=1)
    book = Workbook()
    students = book.active
    students.title = "Students"
    students.append(["Name", "Phone", "Class/batch", "Monthly fee", "Joined"])
    batch = "Sat 10am \N{EN DASH} Jayanagar Studio"
    for row in (
        ["Ananya Rao", "90000 00001", None, 1500, "Oct 2025"],  # already here
        ["Kiara Sethi", "98765 00011", batch, "₹1,500", f"{month:%b %Y}"],
        ["Rahul Iyer", "98765 00012", batch, "1800/-", f"{month:%b %Y}"],
        ["Meera Iyer", "98765 00013", batch, 1800, f"{month:%b %Y}"],  # same name, new phone
        ["Tara Menon", None, batch, None, f"{month:%b %Y}"],  # no fee
    ):
        students.append(row)
    payments = book.create_sheet("Payments")
    payments.append(["Student", "Phone", "Amount", "Paid on", "For month", "Method", "Note"])
    for row in (
        ["Kiara Sethi", None, 1500, today.replace(day=5), month, "UPI", None],
        ["Rahul Iyer", None, 1800, today.replace(day=6), month, "Cash", None],
        ["Meera Iyer", "98765 00013", 1800, today.replace(day=6), month, "UPI", None],
        ["Mrs Sharma", None, 1200, f"{today.replace(day=8):%d/%m/%Y}", None, "GPay", "No name"],
    ):
        payments.append(row)
    for ws in (students, payments):
        for column in "ABCDEFG":
            ws.column_dimensions[column].width = 18
    book.save(out)
    print(f"Wrote {out}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=("seed", "serve", "sample-upload"))
    parser.add_argument("--today", type=dt.date.fromisoformat, required=True)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--out", help="sample-upload: where to write the file")
    args = parser.parse_args(argv)

    if args.command == "sample-upload":
        return sample_upload(args.today, args.out)

    if not os.environ.get("SCRAPPY_HOME", "").strip():
        print("Set SCRAPPY_HOME to a throwaway folder first.", file=sys.stderr)
        return 1

    if args.command == "seed":
        config.ensure_dirs()
        migrate.upgrade_to_head()
        with Session(get_engine()) as session:
            added = seed(session, args.today)
        print(f"Added {added} demo students as of {args.today:%d %b %Y}")
        return 0

    app = create_app()
    app.dependency_overrides[get_today] = lambda: args.today
    uvicorn.run(app, host=config.HOST, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
