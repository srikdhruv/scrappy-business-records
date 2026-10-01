"""Adding students and payments from an uploaded Excel file: preview first, then add.

**Preview** (`preview`) reads the file (`app/services/spreadsheet.py`), checks every row with
the app's own rules (the same schemas and limits as typing it in), and says what adding each
row would do. Nothing is saved.

**Add** (`commit`) gets the rows back with the owner's choices, and checks *everything again*
against the records as they are now (a student added meanwhile, a payment already logged), so
it never trusts what the preview said. It then takes a `pre-import` backup and adds everything
in one transaction: any error rolls all of it back. Nothing already here is ever changed.

Students (`ImportStudentStatus`), matched with the shared search rules (`services/text.py`):

- **exists**: same name (words in any order, ignoring capitals, accents, apostrophes and
  hyphens) and same phone digits, or same name when neither has a phone; or the same as an
  earlier row in the file. Skipped.
- **similar**: same name with a different phone, or the same phone with a different name.
  Skipped unless the owner chooses "Add as new".
- **problem**: breaks a rule. Skipped. **new**: added.

Payments (`ImportPaymentStatus`) go to the student they name: through the file's Student ID
(a Download everything file), else by name or phone digits, among the students here and the
new ones in the same file. No match, or more than one, and they are kept as **unassigned
payments** (the owner can pick a student, or skip them). A payment with the same student,
amount, paid-on date and month as one already here, or as an earlier row, is a **duplicate**.

A Download everything file also restores each new student's fee history exactly (months away
included). Fee history for students already here is left alone.
"""

from __future__ import annotations

import base64
import binascii
import datetime as dt
import hashlib
import re
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ValidationError
from sqlalchemy import insert, select
from sqlalchemy.orm import Session

from app import backup
from app.db import lock_for_writing
from app.errors import unprocessable
from app.models import (
    Batch,
    FeeChange,
    FeeKind,
    Payment,
    PaymentMethod,
    Student,
    UnassignedPayment,
)
from app.months import format_month, parse_month
from app.schemas import (
    MAX_AMOUNT_PAISE,
    BatchCreate,
    ImportBatchPreview,
    ImportBatchStatus,
    ImportCommit,
    ImportFee,
    ImportPayment,
    ImportPaymentChoice,
    ImportPaymentPreview,
    ImportPaymentStatus,
    ImportPreview,
    ImportResult,
    ImportStudent,
    ImportStudentPreview,
    ImportStudentStatus,
)
from app.services import spreadsheet as sheet_io
from app.services.batches import days_to_mask
from app.services.bounds import EARLIEST_DATE, latest_month
from app.services.matching import PeopleIndex, Person, text_digits, text_key
from app.services.spreadsheet import CellError, Col, SheetKind
from app.services.text import fold, name_key, phone_digits

# --------------------------------------------------------------------------- plain words


def _rupees(paise: int) -> str:
    rupees, rest = divmod(paise, 100)
    digits = str(rupees)
    # Indian grouping: 1,50,000
    head, tail = digits[:-3], digits[-3:]
    groups: list[str] = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    text = ",".join([*groups, tail]) if groups else tail
    return f"₹{text}" + (f".{rest:02d}" if rest else "")


def _month_words(month: str) -> str:
    return f"{parse_month(month):%b %Y}"


def _day_words(day: dt.date) -> str:
    return f"{day.day} {day:%b %Y}"


_LABELS = {
    "name": "Name",
    "student_text": "Student",
    "phone": "Phone",
    "guardian_name": "Parent/guardian",
    "batch_label": "Class/batch",
    "notes": "Notes",
    "note": "Note",
    "joined_month": "Joined month",
    "left_month": "Left month",
    "monthly_fee_paise": "Monthly fee",
    "amount_paise": "Amount",
    "paid_on": "Paid-on date",
    "for_month": "Month",
    "ref": "Student ID",
    "student_ref": "Student ID",
    "source": "Came from",
}


def _plain(error: ValidationError) -> str:
    """The first problem in plain words, e.g. "Phone is too long (max 200 characters)"."""
    first = error.errors()[0]
    loc = [str(p) for p in first.get("loc", ()) if not isinstance(p, int)]
    label = _LABELS.get(loc[0], loc[0]) if loc else "This row"
    kind = first.get("type", "")
    ctx = first.get("ctx") or {}
    if kind in ("string_too_long", "too_long"):
        return f"{label} is too long (max {ctx.get('max_length')} characters)"
    if kind == "less_than_equal":
        return f"{label} is more than {_rupees(MAX_AMOUNT_PAISE)}, the most it can be"
    if kind == "greater_than":
        return f"{label} must be more than ₹0"
    if kind == "value_error":  # our own rules already say it plainly
        return str(first.get("msg"))
    return f"{label}: {first.get('msg')}"


def _check(model: type[BaseModel], fields: dict[str, Any]) -> tuple[Any, str | None]:
    try:
        return model(**fields), None
    except ValidationError as error:
        return None, _plain(error)


def _bounds_problem(month: str, latest: dt.date, label: str) -> str | None:
    if parse_month(month) > latest:
        return f"{label} can't be later than {latest:%B %Y} (two years from now)"
    return None


def student_problem(data: ImportStudent, current_month: dt.date) -> str | None:
    """Rules a student row must keep beyond its schema, as when typing it in, plus a sound fee
    history: starting at the joined month, one fee a month, and no fee for a month away."""
    latest = latest_month(current_month)
    for month, label in ((data.joined_month, "Joined month"), (data.left_month, "Left month")):
        if month and (problem := _bounds_problem(month, latest, label)):
            return problem
    if not data.fees:
        return None
    months = [f.effective_month for f in data.fees]
    if len(set(months)) != len(months):
        return "Fee history has two fees for the same month"
    if min(months) != data.joined_month:
        return (
            f"Fee history starts in {_month_words(min(months))}, but they joined in "
            f"{_month_words(data.joined_month)}"
        )
    first = min(data.fees, key=lambda f: f.effective_month)
    if first.kind is FeeKind.away:
        return "Fee history can't start with a month away"
    for fee in data.fees:
        if problem := _bounds_problem(fee.effective_month, latest, "A fee"):
            return problem
        if fee.kind is FeeKind.away and fee.amount_paise:
            return "A month away in the fee history must have no fee (₹0)"
    return None


def payment_problem(data: ImportPayment, today: dt.date) -> str | None:
    """The same limits as logging a payment (`services/bounds.py`)."""
    if problem := _bounds_problem(data.for_month, latest_month(today.replace(day=1)), "Month"):
        return problem
    if data.paid_on < EARLIEST_DATE:
        return "Paid-on date can't be before the year 2000"
    if data.paid_on > today + dt.timedelta(days=1):
        return "Paid-on date can't be in the future"
    return None


