"""Students: database work around the pure ledger rules.

Routers call these; they load and save rows, apply the rules in `ledger.py`, and return the
API's response models.

Fee schedule invariant: a student's **earliest fee change is at `joined_month`**, so they always
have a fee in effect from the month they join. Creating a student inserts that first row, and
moving `joined_month` moves it along (see `update_student`).
"""

from __future__ import annotations

import datetime as dt

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.errors import not_found, unprocessable
from app.models import FeeChange, Student
from app.months import format_month, parse_month
from app.schemas import (
    FeeChangeRead,
    LedgerMonth,
    StudentCreate,
    StudentDetail,
    StudentListFilter,
    StudentRead,
    StudentUpdate,
    SuggestedPayment,
)
from app.services import ledger

# --------------------------------------------------------------------------- loading


def to_record(student: Student) -> ledger.StudentRecord:
    """The ledger's view of a student row (with its fee changes and payments)."""
    return ledger.StudentRecord(
        id=student.id,
        name=student.name,
        joined_month=student.joined_month,
        left_month=student.left_month,
        fee_changes=tuple(
            ledger.FeeChange(f.effective_month, f.amount_paise) for f in student.fee_changes
        ),
        payments=tuple(ledger.Payment(p.for_month, p.amount_paise) for p in student.payments),
        batch_label=student.batch_label,
        phone=student.phone,
    )


# Load what the ledger needs in two extra queries, however many students there are.
_LEDGER_ROWS = (selectinload(Student.fee_changes), selectinload(Student.payments))


def all_students(session: Session) -> list[Student]:
    return list(session.scalars(select(Student).options(*_LEDGER_ROWS)))


def get_student_row(session: Session, student_id: int) -> Student:
    student = session.get(Student, student_id, options=_LEDGER_ROWS)
    if student is None:
        raise not_found("student", student_id)
    return student


# --------------------------------------------------------------------------- response shapes


def _read_fields(student: Student, led: ledger.StudentLedger) -> dict[str, object]:
    return {
        "id": student.id,
        "name": student.name,
        "phone": student.phone,
        "guardian_name": student.guardian_name,
        "batch_label": student.batch_label,
        "joined_month": format_month(student.joined_month),
        "left_month": format_month(student.left_month) if student.left_month else None,
        "notes": student.notes,
        "is_active": student.left_month is None,
        "monthly_fee_paise": led.monthly_fee_paise,
        "balance_paise": led.balance_paise,
        "status": led.status,
        "created_at": student.created_at,
        "updated_at": student.updated_at,
    }


def student_read(student: Student, current_month: dt.date) -> StudentRead:
    led = ledger.student_ledger(to_record(student), current_month)
    return StudentRead(**_read_fields(student, led))  # type: ignore[arg-type]


def student_detail(student: Student, current_month: dt.date) -> StudentDetail:
    led = ledger.student_ledger(to_record(student), current_month)
    return StudentDetail(
        **_read_fields(student, led),  # type: ignore[arg-type]
        fee_history=[
            FeeChangeRead(
                id=f.id,
                effective_month=format_month(f.effective_month),
                amount_paise=f.amount_paise,
            )
            for f in sorted(student.fee_changes, key=lambda f: f.effective_month)
        ],
        months=[
            LedgerMonth(
                month=format_month(line.month),
                expected_paise=line.expected_paise,
                paid_paise=line.paid_paise,
                remaining_paise=line.remaining_paise,
                excess_paise=line.excess_paise,
                status=line.status,
                is_due=line.is_due,
            )
            for line in led.months
        ],
        payment_count=led.payment_count,
        total_paid_paise=led.total_paid_paise,
    )


# --------------------------------------------------------------------------- queries


def _matches(student: Student, q: str) -> bool:
    """Case-insensitive match on name, phone or guardian. Spaces in phone numbers are ignored,
    so "9876543210" finds "98765 43210"."""
    needle = q.casefold()
    texts = (student.name, student.guardian_name, student.phone)
    if any(t and needle in t.casefold() for t in texts):
        return True
    digits = needle.replace(" ", "")
    return bool(digits and student.phone and digits in student.phone.replace(" ", ""))


def list_students(
    session: Session,
    status_filter: StudentListFilter,
    q: str | None,
    current_month: dt.date,
) -> list[StudentRead]:
    """Students sorted by name. `active` = not archived (no `left_month`); `left` = archived."""
    rows = all_students(session)
    if status_filter is StudentListFilter.active:
        rows = [s for s in rows if s.left_month is None]
    elif status_filter is StudentListFilter.left:
        rows = [s for s in rows if s.left_month is not None]
    if q and q.strip():
        rows = [s for s in rows if _matches(s, q.strip())]
    rows.sort(key=lambda s: (s.name.casefold(), s.id))
    return [student_read(s, current_month) for s in rows]


