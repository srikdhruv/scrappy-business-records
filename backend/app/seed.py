"""Fill the database with realistic, obviously fictional demo data (`make seed`).

    python -m app.seed            # refuses if the database already has students
    python -m app.seed --force    # backs up, then deletes every student and payment first

It only runs when `SCRAPPY_HOME` is set explicitly (`make seed` sets it to `./.devdata`), so it
can never touch a real install's data by accident. It creates and migrates the database if
needed. Before `--force` deletes anything, it copies the database into
`$SCRAPPY_HOME/seed-backups/`.

Everything is relative to today's month and deterministic: the same day
always gives the same data.

The mix: about 25 students in five batches (each with a location, days, times and a usual fee;
a few students pay their own fee), 12 months of history, mostly paid on time and
mostly by UPI, with some cash. Also: a few unpaid for this month, two partial payments, one month
paid in two parts, two students with a backlog, one payment for two months at once (logged for
this month, so its extra covers last month), one advance payment, one student who left, one fee
change, and two students who joined this month.

All names and phone numbers are made up.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import random
import sqlite3
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app import config, migrate
from app.db import get_engine
from app.models import Batch, FeeChange, Payment, PaymentMethod, Student
from app.months import add_months, current_month, month_range

RANDOM_SEED = 2026


@dataclass(frozen=True)
class DemoBatch:
    name: str
    location: str
    days: str  # Monday first, as stored: "1010000" is Mon and Wed
    start: str
    end: str
    fee_rupees: int


BATCHES = (
    DemoBatch("Mon/Wed Evening", "Koramangala", "1010000", "17:00", "18:00", 1500),
    DemoBatch("Tue/Thu Juniors", "HSR Layout", "0101000", "18:00", "19:00", 1800),
    DemoBatch("Saturday Morning", "Jayanagar Studio", "0000010", "10:00", "11:30", 1200),
    DemoBatch("Sunday Seniors", "Indiranagar", "0000001", "09:00", "10:30", 2000),
    DemoBatch("Friday Beginners", "Whitefield", "0000100", "16:00", "17:00", 2500),
)


@dataclass(frozen=True)
class Demo:
    """One demo student. `joined` is months before the current month (0 = this month)."""

    name: str
    guardian: str | None
    fee_rupees: int
    joined: int
    batch: int
    story: str = "regular"
    phone: bool = True
    notes: str | None = None


# fmt: off
ROSTER: tuple[Demo, ...] = (
    Demo("Ananya Rao", "Lakshmi Rao", 1500, 11, 0),
    Demo("Kabir Mehta", "Sunil Mehta", 1500, 11, 0, "fee_change",
         notes="Moved to the advanced group; fee went up."),
    Demo("Meera Iyer", "Gayathri Iyer", 1800, 11, 1),
    Demo("Rohan Desai", None, 2500, 11, 1, "left", notes="Moved to Pune."),
    Demo("Diya Nair", "Priya Nair", 1200, 10, 2),
    Demo("Arjun Menon", "Vivek Menon", 1200, 10, 2, "backlog",
         notes="Parent said they'd clear the dues together."),
    Demo("Saanvi Reddy", "Kavitha Reddy", 1500, 9, 0),
    Demo("Vihaan Joshi", "Neha Joshi", 2000, 9, 3, "double"),
    Demo("Aditi Kamath", None, 3000, 9, 3),
    Demo("Kavya Pillai", "Anand Pillai", 1200, 8, 2, "partial"),
    Demo("Aarav Bhat", "Deepa Bhat", 1500, 8, 0, "advance"),
    Demo("Nisha Hegde", None, 2500, 8, 4),
    Demo("Tanvi Shetty", "Ramesh Shetty", 1800, 7, 1, "split"),
    Demo("Dev Malhotra", None, 3000, 7, 4, "backlog_gaps"),
    Demo("Riya Kapoor", "Sonal Kapoor", 1200, 6, 2),
    Demo("Siddharth Rao", None, 2000, 6, 3, phone=False),
    Demo("Pooja Gowda", "Manjunath Gowda", 1500, 5, 0, "partial_now"),
    Demo("Neel Chatterjee", "Rupa Chatterjee", 1800, 5, 1),
    Demo("Zara Khan", "Nasreen Khan", 1200, 4, 2),
    Demo("Aryan Verma", None, 2500, 4, 4),
    Demo("Ira Banerjee", "Moumita Banerjee", 1500, 3, 0),
    Demo("Krish Patil", "Swati Patil", 1200, 2, 2),
    Demo("Myra Fernandes", "Clara Fernandes", 2000, 1, 3),
    Demo("Advait Srinivasan", "Lalitha Srinivasan", 1500, 0, 0, "new_paid"),
    Demo("Anika Kulkarni", "Shruti Kulkarni", 1800, 0, 1, "new_unpaid", phone=False),
)
# fmt: on


class _Maker:
    """Builds one student's rows, drawing dates and methods from a shared random stream."""

    def __init__(self, rng: random.Random, today: dt.date) -> None:
        self.rng = rng
        self.today = today
        self.now = current_month(today)

    def method(self) -> PaymentMethod:
        return self.rng.choices(
            (PaymentMethod.upi, PaymentMethod.cash, PaymentMethod.other), weights=(80, 18, 2)
        )[0]

    def paid_on(self, month: dt.date, *, late: bool = False) -> dt.date:
        day = self.rng.randint(12, 26) if late else self.rng.randint(1, 10)
        date = month.replace(day=day)
        return min(date, self.today)

    def pay(
        self,
        student: Student,
        month: dt.date,
        amount: int,
        *,
        late: bool = False,
        paid_on: dt.date | None = None,
        note: str | None = None,
    ) -> None:
        student.payments.append(
            Payment(
                amount_paise=amount,
                paid_on=paid_on or self.paid_on(month, late=late),
                for_month=month,
                method=self.method(),
                note=note,
            )
        )

    def build(self, index: int, demo: Demo) -> Student:
        rng, now = self.rng, self.now
        joined = add_months(now, -demo.joined)
        fee = demo.fee_rupees * 100
        student = Student(
            name=demo.name,
            phone=f"90000 000{index:02d}" if demo.phone else None,  # obviously not real
            guardian_name=demo.guardian,
            joined_month=joined,
            notes=demo.notes,
        )
        student.fee_changes.append(FeeChange(effective_month=joined, amount_paise=fee))

        story = demo.story
        months = month_range(joined, now)
        past, this_month = months[:-1], months[-1]

        if story == "left":
            student.left_month = add_months(now, -4)
            for m in month_range(joined, student.left_month):
                self.pay(student, m, fee)
            return student

        if story == "fee_change":
            raised_from = add_months(now, -5)
            new_fee = fee + 300_00
            student.fee_changes.append(FeeChange(effective_month=raised_from, amount_paise=new_fee))
            for m in months:
                self.pay(student, m, new_fee if m >= raised_from else fee)
            return student

        if story in ("new_paid", "new_unpaid"):
            if story == "new_paid":
                self.pay(student, now, fee, paid_on=self.today)
            return student

        for m in past:
            late = rng.random() < 0.15
            if story == "backlog" and m >= add_months(now, -3):
                continue  # stopped paying three months ago
            if story == "backlog_gaps" and m in (add_months(now, -5), add_months(now, -2)):
                continue  # skipped two months
            if story == "partial" and m == add_months(now, -3):
                self.pay(student, m, fee // 2, note="Rest next month")
                continue
            if story == "double" and m == add_months(now, -1):
                # Paid together with this month (below). Draw what a payment would, so the
                # other demo students stay exactly as they were.
                self.method()
                self.paid_on(m, late=late)
                continue
            if story == "split" and m == add_months(now, -4):
                self.pay(student, m, fee // 3)
                self.pay(student, m, fee - fee // 3, late=True)
                continue
            self.pay(student, m, fee, late=late)

        # This month: most regulars have paid; some haven't yet.
        if story == "backlog":
            return student
        if story == "partial_now":
            self.pay(student, this_month, fee // 2, note="Balance after the 15th")
        elif story == "advance":
            self.pay(student, this_month, fee)
            self.pay(
                student,
                add_months(now, 1),
                fee,
                paid_on=self.today,
                note="Paid next month in advance",
            )
        elif story == "double":
            self.pay(student, this_month, 2 * fee, note="Paid for two months")
        elif story in ("regular", "split") and rng.random() < 0.25:
            pass  # not paid yet this month
        else:
            self.pay(student, this_month, fee)
        return student


def build_students(today: dt.date, rng_seed: int = RANDOM_SEED) -> list[Student]:
    """The demo students (with fee changes and payments) for `today`, not yet saved."""
    maker = _Maker(random.Random(rng_seed), today)
    return [maker.build(i, demo) for i, demo in enumerate(ROSTER, start=1)]


def student_count(session: Session) -> int:
    return session.scalar(select(func.count()).select_from(Student)) or 0


def seed(session: Session, today: dt.date, *, force: bool = False) -> int:
    """Insert the demo data. Returns the number of students added.

    Raises `RuntimeError` if there are students already, unless `force` (which deletes every
    student, fee change, payment and batch first).
    """
    existing = student_count(session)
    if not existing and session.scalar(select(func.count()).select_from(Batch)):
        existing = -1  # batches but no students: still not an empty database
    if existing and not force:
        raise RuntimeError(
            f"The database already has {existing} students. Use --force to replace them."
            if existing > 0
            else "The database already has batches. Use --force to replace them."
        )
    if existing:
        session.execute(delete(Student))  # fee changes and payments cascade
        session.execute(delete(Batch))
    batches = build_batches()
    session.add_all(batches)
    session.flush()
    students = build_students(today)
    for student, demo in zip(students, ROSTER, strict=True):
        student.batch_id = batches[demo.batch].id
    session.add_all(students)
    session.commit()
    return len(students)


def build_batches() -> list[Batch]:
    """The demo batches, not yet saved."""
    return [
        Batch(
            name=b.name,
            location=b.location,
            days=b.days,
            start_time=b.start,
            end_time=b.end,
            default_fee_paise=b.fee_rupees * 100,
        )
        for b in BATCHES
    ]


def backup_before_wipe() -> Path:
    """Copy the database (SQLite's online backup) into `$SCRAPPY_HOME/seed-backups/` and return
    the copy. Never the normal backup folder, which may be the user's real Documents."""
    stamp = f"{dt.datetime.now():%Y%m%d-%H%M%S}"
    target = config.home_dir() / "seed-backups" / f"records-before-seed-{stamp}.db"
    target.parent.mkdir(parents=True, exist_ok=True)
    src = sqlite3.connect(config.db_path())
    dst = sqlite3.connect(target)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    return target


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.seed", description=__doc__.split("\n")[0])
    parser.add_argument(
        "--force",
        action="store_true",
        help="back up, then delete every existing student and payment first",
    )
    args = parser.parse_args(argv)

    if not os.environ.get("SCRAPPY_HOME", "").strip():
        print(
            "Not seeding: set SCRAPPY_HOME to a development folder first (make seed does this),"
            " so demo data never goes into real records.",
            file=sys.stderr,
        )
        return 1

    config.ensure_dirs()
    migrate.upgrade_to_head()
    with Session(get_engine()) as session:
        if args.force and student_count(session):
            print(f"Backed up the database to {backup_before_wipe()}")
        try:
            added = seed(session, dt.date.today(), force=args.force)
        except RuntimeError as e:
            print(f"Not seeding: {e}", file=sys.stderr)
            return 1
        payments = session.scalar(select(func.count()).select_from(Payment))
    print(f"Added {added} demo students and {payments} payments to {config.db_path()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