# --------------------------------------------------------------------------- what's here


def _norm_note(note: str | None) -> str:
    return (note or "").strip()


# A payment as the duplicate check sees it: what, when and for which month; then how and why.
_PayKey = tuple[Any, int, dt.date, str]
_PayExtra = tuple[str, str]


@dataclass
class _Known:
    """The records as they are now, indexed for matching."""

    students: dict[int, Student]
    people: PeopleIndex[int]
    payments: dict[_PayKey, list[_PayExtra]]  # by (student id, amount, paid on, month)
    unassigned: dict[_PayKey, list[_PayExtra]]  # by (name as written, amount, paid on, month)
    by_uid: dict[str, Student]  # students by uid (see `Student.uid`)


def _load_known(session: Session) -> _Known:
    students = {s.id: s for s in session.scalars(select(Student).order_by(Student.id))}
    people = PeopleIndex(Person(s.id, s.name, s.phone) for s in students.values())
    payments: dict[_PayKey, list[_PayExtra]] = defaultdict(list)
    for sid, amount, paid_on, for_month, method, note in session.execute(
        select(
            Payment.student_id,
            Payment.amount_paise,
            Payment.paid_on,
            Payment.for_month,
            Payment.method,
            Payment.note,
        )
    ):
        payments[(sid, amount, paid_on, format_month(for_month))].append(
            (PaymentMethod(method).value, _norm_note(note))
        )
    unassigned: dict[_PayKey, list[_PayExtra]] = defaultdict(list)
    for text, amount, paid_on, for_month, method, note in session.execute(
        select(
            UnassignedPayment.student_text,
            UnassignedPayment.amount_paise,
            UnassignedPayment.paid_on,
            UnassignedPayment.for_month,
            UnassignedPayment.method,
            UnassignedPayment.note,
        )
    ):
        unassigned[(name_key(text), amount, paid_on, format_month(for_month))].append(
            (PaymentMethod(method).value, _norm_note(note))
        )
    by_uid = {s.uid: s for s in students.values() if s.uid}
    return _Known(students, people, payments, unassigned, by_uid)


def _describe(student: Student) -> str:
    return f"{student.name} ({student.phone})" if student.phone else student.name


# --------------------------------------------------------------------------- students

_UID = re.compile(r"^[0-9a-f]{32}$")  # a uid as `exports.ensure_uids` makes them


@dataclass
class StudentPlan:
    data: ImportStudent
    status: ImportStudentStatus
    reason: str | None = None
    student_id: int | None = None  # exists: who it is; similar: who it looks like
    same_as: int | None = None  # exists in the file: the earlier row it repeats
    add_by_default: bool = False  # similar: added unless the owner says Skip
    # Students already here it is, or may be: their payments are checked for duplicates of its
    # payments before any of them is kept as unassigned.
    look_alikes: list[int] = field(default_factory=list)
    unlinked: bool = False  # its Student ID belongs to someone else: payments don't follow it


def _agrees(name: str, phone: str | None, key: tuple[str, ...], digits: str) -> bool:
    """Whether a row (`key`, `digits`) is the person called `name`: the same name, and the same
    phone where both have one."""
    theirs = phone_digits(phone)
    return name_key(name) == key and (not digits or not theirs or theirs == digits)


def _different_people(a: ImportStudent, b: ImportStudent) -> bool:
    """Two rows that both carry a Student ID (a Download everything file) are the same person
    only if the ID is the same: two "Priya S" with no phone, or siblings sharing a parent's
    phone, stay two people."""
    return bool(a.ref and b.ref and a.ref != b.ref)


