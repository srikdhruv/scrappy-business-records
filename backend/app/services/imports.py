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

import datetime as dt
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import backup
from app.db import lock_for_writing
from app.errors import unprocessable
from app.models import FeeChange, FeeKind, Payment, Student, UnassignedPayment
from app.months import format_month, parse_month
from app.schemas import (
    MAX_AMOUNT_PAISE,
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
from app.services.bounds import EARLIEST_DATE, latest_month
from app.services.spreadsheet import CellError, Col, SheetKind
from app.services.text import looks_like_phone, name_key, phone_digits, student_matches

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
    """The first problem in plain words, e.g. "Phone is too long (at most 200 characters)"."""
    first = error.errors()[0]
    loc = [str(p) for p in first.get("loc", ()) if not isinstance(p, int)]
    label = _LABELS.get(loc[0], loc[0]) if loc else "This row"
    kind = first.get("type", "")
    ctx = first.get("ctx") or {}
    if kind == "string_too_long":
        return f"{label} is too long (at most {ctx.get('max_length')} characters)"
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


@dataclass
class _Known:
    """The records as they are now, indexed for matching."""

    students: dict[int, Student]
    by_name: dict[tuple[str, ...], list[Student]]
    by_phone: dict[str, list[Student]]
    payment_keys: set[tuple[int, int, dt.date, str]]
    unassigned_keys: set[tuple[tuple[str, ...], int, dt.date, str]]


def _load_known(session: Session) -> _Known:
    students = {s.id: s for s in session.scalars(select(Student).order_by(Student.id))}
    by_name: dict[tuple[str, ...], list[Student]] = defaultdict(list)
    by_phone: dict[str, list[Student]] = defaultdict(list)
    for s in students.values():
        by_name[name_key(s.name)].append(s)
        if digits := phone_digits(s.phone):
            by_phone[digits].append(s)
    payment_keys = {
        (sid, amount, paid_on, format_month(for_month))
        for sid, amount, paid_on, for_month in session.execute(
            select(Payment.student_id, Payment.amount_paise, Payment.paid_on, Payment.for_month)
        )
    }
    unassigned_keys = {
        (name_key(text), amount, paid_on, format_month(for_month))
        for text, amount, paid_on, for_month in session.execute(
            select(
                UnassignedPayment.student_text,
                UnassignedPayment.amount_paise,
                UnassignedPayment.paid_on,
                UnassignedPayment.for_month,
            )
        )
    }
    return _Known(students, by_name, by_phone, payment_keys, unassigned_keys)


def _describe(student: Student) -> str:
    return f"{student.name} ({student.phone})" if student.phone else student.name


# --------------------------------------------------------------------------- students


@dataclass
class StudentPlan:
    data: ImportStudent
    status: ImportStudentStatus
    reason: str | None = None
    student_id: int | None = None  # exists: who it is; similar: who it looks like
    same_as: int | None = None  # exists in the file: the earlier row it repeats


def classify_students(
    rows: Sequence[ImportStudent], known: _Known, current_month: dt.date
) -> list[StudentPlan]:
    plans: list[StudentPlan] = []
    for data in rows:
        if problem := student_problem(data, current_month):
            plans.append(StudentPlan(data, ImportStudentStatus.problem, problem))
            continue
        key, digits = name_key(data.name), phone_digits(data.phone)
        same_name = known.by_name.get(key, [])
        same = next((s for s in same_name if phone_digits(s.phone) == digits), None)
        if same is not None:
            plans.append(
                StudentPlan(
                    data,
                    ImportStudentStatus.exists,
                    f"Already here: {_describe(same)}",
                    student_id=same.id,
                )
            )
            continue
        earlier = [p for p in plans if p.status is not ImportStudentStatus.problem]
        repeat = next(
            (
                p
                for p in earlier
                if name_key(p.data.name) == key and phone_digits(p.data.phone) == digits
            ),
            None,
        )
        if repeat is not None:
            plans.append(
                StudentPlan(
                    data,
                    ImportStudentStatus.exists,
                    f"Same as row {repeat.data.row} in this file",
                    student_id=repeat.student_id,
                    same_as=repeat.same_as or repeat.data.row,
                )
            )
            continue
        if same_name:
            other = same_name[0]
            plans.append(
                StudentPlan(
                    data,
                    ImportStudentStatus.similar,
                    f"Same name as {_describe(other)}, but a different phone",
                    student_id=other.id,
                )
            )
            continue
        same_phone = known.by_phone.get(digits, []) if digits else []
        if same_phone:
            other = same_phone[0]
            plans.append(
                StudentPlan(
                    data,
                    ImportStudentStatus.similar,
                    f"Same phone as {_describe(other)}, but a different name",
                    student_id=other.id,
                )
            )
            continue
        look_alike = next(
            (
                p
                for p in earlier
                if name_key(p.data.name) == key or (digits and phone_digits(p.data.phone) == digits)
            ),
            None,
        )
        if look_alike is not None:
            what = "name" if name_key(look_alike.data.name) == key else "phone"
            plans.append(
                StudentPlan(
                    data,
                    ImportStudentStatus.similar,
                    f"Same {what} as row {look_alike.data.row} in this file",
                )
            )
            continue
        plans.append(StudentPlan(data, ImportStudentStatus.new))
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


def _suggestions(text: str, known: _Known, limit: int = 5) -> list[int]:
    """Students the Students search finds for `text`, for a payment that matched no one."""
    found = [
        s.id
        for s in known.students.values()
        if student_matches(
            text, name=s.name, phone=s.phone, guardian_name=s.guardian_name, batch_label=None
        )
    ]
    if not found:  # try each word on its own: "Ananya R" still suggests Ananya Rao
        words = [w for w in text.split() if len(w) >= 3]
        found = [
            s.id
            for s in known.students.values()
            if any(student_matches(w, name=s.name, phone=s.phone) for w in words)
        ]
    return sorted(found, key=lambda i: known.students[i].name.casefold())[:limit]


def _by_name(ids: Iterable[int], known: _Known) -> list[int]:
    return sorted(ids, key=lambda i: (known.students[i].name.casefold(), i))


def _match(
    data: ImportPayment, known: _Known, in_file: Sequence[StudentPlan]
) -> tuple[set[tuple[str, int]], set[tuple[str, int]], set[int]]:
    """Who a payment row names, as ("here", student id) or ("file", row) pairs.

    Strong: the same name and phone digits. Weak: the same name where one of them has no phone,
    or the same phone digits under another name ("or phone digits", as the search finds). A
    student with the same name but a different phone is no match (a conflict): only offered.
    """
    text = data.student_text
    key = () if looks_like_phone(text) else name_key(text)
    digits = phone_digits(data.phone) or (phone_digits(text) if looks_like_phone(text) else "")
    people = [("here", s.id, s.name, s.phone) for s in known.students.values()] + [
        ("file", p.data.row, p.data.name, p.data.phone) for p in in_file
    ]
    strong: set[tuple[str, int]] = set()
    weak: set[tuple[str, int]] = set()
    conflicts: set[int] = set()
    for where, ident, name, phone in people:
        same_name = bool(key) and name_key(name) == key
        theirs = phone_digits(phone)
        same_phone = bool(digits) and theirs == digits
        if same_name and same_phone:
            strong.add((where, ident))
        elif same_name and digits and theirs:
            if where == "here":
                conflicts.add(ident)
        elif same_name or same_phone:
            weak.add((where, ident))
    return strong, weak, conflicts


def classify_payments(
    rows: Sequence[ImportPayment],
    students: Sequence[StudentPlan],
    known: _Known,
    today: dt.date,
) -> list[PaymentPlan]:
    """Who each payment goes to (before any duplicate check; see `_dedupe`)."""
    by_ref = {p.data.ref: p for p in students if p.data.ref}
    by_row = {p.data.row: p for p in students}
    in_file = [
        p for p in students if p.status in (ImportStudentStatus.new, ImportStudentStatus.similar)
    ]

    def to_file_student(plan: StudentPlan) -> PaymentPlan | None:
        if plan.same_as is not None:
            plan = by_row.get(plan.same_as, plan)
        if plan.status is ImportStudentStatus.exists and plan.student_id is not None:
            return PaymentPlan(data, ImportPaymentStatus.ready, student_id=plan.student_id)
        if plan.status is ImportStudentStatus.new:
            return PaymentPlan(data, ImportPaymentStatus.ready, student_row=plan.data.row)
        if plan.status is ImportStudentStatus.similar:
            return PaymentPlan(
                data,
                ImportPaymentStatus.follows_student,
                f"Goes with your choice for {plan.data.name} (row {plan.data.row}): to them if "
                "you add them, otherwise kept as unassigned",
                student_row=plan.data.row,
            )
        return None

    plans: list[PaymentPlan] = []
    for data in rows:
        if problem := payment_problem(data, today):
            plans.append(PaymentPlan(data, ImportPaymentStatus.problem, problem))
            continue
        if data.unassigned:
            plans.append(PaymentPlan(data, ImportPaymentStatus.unassigned))
            continue
        if data.student_ref and data.student_ref in by_ref:
            linked = to_file_student(by_ref[data.student_ref])
            if linked is not None:
                plans.append(linked)
                continue

        text = data.student_text
        strong, weak, conflicts = _match(data, known, in_file)
        found = strong or weak
        if len(found) == 1:
            [(where, ident)] = found
            if where == "here":
                plans.append(PaymentPlan(data, ImportPaymentStatus.ready, student_id=ident))
            else:
                linked = to_file_student(by_row[ident])
                assert linked is not None
                plans.append(linked)
            continue
        here = [ident for where, ident in found if where == "here"]
        new = [ident for where, ident in found if where == "file"]
        if here or new:
            plans.append(
                PaymentPlan(
                    data,
                    ImportPaymentStatus.needs_student,
                    f"More than one student matches “{text}”. Choose who paid, or keep it as "
                    "unassigned",
                    candidate_ids=_by_name(here, known),
                )
            )
            continue
        plans.append(
            PaymentPlan(
                data,
                ImportPaymentStatus.needs_student,
                f"No student called “{text}”. Choose who paid, or keep it as unassigned"
                if not conflicts
                else f"“{text}” has a different phone from the student of that name. Choose who "
                "paid, or keep it as unassigned",
                candidate_ids=_by_name(conflicts, known)
                + [i for i in _suggestions(text, known) if i not in conflicts],
            )
        )
    return plans


# A payment's destination: an existing student, a new student (by row), or unassigned.
_Target = tuple[str, int] | tuple[str]


def _default_target(plan: PaymentPlan, added_rows: set[int]) -> _Target | None:
    if plan.status in (ImportPaymentStatus.problem, ImportPaymentStatus.duplicate):
        return None
    if plan.student_id is not None:
        return ("student", plan.student_id)
    if plan.student_row is not None and plan.student_row in added_rows:
        return ("new", plan.student_row)
    return ("unassigned",)


def _dedupe(
    plans: Sequence[PaymentPlan], targets: list[_Target | None], known: _Known
) -> list[str | None]:
    """For each payment, why it's a duplicate where it's going (or None), in file order."""
    seen: dict[tuple[Any, ...], int] = {}
    reasons: list[str | None] = []
    for plan, target in zip(plans, targets, strict=True):
        if target is None:
            reasons.append(None)
            continue
        d = plan.data
        what = (d.amount_paise, d.paid_on, d.for_month)
        if target[0] == "unassigned":
            key: tuple[Any, ...] = ("u", name_key(d.student_text), *what)
            here = (name_key(d.student_text), *what) in known.unassigned_keys
            already = "Already waiting in Unassigned payments"
        else:
            key = (target, *what)
            here = target[0] == "student" and (target[1], *what) in known.payment_keys
            already = (
                f"Already logged: {_rupees(d.amount_paise)} paid on {_day_words(d.paid_on)} "
                f"for {_month_words(d.for_month)}"
            )
        if here:
            reasons.append(already)
        elif key in seen:
            reasons.append(f"Same as row {seen[key]} in this file")
        else:
            seen[key] = d.row
            reasons.append(None)
    return reasons


# --------------------------------------------------------------------------- reading a file


@dataclass
class _Parsed:
    sheets: list[str]
    ignored: list[str]
    students: list[ImportStudentPreview]  # problems already decided
    student_rows: list[ImportStudent]
    payments: list[ImportPaymentPreview]  # problems already decided
    payment_rows: list[ImportPayment]


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
                        "batch_label": sheet_io.text(row.get(Col.batch)),
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
                        name=name,
                        phone=phone,
                        monthly_fee_paise=fee,
                        joined_month=joined,
                        status=ImportStudentStatus.problem,
                        reason=problem,
                        student_id=None,
                        data=None,
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
                for_month = format_month(paid_on)  # no month given: the month it was paid in
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
                    },
                )
            if data is not None:
                parsed.payment_rows.append(data)
            else:
                parsed.payments.append(
                    ImportPaymentPreview(
                        row=row.number,
                        sheet=sheet.title,
                        student_text=student,
                        amount_paise=amount,
                        paid_on=paid_on,
                        for_month=for_month,
                        method=method,
                        note=note,
                        status=ImportPaymentStatus.problem,
                        reason=problem,
                        student_id=None,
                        student_row=None,
                        candidate_ids=[],
                        data=None,
                    )
                )
    return parsed