def get_student(session: Session, student_id: int, current_month: dt.date) -> StudentDetail:
    return student_detail(get_student_row(session, student_id), current_month)


def suggest_payment(session: Session, student_id: int, current_month: dt.date) -> SuggestedPayment:
    suggestion = ledger.suggest_payment(
        to_record(get_student_row(session, student_id)), current_month
    )
    return SuggestedPayment(
        for_month=format_month(suggestion.for_month), amount_paise=suggestion.amount_paise
    )


# --------------------------------------------------------------------------- changes


def create_student(session: Session, body: StudentCreate, current_month: dt.date) -> StudentDetail:
    """Create a student and their first fee change at `joined_month`."""
    joined = parse_month(body.joined_month)
    student = Student(
        name=body.name,
        phone=body.phone,
        guardian_name=body.guardian_name,
        batch_label=body.batch_label,
        joined_month=joined,
        left_month=parse_month(body.left_month) if body.left_month else None,
        notes=body.notes,
    )
    student.fee_changes.append(
        FeeChange(effective_month=joined, amount_paise=body.monthly_fee_paise)
    )
    session.add(student)
    session.commit()
    return get_student(session, student.id, current_month)


def update_student(
    session: Session, student_id: int, body: StudentUpdate, current_month: dt.date
) -> StudentDetail:
    """Partial update (only the fields that were sent change). The edit rules are the ones in
    `StudentUpdate`'s docstring and docs/data-model.md; each failure is a 422 and changes nothing.

    1. Moving `joined_month` moves the earliest fee change with it. 422 if the new joined month
       is on or after a later fee change.
    2. `monthly_fee_paise` records a fee change from `fee_effective_month`, which defaults to the
       current month, or the joined month if that is later. 422 if it is before the joined
       month. A month that already has a fee change gets its amount replaced; if the fee is
       already in effect then, nothing is recorded. Earlier and later fee changes are kept.
    3. `left_month` before `joined_month` (the new one if sent, else the stored one): 422.
       `left_month: null` un-archives.
    """
    student = get_student_row(session, student_id)
    sent = body.model_fields_set
    fees = sorted(student.fee_changes, key=lambda f: f.effective_month)

    joined = parse_month(body.joined_month) if body.joined_month else student.joined_month
    if joined != student.joined_month and len(fees) > 1 and joined >= fees[1].effective_month:
        raise unprocessable(
            "joined_month cannot be on or after a later fee change "
            f"({format_month(fees[1].effective_month)}); change or remove that fee first",
            field="joined_month",
        )

    left = student.left_month
    if "left_month" in sent:
        left = parse_month(body.left_month) if body.left_month else None
    if left is not None and left < joined:
        field = "left_month" if "left_month" in sent else "joined_month"
        raise unprocessable("left_month cannot be before joined_month", field=field)

    fee_month: dt.date | None = None
    if body.monthly_fee_paise is not None:
        fee_month = (
            parse_month(body.fee_effective_month)
            if body.fee_effective_month
            else max(current_month, joined)
        )
        if fee_month < joined:
            raise unprocessable(
                "the new fee cannot start before joined_month", field="fee_effective_month"
            )

    for name in ("name", "phone", "guardian_name", "batch_label", "notes"):
        if name in sent:
            setattr(student, name, getattr(body, name))
    student.left_month = left
    if joined != student.joined_month:
        student.joined_month = joined
        if fees:
            fees[0].effective_month = joined
        else:  # never happens through the API, but keep "a fee from joined_month" true
            student.fee_changes.append(FeeChange(effective_month=joined, amount_paise=0))
        session.flush()

    if fee_month is not None and body.monthly_fee_paise is not None:
        _set_fee_from(session, student, fee_month, body.monthly_fee_paise)

    session.commit()
    session.expire(student)
    return get_student(session, student.id, current_month)


def _set_fee_from(session: Session, student: Student, month: dt.date, amount: int) -> None:
    """Record that the fee is `amount` from `month` on (an upsert on the fee change for that
    month). Nothing is recorded if that fee is already in effect then."""
    existing = next((f for f in student.fee_changes if f.effective_month == month), None)
    if existing is not None:
        existing.amount_paise = amount
    elif to_record(student).fee_in_effect(month) != amount:
        student.fee_changes.append(FeeChange(effective_month=month, amount_paise=amount))
    session.flush()


def delete_student(session: Session, student_id: int) -> None:
    """Hard delete; the database cascades to fee changes and payments."""
    student = session.get(Student, student_id)
    if student is None:
        raise not_found("student", student_id)
    session.delete(student)
    session.commit()