def classify_students(
    rows: Sequence[ImportStudent], known: _Known, current_month: dt.date
) -> list[StudentPlan]:
    """What adding each student row would do. A row's Student ID (from a Download everything
    file) is the student's uid: when a student here has it, that's who the row is, whatever
    their name or phone is now. Otherwise rows are matched by name and phone, and when more
    than one student here has the row's name and phone, the owner chooses: one is never
    picked silently."""
    plans: list[StudentPlan] = []
    by_ref: dict[str, StudentPlan] = {}
    in_file: PeopleIndex[int] = PeopleIndex()  # earlier rows, by row number
    by_row: dict[int, StudentPlan] = {}
    claimed: dict[int, int] = {}  # student here -> the row (with a Student ID) that is them
    unlink: set[int] = set()  # rows whose Student ID isn't theirs: their payments don't follow it
    every_row_has_an_id = True  # so far: then rows are only compared with what's here

    def add(plan: StudentPlan) -> None:
        if plan.student_id is not None and not plan.look_alikes:
            plan.look_alikes = [plan.student_id]
        plans.append(plan)
        by_row[plan.data.row] = plan
        if plan.status is not ImportStudentStatus.problem:
            in_file.add(Person(plan.data.row, plan.data.name, plan.data.phone))
            if plan.data.ref:
                by_ref.setdefault(plan.data.ref, plan)

    def earlier(people: list[Person[int]], data: ImportStudent) -> list[StudentPlan]:
        if data.ref and every_row_has_an_id:
            return []
        return [
            by_row[p.ident] for p in people if not _different_people(by_row[p.ident].data, data)
        ]

    def similar(data: ImportStudent, reason: str, others: Sequence[Student] = ()) -> None:
        ids = [o.id for o in others]
        add(
            StudentPlan(
                data,
                ImportStudentStatus.similar,
                reason,
                student_id=ids[0] if ids else None,
                look_alikes=ids,
            )
        )

    for data in rows:
        if problem := student_problem(data, current_month):
            add(StudentPlan(data, ImportStudentStatus.problem, problem))
            continue
        every_row_has_an_id = every_row_has_an_id and bool(data.ref)
        key, digits = name_key(data.name), phone_digits(data.phone)

        # The same Student ID twice in one file: the same person, if it's the same name (and a
        # phone, where both have one, agrees). A copied row with a new name typed over it is
        # someone else: never merged into the first.
        if data.ref and data.ref in by_ref:
            first = by_ref[data.ref]
            if _agrees(first.data.name, first.data.phone, key, digits):
                add(
                    StudentPlan(
                        data,
                        ImportStudentStatus.exists,
                        f"Same Student ID as row {first.data.row} in this file",
                        student_id=first.student_id,
                        same_as=first.same_as or first.data.row,
                    )
                )
            else:
                similar(
                    data,
                    f"Has the same Student ID as {first.data.name} (row {first.data.row}), but a "
                    "different name or phone: a copied row?",
                )
                unlink.add(data.row)
            continue

        # Their uid: the student here who has it, if the name agrees (and the phone, where both
        # have one). Otherwise the row isn't them (a copied row with a new name, say): it only
        # looks like them, and is never added onto them.
        record = known.by_uid.get(data.ref) if data.ref else None
        if record is not None and record.id not in claimed:
            if _agrees(record.name, record.phone, key, digits):
                claimed[record.id] = data.row
                add(
                    StudentPlan(
                        data,
                        ImportStudentStatus.exists,
                        f"Already here: {_describe(record)}",
                        student_id=record.id,
                    )
                )
            else:
                similar(
                    data,
                    f"Has the Student ID of {_describe(record)}, but a different name or phone: "
                    "a copied row, or has their name or phone changed?",
                    [record],
                )
                unlink.add(data.row)
            continue

        same_name = [known.students[p.ident] for p in known.people.same_name(key)]
        exact = [s for s in same_name if phone_digits(s.phone) == digits]
        free = [s for s in exact if not (data.ref and s.id in claimed)]
        if len(free) == 1:
            same = free[0]
            if data.ref:
                claimed[same.id] = data.row
            add(
                StudentPlan(
                    data,
                    ImportStudentStatus.exists,
                    f"Already here: {_describe(same)}",
                    student_id=same.id,
                )
            )
            continue
        if len(free) > 1:
            similar(
                data,
                f"{len(free)} students here are called {free[0].name}"
                + (" with this phone" if digits else ", with no phone")
                + ". If it's one of them, choose Skip; if it's someone else, Add as new",
                free,
            )
            continue
        if exact:  # every one of them is already another row of this file
            other = exact[0]
            similar(
                data,
                f"Same name and phone as {_describe(other)}, who is already row "
                f"{claimed[other.id]} of this file",
                exact,
            )
            continue

        file_same = earlier(
            [p for p in in_file.same_name(key) if phone_digits(p.phone) == digits], data
        )
        if file_same and digits:
            first = file_same[0]
            add(
                StudentPlan(
                    data,
                    ImportStudentStatus.exists,
                    f"Same as row {first.data.row} in this file",
                    student_id=first.student_id,
                    same_as=first.same_as or first.data.row,
                )
            )
            continue
        if file_same:  # the same name, and neither has a phone: perhaps two people
            similar(
                data,
                f"Same name as row {file_same[0].data.row} in this file, and neither has a phone",
            )
            continue
        if same_name:
            similar(
                data,
                f"Same name as {_describe(same_name[0])}, but a different phone",
                same_name,
            )
            continue
        same_phone = [known.students[p.ident] for p in known.people.same_phone(digits)]
        if same_phone:
            similar(
                data,
                f"Same phone as {_describe(same_phone[0])}, but a different name",
                same_phone,
            )
            continue
        file_name = earlier(in_file.same_name(key), data)
        if file_name:
            similar(data, f"Same name as row {file_name[0].data.row} in this file")
            continue
        file_phone = earlier(in_file.same_phone(digits), data)
        if file_phone:
            # Brothers and sisters often share a parent's phone: added unless she says Skip.
            add(
                StudentPlan(
                    data,
                    ImportStudentStatus.similar,
                    f"Same phone as {file_phone[0].data.name} (row {file_phone[0].data.row}), "
                    "perhaps a brother or sister",
                    add_by_default=True,
                )
            )
            continue
        near = [known.students[p.ident] for p in known.people.near(key)]
        if near:
            similar(data, f"Name is very close to {_describe(near[0])}", near)
            continue
        short = [known.students[p.ident] for p in known.people.short_forms(key)]
        if short:
            similar(
                data,
                f"Name is like {_describe(short[0])} (one of them is shortened)",
                short,
            )
            continue
        compare_in_file = not (data.ref and every_row_has_an_id)
        file_near = earlier(in_file.near(key), data) if compare_in_file else []
        file_near = file_near or (
            earlier(in_file.short_forms(key), data) if compare_in_file else []
        )
        if file_near:
            similar(
                data,
                f"Name is very like {file_near[0].data.name} (row {file_near[0].data.row}) in "
                "this file",
            )
            continue
        add(StudentPlan(data, ImportStudentStatus.new))
    for plan in plans:
        plan.unlinked = plan.data.row in unlink
    return plans


# --------------------------------------------------------------------------- payments


@dataclass
class PaymentPlan:
    data: ImportPayment
    status: ImportPaymentStatus
    reason: str | None = None
    student_id: int | None = None
    student_row: int | None = None
    candidate_ids: list[int] = field(default_factory=list)
    by_id: bool = False  # linked by the file's Student ID (a Download everything file)
    # Students already here its student may be (a "Looks similar" row): a payment of theirs
    # like this one makes it a duplicate, wherever it would otherwise go.
    related_ids: list[int] = field(default_factory=list)


def _by_name(ids: Iterable[int], known: _Known) -> list[int]:
    return sorted(set(ids), key=lambda i: (known.students[i].name.casefold(), i))


class _Suggester:
    """Students a payment may be from, when none matched: the Students search's words, then a
    name a letter or two apart. Remembered per name, as a file often repeats one."""

    def __init__(self, known: _Known) -> None:
        self.known = known
        self.cache: dict[tuple[str, ...], list[int]] = {}

    def __call__(self, key: tuple[str, ...], limit: int = 5) -> list[int]:
        if key not in self.cache:
            people = self.known.people
            found = _by_name((p.ident for p in people.words(key)), self.known)
            found += [i for i in _by_name((p.ident for p in people.near(key)), self.known)]
            self.cache[key] = list(dict.fromkeys(found))[:limit]
        return self.cache[key]