# --------------------------------------------------------------------------- preview


def preview(
    session: Session,
    data: bytes,
    filename: str | None,
    today: dt.date,
    current_month: dt.date,
) -> ImportPreview:
    """What adding this file would do, row by row. Saves nothing. 422 for a file that can't be
    read, with a plain message."""
    try:
        book = sheet_io.read_workbook(data)
    except sheet_io.BadFile as error:
        raise unprocessable(error.message) from None
    parsed = _parse(book, current_month)
    _check_unique_rows(parsed.student_rows, parsed.payment_rows)
    known = _load_known(session)
    splans = classify_students(parsed.student_rows, known, current_month)
    pplans = classify_payments(parsed.payment_rows, splans, known, today)
    added = {p.data.row for p in splans if p.status is ImportStudentStatus.new}
    duplicates = _dedupe(pplans, [_default_target(p, added) for p in pplans], known)

    students_sheet = next((s.title for s in book.of(SheetKind.students)), "Students")
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
            data=p.data if p.status is not ImportStudentStatus.problem else None,
        )
        for p in splans
    ]
    payments_sheet = next((s.title for s in book.of(SheetKind.payments)), "Payments")
    unassigned_sheet = next((s.title for s in book.of(SheetKind.unassigned)), "Unassigned payments")
    payments = []
    for p, duplicate in zip(pplans, duplicates, strict=True):
        status, reason = (
            (ImportPaymentStatus.duplicate, duplicate) if duplicate else (p.status, p.reason)
        )
        d = p.data
        payments.append(
            ImportPaymentPreview(
                row=d.row,
                sheet=unassigned_sheet if d.unassigned else payments_sheet,
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
                data=d if status is not ImportPaymentStatus.problem else None,
            )
        )
    return ImportPreview(
        filename=filename,
        sheets=parsed.sheets,
        ignored_sheets=parsed.ignored,
        students=sorted([*students, *parsed.students], key=lambda r: r.row),
        payments=sorted([*payments, *parsed.payments], key=lambda r: (r.sheet, r.row)),
        fee_changes=sum(
            len(p.data.fees or ()) for p in splans if p.status is ImportStudentStatus.new
        ),
        current_month=format_month(current_month),
    )