def classify_payments(
    rows: Sequence[ImportPayment],
    students: Sequence[StudentPlan],
    known: _Known,
    today: dt.date,
) -> list[PaymentPlan]:
    """Who each payment goes to (before any duplicate check; see `_dedupe`).

    Given to a student automatically only when the name matches (with the same phone, or where
    one of them has no phone), or when the row has only a phone number and it's theirs. The
    same phone under a different name, or more than one match, needs the owner's choice."""
    by_ref: dict[str, StudentPlan] = {}
    for p in students:  # the first row with each Student ID (a copied row doesn't take it)
        if p.data.ref and p.same_as is None and p.data.ref not in by_ref and not p.unlinked:
            by_ref[p.data.ref] = p
    by_row = {p.data.row: p for p in students}
    in_file: PeopleIndex[int] = PeopleIndex(
        Person(p.data.row, p.data.name, p.data.phone)
        for p in students
        if p.status in (ImportStudentStatus.new, ImportStudentStatus.similar)
    )
    suggest = _Suggester(known)

    def to_file_student(data: ImportPayment, plan: StudentPlan, by_id: bool) -> PaymentPlan | None:
        if plan.same_as is not None:
            plan = by_row.get(plan.same_as, plan)
        if plan.status is ImportStudentStatus.exists and plan.student_id is not None:
            return PaymentPlan(
                data, ImportPaymentStatus.ready, student_id=plan.student_id, by_id=by_id
            )
        if plan.status is ImportStudentStatus.new:
            return PaymentPlan(
                data, ImportPaymentStatus.ready, student_row=plan.data.row, by_id=by_id
            )
        if plan.status is ImportStudentStatus.similar:
            return PaymentPlan(
                data,
                ImportPaymentStatus.follows_student,
                f"Goes with your choice for {plan.data.name} (row {plan.data.row}): to them if "
                "you add them, otherwise kept as unassigned",
                student_row=plan.data.row,
                by_id=by_id,
                related_ids=plan.look_alikes,
            )
        return None

    plans: list[PaymentPlan] = []
    for data in rows:
        if problem := payment_problem(data, today):
            plans.append(PaymentPlan(data, ImportPaymentStatus.problem, problem))
            continue
        if data.unassigned:
            plans.append(PaymentPlan(data, ImportPaymentStatus.unassigned, by_id=True))
            continue
        if data.student_ref and data.student_ref in by_ref:
            student = by_ref[data.student_ref]
            text_ = data.student_text
            if _agrees(student.data.name, student.data.phone, text_key(text_),
                       text_digits(text_, data.phone)):  # fmt: skip
                linked = to_file_student(data, student, by_id=True)
                if linked is not None:
                    plans.append(linked)
                    continue
            else:
                # The ID is someone else's (a copied row?): never follow it on trust.
                related = student.look_alikes
                offered = list(dict.fromkeys([*related, *suggest(text_key(text_))]))[:6]
                plans.append(
                    PaymentPlan(
                        data,
                        ImportPaymentStatus.needs_student,
                        f"Its Student ID is {student.data.name}'s (row {student.data.row}), but "
                        f"the name is “{text_}”. Choose who paid, or keep it as unassigned",
                        candidate_ids=_by_name(offered, known),
                        related_ids=list(related),
                    )
                )
                continue

        text = data.student_text
        key, digits = text_key(text), text_digits(text, data.phone)
        # ("here", student id) or ("file", row): the same name, and a phone that agrees.
        named: list[tuple[str, int]] = []
        strong: list[tuple[str, int]] = []
        conflicts: list[int] = []
        for where, people in (("here", known.people), ("file", in_file)):
            for p in people.same_name(key):
                theirs = p.digits
                if digits and theirs == digits:
                    strong.append((where, p.ident))
                elif digits and theirs:
                    if where == "here":
                        conflicts.append(p.ident)
                else:
                    named.append((where, p.ident))
        phone_only = [
            (where, p.ident)
            for where, people in (("here", known.people), ("file", in_file))
            for p in people.same_phone(digits)
            if p.key != key
        ]
        found = strong or named or (phone_only if not key else [])
        if len(found) == 1:
            [(where, ident)] = found
            if where == "here":
                plans.append(PaymentPlan(data, ImportPaymentStatus.ready, student_id=ident))
            else:
                linked = to_file_student(data, by_row[ident], by_id=False)
                assert linked is not None
                plans.append(linked)
            continue
        here = [i for w, i in found if w == "here"]
        if found:
            # Any of them may be who paid: a payment of theirs like this one is this one.
            related = here + [i for w, row in found if w == "file" for i in by_row[row].look_alikes]
            candidates = _by_name(related, known)
            plans.append(
                PaymentPlan(
                    data,
                    ImportPaymentStatus.needs_student,
                    f"More than one student matches “{text}”. Choose who paid, or keep it as "
                    "unassigned",
                    candidate_ids=candidates,
                    related_ids=candidates,
                )
            )
            continue
        by_phone = [i for w, i in phone_only if w == "here"]
        if by_phone:
            first = known.students[by_phone[0]]
            reason = (
                f"Same phone as {first.name}, but the name is “{text}”. Choose who paid, or "
                "keep it as unassigned"
            )
        elif conflicts:
            reason = (
                f"“{text}” has a different phone from the student of that name. Choose who "
                "paid, or keep it as unassigned"
            )
        else:
            reason = f"No student called “{text}”. Choose who paid, or keep it as unassigned"
        offered = _by_name(by_phone, known) + _by_name(conflicts, known) + suggest(key)
        plans.append(
            PaymentPlan(
                data,
                ImportPaymentStatus.needs_student,
                reason,
                candidate_ids=list(dict.fromkeys(offered))[:6],
            )
        )
    return plans


# A payment's destination: an existing student, a new student (by row), or unassigned.
_Target = tuple[str, int] | tuple[str]


def _default_target(plan: PaymentPlan, added_rows: set[int]) -> _Target | None:
    if plan.status is ImportPaymentStatus.problem:
        return None
    if plan.student_id is not None:
        return ("student", plan.student_id)
    if plan.student_row is not None and plan.student_row in added_rows:
        return ("new", plan.student_row)
    return ("unassigned",)


_METHOD_WORDS = {"upi": "UPI", "cash": "Cash", "other": "Other"}


def _dedupe(
    plans: Sequence[PaymentPlan],
    targets: Sequence[_Target | None],
    known: _Known,
    add_anyway: Sequence[bool] | None = None,
) -> list[tuple[ImportPaymentStatus, str] | None]:
    """Which payments are already here, or repeat an earlier row: `duplicate` when everything
    is the same (method and note too), `possible_duplicate` when only the student, amount,
    paid-on date and month are. None for the others, in file order.

    Counted one for one: two identical payments in the file and one here means one of them is
    new. Rows linked by Student ID (a Download everything file) are never duplicates of each
    other, so restoring one brings back genuine repeats (two instalments on the same day)."""
    available = {k: list(v) for k, v in known.payments.items()}
    available_unassigned = {k: list(v) for k, v in known.unassigned.items()}
    seen: dict[tuple[Any, ...], list[tuple[int, _PayExtra, bool]]] = defaultdict(list)
    results: list[tuple[ImportPaymentStatus, str] | None] = []
    for i, (plan, target) in enumerate(zip(plans, targets, strict=True)):
        if target is None:
            results.append(None)
            continue
        d = plan.data
        extra: _PayExtra = (d.method.value, _norm_note(d.note))
        what = (d.amount_paise, d.paid_on, d.for_month)
        if target[0] == "unassigned":
            pool = available_unassigned.get((name_key(d.student_text), *what), [])
            file_key: tuple[Any, ...] = ("u", name_key(d.student_text), *what)
            where = "waiting in Unassigned payments"
        else:
            pool = available.get((target[1], *what), []) if target[0] == "student" else []
            file_key = (target, *what)
            where = "logged"
        # Its student may be someone already here (an older download re-uploaded after their
        # phone changed, say): a payment of theirs like this one is the same payment.
        for other in plan.related_ids:
            other_pool = available.get((other, *what), [])
            if other_pool and not (target[0] == "student" and target[1] == other):
                if not pool or (extra in other_pool and extra not in pool):
                    pool = other_pool
                    where = f"logged for {known.students[other].name}"
                if extra in pool:
                    break
        forced = bool(add_anyway and add_anyway[i])
        described = (
            f"{_rupees(d.amount_paise)} paid on {_day_words(d.paid_on)} for "
            f"{_month_words(d.for_month)}"
        )
        result: tuple[ImportPaymentStatus, str] | None = None
        if pool:
            if extra in pool:
                pool.remove(extra)
                result = (ImportPaymentStatus.duplicate, f"Already {where}: {described}")
            else:
                method, _ = pool.pop(0)
                result = (
                    ImportPaymentStatus.possible_duplicate,
                    f"Possibly already {where}: {described}, by {_METHOD_WORDS[method]}",
                )
        else:
            earlier = [e for e in seen[file_key] if not (plan.by_id and e[2])]
            if earlier:
                row, their_extra, _ = earlier[0]
                result = (
                    (ImportPaymentStatus.duplicate, f"Same as row {row} in this file")
                    if their_extra == extra
                    else (
                        ImportPaymentStatus.possible_duplicate,
                        f"Like row {row} in this file (the same amount, day and month)",
                    )
                )
        seen[file_key].append((d.row, extra, plan.by_id))
        results.append(None if forced else result)
    return results


# --------------------------------------------------------------------------- reading a file


@dataclass
class _Parsed:
    sheets: list[str]
    ignored: list[str]
    students: list[ImportStudentPreview]  # problems already decided
    student_rows: list[ImportStudent]
    payments: list[ImportPaymentPreview]  # problems already decided
    payment_rows: list[ImportPayment]
    batch_rows: list[tuple[int, BatchCreate]] = field(default_factory=list)
    batch_problems: list[ImportBatchPreview] = field(default_factory=list)


def _cell(read: Any, value: object, label: str) -> tuple[Any, str | None]:
    try:
        return read(value), None
    except CellError as error:
        return None, f"{label} {error}"


def _fee_history(book: sheet_io.Workbook) -> tuple[dict[str, list[ImportFee]], dict[str, str]]:
    """Each Student ID's fee history, and the first problem found in any Student ID's."""
    fees: dict[str, list[ImportFee]] = defaultdict(list)
    problems: dict[str, str] = {}
    for sheet in book.of(SheetKind.fee_history):
        for row in sheet.rows:
            ref = sheet_io.text(row.get(Col.ref))
            if not ref:
                continue
            month, problem = _cell(sheet_io.month, row.get(Col.fee_from), "Fee from")
            amount, problem2 = _cell(sheet_io.money, row.get(Col.fee), "Monthly fee")
            kind, problem3 = _cell(sheet_io.fee_kind, row.get(Col.kind), "Kind")
            problem = problem or problem2 or problem3
            if not problem and (month is None or amount is None):
                problem = "a month or fee is missing"
            fee = None
            if not problem:
                fee, problem = _check(
                    ImportFee, {"effective_month": month, "amount_paise": amount, "kind": kind}
                )
            if problem:
                problems.setdefault(ref, f"Fee history row {row.number}: {problem}")
            else:
                fees[ref].append(fee)
    for history in fees.values():
        history.sort(key=lambda f: f.effective_month)
    return fees, problems