def _check_unique_rows(
    students: Iterable[ImportStudent], payments: Iterable[ImportPayment]
) -> None:
    student_rows = [s.row for s in students]
    payment_rows = [(p.unassigned, p.row) for p in payments]
    if len(set(student_rows)) != len(student_rows) or len(set(payment_rows)) != len(payment_rows):
        raise unprocessable("Each row can only be sent once. Upload the file again.")


# --------------------------------------------------------------------------- adding


def commit(
    session: Session, body: ImportCommit, today: dt.date, current_month: dt.date
) -> ImportResult:
    """Add what the owner chose, after checking every row again against the records as they
    are now. One transaction, with the write lock held from the start; a `pre-import` backup
    is taken first (only if anything is to be added). Nothing already here is changed."""
    student_rows = [d.data for d in body.students]
    payment_rows = [d.data for d in body.payments]
    _check_unique_rows(student_rows, payment_rows)

    lock_for_writing(session)
    known = _load_known(session)
    splans = classify_students(student_rows, known, current_month)
    added_rows: set[int] = set()
    for plan, decision in zip(splans, body.students, strict=True):
        if decision.add is False:
            continue
        if plan.status is ImportStudentStatus.new or (
            plan.status is ImportStudentStatus.similar and decision.add is True
        ):
            added_rows.add(plan.data.row)

    pplans = classify_payments(payment_rows, splans, known, today)
    targets: list[_Target | None] = []
    for plan, decision in zip(pplans, body.payments, strict=True):
        if (
            plan.status is ImportPaymentStatus.problem
            or decision.choice is ImportPaymentChoice.skip
        ):
            targets.append(None)
        elif decision.choice is ImportPaymentChoice.unassigned:
            targets.append(("unassigned",))
        elif decision.choice is ImportPaymentChoice.student:
            chosen = decision.student_id
            # Deleted since the preview? Keep it as unassigned rather than lose it.
            targets.append(("student", chosen) if chosen in known.students else ("unassigned",))
        else:
            targets.append(_default_target(plan, added_rows))
    duplicates = _dedupe(pplans, targets, known)
    targets = [None if dup else t for t, dup in zip(targets, duplicates, strict=True)]

    total = len(student_rows) + len(payment_rows)
    if not added_rows and not any(targets):
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

    new_students: dict[int, Student] = {}
    fee_count = 0
    for plan in splans:
        d = plan.data
        if d.row not in added_rows:
            continue
        student = Student(
            name=d.name,
            phone=d.phone,
            guardian_name=d.guardian_name,
            batch_label=d.batch_label,
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
    payments_added = unassigned_added = 0
    for plan, target in zip(pplans, targets, strict=True):
        if target is None:
            continue
        d = plan.data
        if target[0] == "unassigned":
            session.add(
                UnassignedPayment(
                    student_text=d.student_text,
                    phone=d.phone,
                    amount_paise=d.amount_paise,
                    paid_on=d.paid_on,
                    for_month=parse_month(d.for_month),
                    method=d.method,
                    note=d.note,
                    source=(d.source if d.unassigned and d.source else source)[:200],
                )
            )
            unassigned_added += 1
            continue
        student_id = new_students[target[1]].id if target[0] == "new" else target[1]
        session.add(
            Payment(
                student_id=student_id,
                amount_paise=d.amount_paise,
                paid_on=d.paid_on,
                for_month=parse_month(d.for_month),
                method=d.method,
                note=d.note,
            )
        )
        payments_added += 1
    session.flush()
    session.commit()
    added = len(new_students) + payments_added + unassigned_added
    return ImportResult(
        students_added=len(new_students),
        fee_changes_added=fee_count,
        payments_added=payments_added,
        unassigned_added=unassigned_added,
        skipped=total - added,
        backup_file=saved.name if saved else None,
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