def _parse(book: sheet_io.Workbook, current_month: dt.date) -> _Parsed:
    parsed = _Parsed([s.title for s in book.sheets], book.ignored, [], [], [], [])
    fees, fee_problems = _fee_history(book)
    this_month = format_month(current_month)

    for sheet in book.of(SheetKind.students):
        for row in sheet.rows:
            name = sheet_io.text(row.get(Col.name)) or ""
            phone = sheet_io.text(row.get(Col.phone))
            fee, p1 = _cell(sheet_io.money, row.get(Col.fee), "Monthly fee")
            joined, p2 = _cell(sheet_io.month, row.get(Col.joined), "Joined month")
            left, p3 = _cell(sheet_io.month, row.get(Col.left), "Left month")
            ref = sheet_io.text(row.get(Col.ref))
            history = fees.get(ref or "") if ref else None
            problem = p1 or p2 or p3 or (fee_problems.get(ref) if ref else None)
            if not problem and not name:
                problem = "Name is missing"
            if not problem and fee is None:
                if history:  # a fee history says what the fee was
                    fee = history[-1].amount_paise
                else:
                    problem = "Monthly fee is missing"
            data: ImportStudent | None = None
            if not problem:
                data, problem = _check(
                    ImportStudent,
                    {
                        "row": row.number,
                        "ref": ref,
                        "name": name,
                        "phone": phone,
                        "guardian_name": sheet_io.text(row.get(Col.guardian)),
                        "batch_label": sheet_io.text(row.get(Col.label)),
                        "batch_name": sheet_io.text(row.get(Col.batch)),
                        "notes": sheet_io.text(row.get(Col.notes)),
                        "joined_month": joined or this_month,
                        "left_month": left,
                        "monthly_fee_paise": fee,
                        "fees": history,
                    },
                )
            if data is not None:
                parsed.student_rows.append(data)
            else:
                parsed.students.append(
                    ImportStudentPreview(
                        row=row.number,
                        sheet=sheet.title,
                        name=name[:200],
                        phone=phone[:200] if phone else None,
                        monthly_fee_paise=fee,
                        joined_month=joined,
                        status=ImportStudentStatus.problem,
                        reason=problem,
                        student_id=None,
                        add_by_default=False,
                    )
                )

    for sheet in book.of(SheetKind.batches):
        for row in sheet.rows:
            name = sheet_io.text(row.get(Col.name)) or ""
            days, p1 = _cell(sheet_io.days, row.get(Col.days), "Days")
            starts, p2 = _cell(sheet_io.clock_time, row.get(Col.starts), "Starts")
            ends, p3 = _cell(sheet_io.clock_time, row.get(Col.ends), "Ends")
            fee, p4 = _cell(sheet_io.money, row.get(Col.fee), "Usual monthly fee")
            problem = p1 or p2 or p3 or p4 or (None if name else "Name is missing")
            batch: BatchCreate | None = None
            if not problem:
                batch, problem = _check(
                    BatchCreate,
                    {
                        "name": name,
                        "location": sheet_io.text(row.get(Col.location)),
                        "days": days or [],
                        "start_time": starts,
                        "end_time": ends,
                        "default_fee_paise": fee,
                        "notes": sheet_io.text(row.get(Col.notes)),
                    },
                )
            if batch is not None:
                parsed.batch_rows.append((row.number, batch))
            else:
                parsed.batch_problems.append(
                    ImportBatchPreview(
                        name=name[:200] or f"Row {row.number}",
                        status=ImportBatchStatus.problem,
                        reason=problem,
                        row=row.number,
                        student_count=0,
                        batch_id=None,
                    )
                )

    for sheet in [*book.of(SheetKind.payments), *book.of(SheetKind.unassigned)]:
        unassigned = sheet.kind is SheetKind.unassigned
        for row in sheet.rows:
            phone = sheet_io.text(row.get(Col.phone))
            student = sheet_io.text(row.get(Col.student)) or phone or ""
            amount, p1 = _cell(sheet_io.money, row.get(Col.amount), "Amount")
            paid_on, p2 = _cell(sheet_io.date, row.get(Col.paid_on), "Paid-on date")
            for_month, p3 = _cell(sheet_io.month, row.get(Col.for_month), "Month")
            problem = p1 or p2 or p3
            if not problem and not student:
                problem = "Student is missing"
            if not problem and amount is None:
                problem = "Amount is missing"
            if not problem and paid_on is None:
                problem = "Paid-on date is missing"
            if not problem and for_month is None:
                # No month given: the month it was paid in (checked like any month).
                for_month, problem = _cell(sheet_io.month, paid_on, "Paid-on date")
            method = sheet_io.method(row.get(Col.method))
            note = sheet_io.text(row.get(Col.note))
            data: ImportPayment | None = None  # type: ignore[no-redef]
            if not problem:
                data, problem = _check(
                    ImportPayment,
                    {
                        "row": row.number,
                        "student_text": student,
                        "phone": phone,
                        "student_ref": sheet_io.text(row.get(Col.ref)),
                        "amount_paise": amount,
                        "paid_on": paid_on,
                        "for_month": for_month,
                        "method": method,
                        "note": note,
                        "unassigned": unassigned,
                        "source": sheet_io.text(row.get(Col.source)) if unassigned else None,
                        "sheet": sheet.title[:200],
                    },
                )
            if data is not None:
                parsed.payment_rows.append(data)
            else:
                parsed.payments.append(
                    ImportPaymentPreview(
                        row=row.number,
                        sheet=sheet.title,
                        student_text=student[:200],
                        amount_paise=amount,
                        paid_on=paid_on,
                        for_month=for_month,
                        method=method,
                        note=note[:500] if note else None,
                        status=ImportPaymentStatus.problem,
                        reason=problem,
                        student_id=None,
                        student_row=None,
                        candidate_ids=[],
                    )
                )
    return parsed


# --------------------------------------------------------------------------- preview

# Rows that need the owner's choice are always listed in full; of the rest, the first few of
# each status are (with counts for all), so a big Download everything file previews quickly.
_CHOICE_STUDENTS = {ImportStudentStatus.similar}
_CHOICE_PAYMENTS = {
    ImportPaymentStatus.needs_student,
    ImportPaymentStatus.follows_student,
    ImportPaymentStatus.possible_duplicate,
}
_LISTED = {"problem": 1000}
_LISTED_OTHERWISE = 100


@dataclass
class _BatchPlan:
    """One batch the file names: from its Batches sheet (`data`), or only in the students'
    Batch column."""

    key: str
    name: str
    status: ImportBatchStatus
    row: int | None
    data: BatchCreate | None
    existing: Batch | None
    student_count: int = 0

    @property
    def reason(self) -> str | None:
        if self.status is ImportBatchStatus.not_found:
            return "Batch not found, will be left without a batch"
        return None


def batch_key(name: str) -> str:
    """How an uploaded batch name is matched: ignoring capitals, accents, spaces and
    punctuation, so "SUNDAY-SENIORS", "Sunday Seniors" and "sunday.seniors" are one batch."""
    return "".join(c for c in fold(name) if c.isalnum())


def _plan_batches(
    session: Session, parsed: _Parsed, students: Sequence[StudentPlan]
) -> list[_BatchPlan]:
    """Every batch the file names, matched to the batches here by name (ignoring capitals,
    accents and spaces). A Batches sheet row that isn't here yet will be added; a name only
    in the Batch column that isn't here is `not_found` (never created unless chosen)."""
    here: dict[str, Batch] = {}
    for b in sorted(session.scalars(select(Batch)), key=lambda b: (fold(b.name), b.id)):
        here.setdefault(batch_key(b.name), b)
    plans: dict[str, _BatchPlan] = {}
    for row, data in parsed.batch_rows:
        key = batch_key(data.name)
        if key in plans:
            parsed.batch_problems.append(
                ImportBatchPreview(
                    name=data.name,
                    status=ImportBatchStatus.problem,
                    reason=f"Listed twice on the Batches sheet (also row {plans[key].row})",
                    row=row,
                    student_count=0,
                    batch_id=None,
                )
            )
            continue
        existing = here.get(key)
        plans[key] = _BatchPlan(
            key=key,
            name=existing.name if existing else data.name,
            status=ImportBatchStatus.exists if existing else ImportBatchStatus.new,
            row=row,
            data=data,
            existing=existing,
        )
    for plan_ in students:
        student = plan_.data
        if not student.batch_name:
            continue
        key = batch_key(student.batch_name)
        if not key:
            continue
        plan = plans.get(key)
        if plan is None:
            existing = here.get(key)
            plan = plans[key] = _BatchPlan(
                key=key,
                name=existing.name if existing else " ".join(student.batch_name.split()),
                status=ImportBatchStatus.exists if existing else ImportBatchStatus.not_found,
                row=None,
                data=None,
                existing=existing,
            )
        # Only the rows that will be added (as the preview has them): a batch named only by
        # students already here, or skipped, would have nobody to put in it.
        if _added_by_default(plan_):
            plan.student_count += 1
    return sorted(plans.values(), key=lambda p: (fold(p.name), p.key))


def _batch_previews(plans: list[_BatchPlan], parsed: _Parsed) -> list[ImportBatchPreview]:
    return [
        ImportBatchPreview(
            name=p.name,
            status=p.status,
            reason=p.reason,
            row=p.row,
            student_count=p.student_count,
            batch_id=p.existing.id if p.existing else None,
        )
        for p in plans
    ] + parsed.batch_problems


@dataclass
class _Plan:
    """A file, read and checked against the records as they are now."""

    book: sheet_io.Workbook
    parsed: _Parsed
    known: _Known
    students: list[StudentPlan]
    payments: list[PaymentPlan]
    batches: list[_BatchPlan]


def _read(data: bytes) -> sheet_io.Workbook:
    try:
        return sheet_io.read_workbook(data)
    except sheet_io.BadFile as error:
        raise unprocessable(error.message) from None


def _plan(session: Session, data: bytes, today: dt.date, current_month: dt.date) -> _Plan:
    book = _read(data)
    parsed = _parse(book, current_month)
    _check_unique_rows(parsed.student_rows, parsed.payment_rows)
    known = _load_known(session)
    splans = classify_students(parsed.student_rows, known, current_month)
    pplans = classify_payments(parsed.payment_rows, splans, known, today)
    return _Plan(book, parsed, known, splans, pplans, _plan_batches(session, parsed, splans))


class _Lister:
    """Keeps every row that needs a choice, and the first few of every other status."""

    def __init__(self, choice: set[Any]) -> None:
        self.choice = choice
        self.counts: dict[str, int] = defaultdict(int)
        self.all_shown = True

    def keep(self, status: Any) -> bool:
        self.counts[str(status)] += 1
        if status in self.choice:
            return True
        if self.counts[str(status)] <= _LISTED.get(str(status), _LISTED_OTHERWISE):
            return True
        self.all_shown = False
        return False


def preview(
    session: Session,
    data: bytes,
    filename: str | None,
    today: dt.date,
    current_month: dt.date,
) -> ImportPreview:
    """What adding this file would do. Saves nothing. 422 for a file that can't be read, with
    a plain message."""
    plan = _plan(session, data, today, current_month)
    added = {p.data.row for p in plan.students if _added_by_default(p)}
    duplicates = _dedupe(
        plan.payments, [_default_target(p, added) for p in plan.payments], plan.known
    )

    students_sheet = next((s.title for s in plan.book.of(SheetKind.students)), "Students")
    student_list = _Lister(_CHOICE_STUDENTS)
    students = [
        ImportStudentPreview(
            row=p.data.row,
            sheet=students_sheet,
            name=p.data.name,
            phone=p.data.phone,
            monthly_fee_paise=p.data.monthly_fee_paise,
            joined_month=p.data.joined_month,
            status=p.status,
            reason=p.reason,
            student_id=p.student_id,
            add_by_default=p.add_by_default,
            batch_name=p.data.batch_name,
        )
        for p in plan.students
        if student_list.keep(p.status)
    ]
    students += [s for s in plan.parsed.students if student_list.keep(s.status)]

    payment_list = _Lister(_CHOICE_PAYMENTS)
    payments = []
    for p, duplicate in zip(plan.payments, duplicates, strict=True):
        status, reason = duplicate if duplicate else (p.status, p.reason)
        if not payment_list.keep(status):
            continue
        d = p.data
        payments.append(
            ImportPaymentPreview(
                row=d.row,
                sheet=d.sheet,
                student_text=d.student_text,
                amount_paise=d.amount_paise,
                paid_on=d.paid_on,
                for_month=d.for_month,
                method=d.method,
                note=d.note,
                status=status,
                reason=reason,
                student_id=p.student_id,
                student_row=p.student_row,
                candidate_ids=p.candidate_ids,
            )
        )
    payments += [r for r in plan.parsed.payments if payment_list.keep(r.status)]
    return ImportPreview(
        filename=filename,
        sheets=plan.parsed.sheets,
        ignored_sheets=plan.parsed.ignored,
        hidden_sheets=plan.book.hidden,
        students=sorted(students, key=lambda r: r.row),
        payments=sorted(payments, key=lambda r: (r.sheet, r.row)),
        student_counts=dict(student_list.counts),
        payment_counts=dict(payment_list.counts),
        all_rows_shown=student_list.all_shown and payment_list.all_shown,
        fee_changes=sum(
            len(p.data.fees or ()) for p in plan.students if p.status is ImportStudentStatus.new
        ),
        batches=_batch_previews(plan.batches, plan.parsed),
        current_month=format_month(current_month),
        file_sha256=hashlib.sha256(data).hexdigest(),
    )


def _added_by_default(plan: StudentPlan) -> bool:
    return plan.status is ImportStudentStatus.new or (
        plan.status is ImportStudentStatus.similar and plan.add_by_default
    )


def _check_unique_rows(
    students: Iterable[ImportStudent], payments: Iterable[ImportPayment]
) -> None:
    student_rows = [s.row for s in students]
    payment_rows = [(p.sheet, p.row) for p in payments]
    if len(set(student_rows)) != len(student_rows) or len(set(payment_rows)) != len(payment_rows):
        raise unprocessable("Each row can only be sent once. Upload the file again.")


# --------------------------------------------------------------------------- adding


def _label_with(label: str | None, batch_name: str | None) -> str | None:
    """The old class label to keep: "Wednesday Club · Wed 5pm" for a batch name that isn't
    here and a label from the file, either one alone, or none."""
    parts = [t for t in (batch_name, label) if t]
    return " · ".join(parts)[:200] or None


def decode_file(encoded: str) -> bytes:
    """The file sent with Add (base64), or a plain 422."""
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise unprocessable(
            "The file didn't arrive whole. Choose it again.", field="file"
        ) from None
    if len(data) > sheet_io.MAX_FILE_BYTES:
        raise unprocessable("This file is bigger than 5 MB. Upload a smaller one.", field="file")
    return data


def commit(
    session: Session, body: ImportCommit, today: dt.date, current_month: dt.date
) -> ImportResult:
    """Add what the owner chose. The file comes again with her choices, and is read and
    checked again, row by row, against the records as they are now: nothing from the preview
    is trusted. One transaction, with the write lock held from the start; a `pre-import`
    backup is taken first (only if anything is to be added). Nothing already here is
    changed."""
    data = decode_file(body.file)
    if hashlib.sha256(data).hexdigest() != body.file_sha256:
        raise unprocessable(
            "The file changed since you previewed it. Please upload it again.",
            field="file_sha256",
        )
    lock_for_writing(session)
    plan = _plan(session, data, today, current_month)
    known = plan.known
    student_choice = {d.row: d.add for d in body.students}
    payment_choice = {(d.sheet, d.row): d for d in body.payments}
    student_rows = {p.data.row for p in plan.students} | {r.row for r in plan.parsed.students}
    payment_rows = {(p.data.sheet, p.data.row) for p in plan.payments}
    payment_rows |= {(r.sheet, r.row) for r in plan.parsed.payments}
    if not set(student_choice) <= student_rows or not set(payment_choice) <= payment_rows:
        raise unprocessable(
            "A choice was for a row that isn't in this file. Please upload it again.",
            field="students" if not set(student_choice) <= student_rows else "payments",
        )

    not_found = {p.key: p for p in plan.batches if p.status is ImportBatchStatus.not_found}
    create = {batch_key(name) for name in body.create_batches}
    if not create <= set(not_found):
        raise unprocessable(
            "A batch to create isn't one this file names, or it's already here. Please upload "
            "the file again.",
            field="create_batches",
        )
    new_batches = [p for p in plan.batches if p.status is ImportBatchStatus.new]

    added_rows: set[int] = set()
    for p in plan.students:
        chosen = student_choice.get(p.data.row)
        if chosen is False:
            continue
        if _added_by_default(p) or (p.status is ImportStudentStatus.similar and chosen):
            added_rows.add(p.data.row)

    # A batch to create only if a student being added goes in it: never an empty one.
    named = {
        batch_key(p.data.batch_name)
        for p in plan.students
        if p.data.row in added_rows and p.data.batch_name
    }
    new_batches += [not_found[k] for k in sorted(create) if k in named]

    targets: list[_Target | None] = []
    add_anyway: list[bool] = []
    for p in plan.payments:
        decision = payment_choice.get((p.data.sheet, p.data.row))
        choice = decision.choice if decision else ImportPaymentChoice.auto
        add_anyway.append(choice is ImportPaymentChoice.add)
        if p.status is ImportPaymentStatus.problem or choice is ImportPaymentChoice.skip:
            targets.append(None)
        elif choice is ImportPaymentChoice.unassigned:
            targets.append(("unassigned",))
        elif choice is ImportPaymentChoice.student and decision is not None:
            chosen_id = decision.student_id
            # Deleted since the preview? Keep it as unassigned rather than lose it.
            targets.append(
                ("student", chosen_id) if chosen_id in known.students else ("unassigned",)
            )
        else:
            targets.append(_default_target(p, added_rows))
    duplicates = _dedupe(plan.payments, targets, known, add_anyway)
    targets = [None if dup else t for t, dup in zip(targets, duplicates, strict=True)]

    # Every row read, problems included.
    total = len(plan.students) + len(plan.payments)
    total += len(plan.parsed.students) + len(plan.parsed.payments)
    if not added_rows and not any(targets) and not new_batches:
        session.rollback()
        return ImportResult(
            students_added=0,
            fee_changes_added=0,
            payments_added=0,
            unassigned_added=0,
            skipped=total,
            backup_file=None,
        )

    try:
        saved = backup.backup("pre-import")
    except Exception:
        session.rollback()
        raise unprocessable(
            "Couldn't save a backup first, so nothing was added. Try again, or restart the "
            "laptop and try again."
        ) from None

    batch_ids = {p.key: p.existing.id for p in plan.batches if p.existing is not None}
    for p in new_batches:
        d = p.data or BatchCreate(name=p.name)
        made = Batch(
            name=d.name,
            location=d.location,
            days=days_to_mask(d.days),
            start_time=d.start_time,
            end_time=d.end_time,
            default_fee_paise=d.default_fee_paise,
            notes=d.notes,
        )
        session.add(made)
        session.flush()
        batch_ids[p.key] = made.id

    new_students: dict[int, Student] = {}
    fee_count = 0
    taken = set(known.by_uid)
    for p in plan.students:
        d = p.data
        if d.row not in added_rows:
            continue
        # A restored student keeps their uid, so the same file finds them again later.
        fresh = d.ref and _UID.match(d.ref) and d.ref not in taken and not p.unlinked
        uid = d.ref if fresh else None  # a copied row added as new gets a uid of its own
        if uid:
            taken.add(uid)
        batch_id = batch_ids.get(batch_key(d.batch_name)) if d.batch_name else None
        student = Student(
            uid=uid,
            name=d.name,
            phone=d.phone,
            guardian_name=d.guardian_name,
            # A batch that isn't here (and wasn't created): its name is kept in their old
            # class label, next to any label the row had, so nothing typed is lost.
            batch_label=_label_with(d.batch_label, d.batch_name if batch_id is None else None),
            batch_id=batch_id,
            joined_month=parse_month(d.joined_month),
            left_month=parse_month(d.left_month) if d.left_month else None,
            notes=d.notes,
        )
        history = d.fees or [
            ImportFee(effective_month=d.joined_month, amount_paise=d.monthly_fee_paise)
        ]
        for fee in history:
            student.fee_changes.append(
                FeeChange(
                    effective_month=parse_month(fee.effective_month),
                    amount_paise=fee.amount_paise,
                    kind=fee.kind,
                )
            )
        fee_count += len(history)
        session.add(student)
        new_students[d.row] = student
    session.flush()

    source = f"Upload: {body.filename}" if body.filename else "Upload"
    payment_rows: list[dict[str, Any]] = []
    unassigned_rows: list[dict[str, Any]] = []
    for p, target in zip(plan.payments, targets, strict=True):
        if target is None:
            continue
        d = p.data
        fields = {
            "amount_paise": d.amount_paise,
            "paid_on": d.paid_on,
            "for_month": parse_month(d.for_month),
            "method": d.method,
            "note": d.note,
        }
        if target[0] == "unassigned":
            unassigned_rows.append(
                {
                    **fields,
                    "student_text": d.student_text,
                    "phone": d.phone,
                    "source": (d.source if d.unassigned and d.source else source)[:200],
                }
            )
        else:
            student_id = new_students[target[1]].id if target[0] == "new" else target[1]
            payment_rows.append({**fields, "student_id": student_id})
    # Many rows at once (a restore can have tens of thousands): one INSERT each, not one ORM
    # object each. Still the same transaction.
    if payment_rows:
        session.execute(insert(Payment), payment_rows)
    if unassigned_rows:
        session.execute(insert(UnassignedPayment), unassigned_rows)
    session.flush()
    session.commit()
    added = len(new_students) + len(payment_rows) + len(unassigned_rows)
    return ImportResult(
        students_added=len(new_students),
        fee_changes_added=fee_count,
        payments_added=len(payment_rows),
        unassigned_added=len(unassigned_rows),
        skipped=total - added,
        backup_file=saved.name if saved else None,
        batches_added=len(new_batches),
    )


def commit_or_rollback(
    session: Session, body: ImportCommit, today: dt.date, current_month: dt.date
) -> ImportResult:
    """`commit`, with everything rolled back on any error: nothing is ever half-added."""
    try:
        return commit(session, body, today, current_month)
    except BaseException:
        session.rollback()
        raise
