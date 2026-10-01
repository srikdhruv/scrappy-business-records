"""Students: database work around the pure ledger rules.

Routers call these; they load and save rows, apply the rules in `ledger.py`, and return the
API's response models.

Fee schedule invariant: a student's **earliest fee change is at `joined_month`**, so they always
have a fee in effect from the month they join. Creating a student inserts that first row, and
moving `joined_month` moves it along (see `update_student`). That first row can never be
removed (`delete_fee_change`), and coming back after leaving (`return_student`) only touches
months after `left_month`.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterable
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload, selectinload

from app.db import lock_for_writing
from app.errors import not_found, unprocessable
from app.models import Batch, FeeChange, FeeKind, Student
from app.months import add_months, format_month, parse_month
from app.schemas import (
    CreditSource,
    ExtraSent,
    FeeChangeRead,
    LedgerMonth,
    StudentCreate,
    StudentDetail,
    StudentListFilter,
    StudentRead,
    StudentReturn,
    StudentUpdate,
    SuggestedPayment,
)
from app.services import ledger
from app.services.bounds import check_month, valid_id
from app.services.text import fold


def same_text_key(text: str) -> str:
    """How two bits of typed text are compared when they name the same thing (a batch, a
    location): ignoring capitals, accents and spaces, so "Tue/Thu 5pm", "tue/thu  5PM" and
    "Tue/Thu5pm" are the same."""
    return "".join(fold(text).split())


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
        payments=tuple(
            ledger.Payment(p.for_month, p.amount_paise, p.paid_on, p.id) for p in student.payments
        ),
        batch_label=student.batch_label,
        phone=student.phone,
        batch_name=student.batch.name if student.batch else None,
    )


# Load what the ledger needs in two extra queries, however many students there are (and each
# student's batch in the same query as the students).
LEDGER_ROWS = (
    joinedload(Student.batch),
    selectinload(Student.fee_changes),
    selectinload(Student.payments),
)


def all_students(session: Session) -> list[Student]:
    return list(session.scalars(select(Student).options(*LEDGER_ROWS)))


def get_student_row(session: Session, student_id: int) -> Student:
    student = (
        # populate_existing: a student already in this session (just saved) is read again,
        # with everything LEDGER_ROWS loads.
        session.get(Student, student_id, options=LEDGER_ROWS, populate_existing=True)
        if valid_id(student_id)
        else None
    )
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
        "batch_id": student.batch_id,
        "batch_name": student.batch.name if student.batch else None,
        "joined_month": format_month(student.joined_month),
        "left_month": format_month(student.left_month) if student.left_month else None,
        "notes": student.notes,
        "is_active": led.is_active,
        "monthly_fee_paise": led.monthly_fee_paise,
        "balance_paise": led.balance_paise,
        "status": led.status,
        "owed_paise": led.owed_paise,
        "paid_ahead_paise": led.paid_ahead_paise,
        "credit_paise": led.credit_paise,
        "tenure_months": led.tenure_months,
        "next_fee_change": _next_fee_change(student, led.current_month),
        "current_month": led.current_month,
        "created_at": student.created_at,
        "updated_at": student.updated_at,
    }


def _next_fee_change(student: Student, current_month: dt.date) -> FeeChangeRead | None:
    """The first fee change after the month `monthly_fee_paise` is for (this month, or the joining
    month for someone who hasn't joined yet), so "No fee until December 2026, then ₹1,000"."""
    after = max(current_month, student.joined_month)
    later = sorted(
        (f for f in student.fee_changes if f.effective_month > after),
        key=lambda f: f.effective_month,
    )
    if not later:
        return None
    f = later[0]
    return FeeChangeRead(
        id=f.id,
        effective_month=format_month(f.effective_month),
        amount_paise=f.amount_paise,
        kind=f.kind,
    )


def extra_sent_read(sent: Iterable[ledger.ExtraSent]) -> list[ExtraSent]:
    return [ExtraSent(to_month=format_month(e.to_month), amount_paise=e.amount_paise) for e in sent]


def credit_sources_read(sources: Iterable[ledger.CreditSource]) -> list[CreditSource]:
    return [
        CreditSource(
            payment_id=c.payment_id,
            paid_on=c.paid_on,  # type: ignore[arg-type]  # always set for stored payments
            for_month=format_month(c.for_month),
            amount_paise=c.amount_paise,
        )
        for c in sources
    ]


def ledger_month(line: ledger.MonthLine) -> LedgerMonth:
    return LedgerMonth(
        month=format_month(line.month),
        expected_paise=line.expected_paise,
        paid_paise=line.paid_paise,
        paid_direct_paise=line.paid_direct_paise,
        covered_by_credit_paise=line.covered_by_credit_paise,
        credit_sources=credit_sources_read(line.credit_sources),
        extra_sent=extra_sent_read(line.extra_sent),
        extra_unused_paise=line.extra_unused_paise,
        remaining_paise=line.remaining_paise,
        excess_paise=line.excess_paise,
        status=line.status,
        is_due=line.is_due,
    )


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
                kind=f.kind,
            )
            for f in sorted(student.fee_changes, key=lambda f: f.effective_month)
        ],
        months=[ledger_month(line) for line in led.months],
        payment_count=led.payment_count,
        total_paid_paise=led.total_paid_paise,
    )


# --------------------------------------------------------------------------- queries


def _matches(student: Student, q: str) -> bool:
    """Match on name, phone or guardian, ignoring case and accents. Spaces in phone numbers are
    ignored, so "9000000010" finds "90000 00010"."""
    needle = fold(q)
    texts = (student.name, student.guardian_name, student.phone)
    if any(t and needle in fold(t) for t in texts):
        return True
    digits = needle.replace(" ", "")
    return bool(digits and student.phone and digits in student.phone.replace(" ", ""))


NO_BATCH = "none"
"""`GET /students?batch=none`: the students who aren't in any batch."""


def list_students(
    session: Session,
    status_filter: StudentListFilter,
    q: str | None,
    current_month: dt.date,
    batch: int | Literal["none"] | None = None,
    location: str | None = None,
) -> list[StudentRead]:
    """Students sorted by name. `active` = not left yet (no `left_month`, or it is this month or
    later); `left` = the left month has passed. `batch` keeps one batch's students (an id), or
    those in no batch (`"none"`); `location` keeps the students whose batch is at that location
    (ignoring capitals, accents and extra spaces)."""
    rows = all_students(session)
    if batch == NO_BATCH:
        rows = [s for s in rows if s.batch_id is None]
    elif batch is not None:
        rows = [s for s in rows if s.batch_id == batch]
    if location is not None and location.strip():
        place = same_text_key(location)
        rows = [
            s
            for s in rows
            if s.batch and s.batch.location and same_text_key(s.batch.location) == place
        ]
    if status_filter is not StudentListFilter.all:
        want_left = status_filter is StudentListFilter.left
        rows = [s for s in rows if ledger.has_left(to_record(s), current_month) == want_left]
    if q and q.strip():
        rows = [s for s in rows if _matches(s, q.strip())]
    rows.sort(key=lambda s: (fold(s.name), s.id))
    return [student_read(s, current_month) for s in rows]


def get_student(session: Session, student_id: int, current_month: dt.date) -> StudentDetail:
    return student_detail(get_student_row(session, student_id), current_month)


def suggest_payment(session: Session, student_id: int, current_month: dt.date) -> SuggestedPayment:
    suggestion = ledger.suggest_payment(
        to_record(get_student_row(session, student_id)), current_month
    )
    return SuggestedPayment(
        for_month=suggestion.for_month,  # type: ignore[arg-type]  # Month accepts a date
        amount_paise=suggestion.amount_paise,
        reason=suggestion.reason,
    )


# --------------------------------------------------------------------------- changes


def create_student(session: Session, body: StudentCreate, current_month: dt.date) -> StudentDetail:
    """Create a student and their first fee change at `joined_month`."""
    joined = parse_month(body.joined_month)
    check_month("joined_month", joined, current_month)
    if body.left_month:
        check_month("left_month", parse_month(body.left_month), current_month)
    check_batch(session, body.batch_id)
    student = Student(
        name=body.name,
        phone=body.phone,
        guardian_name=body.guardian_name,
        batch_label=body.batch_label,
        batch_id=body.batch_id,
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
    lock_for_writing(session)
    student = get_student_row(session, student_id)
    sent = body.model_fields_set
    fees = sorted(student.fee_changes, key=lambda f: f.effective_month)

    joined = parse_month(body.joined_month) if body.joined_month else student.joined_month
    if body.joined_month:
        check_month("joined_month", joined, current_month)
    if body.left_month:
        check_month("left_month", parse_month(body.left_month), current_month)
    if body.fee_effective_month:
        check_month("fee_effective_month", parse_month(body.fee_effective_month), current_month)
    if joined != student.joined_month and len(fees) > 1 and joined >= fees[1].effective_month:
        raise unprocessable(
            "The joined month can't be on or after a later fee change "
            f"({fees[1].effective_month:%B %Y}). Change that fee first.",
            field="joined_month",
        )

    left = student.left_month
    if "left_month" in sent:
        left = parse_month(body.left_month) if body.left_month else None
    # Once their last month has passed, it can only move earlier here. Moving it later (or
    # emptying it) would make every month away owed; coming back is `return_student`.
    stored_left = student.left_month
    if (
        "left_month" in sent
        and stored_left is not None
        and stored_left < current_month
        and (left is None or left > stored_left)
    ):
        raise unprocessable(
            f"They left after {stored_left:%B %Y}, so this can only move earlier. If they came "
            "back: first set the real last month they paid for before leaving (an earlier one "
            "is fine), then use Mark as coming again from the month they came back. Set a new "
            "Left month after that if needed.",
            field="left_month",
        )
    if left is not None and left < joined:
        field = "left_month" if "left_month" in sent else "joined_month"
        raise unprocessable("Left month can't be before the joined month", field=field)

    fee_month: dt.date | None = None
    if body.monthly_fee_paise is not None:
        fee_month = (
            parse_month(body.fee_effective_month)
            if body.fee_effective_month
            else max(current_month, joined)
        )
        if fee_month < joined:
            raise unprocessable(
                "The new fee can't start before the joined month", field="fee_effective_month"
            )

    if "batch_id" in sent:
        check_batch(session, body.batch_id)

    for name in ("name", "phone", "guardian_name", "batch_label", "batch_id", "notes"):
        if name in sent:
            setattr(student, name, getattr(body, name))
    if left is not None and left != student.left_month:
        _drop_stale_away(session, student, left)
    student.left_month = left
    if joined != student.joined_month:
        student.joined_month = joined
        if fees:
            fees[0].effective_month = joined
        else:  # never happens through the API, but keep "a fee from joined_month" true
            student.fee_changes.append(FeeChange(effective_month=joined, amount_paise=0))
        session.flush()

    if fee_month is not None and body.monthly_fee_paise is not None:
        set_fee_from(session, student, fee_month, body.monthly_fee_paise)

    session.commit()
    session.expire(student)
    return get_student(session, student.id, current_month)


def check_batch(session: Session, batch_id: int | None) -> None:
    """422 on `batch_id` if it names no batch (say it was deleted in another window)."""
    if batch_id is not None and (not valid_id(batch_id) or session.get(Batch, batch_id) is None):
        raise unprocessable(
            "That batch doesn't exist any more. Choose another one, or No batch.",
            field="batch_id",
        )


def set_fee_from(session: Session, student: Student, month: dt.date, amount: int) -> None:
    """Record that the fee is `amount` from `month` on (an upsert on the fee change for that
    month). Nothing is recorded if that fee is already in effect then."""
    existing = next((f for f in student.fee_changes if f.effective_month == month), None)
    if existing is not None:
        # The owner set it, so it is theirs now, even where it was a month away.
        existing.amount_paise, existing.kind = amount, FeeKind.fee
    elif to_record(student).fee_in_effect(month) != amount:
        student.fee_changes.append(FeeChange(effective_month=month, amount_paise=amount))
    session.flush()


def return_student(
    session: Session, student_id: int, body: StudentReturn, current_month: dt.date
) -> StudentDetail:
    """A student who left is coming again from `from_month` (PRD ledger rule 11), in one
    transaction that holds the database's write lock from the start (so two clicks can't both
    apply it). The months they were away are never owed:

    - the months between `left_month` and `from_month` get a 0 fee (one fee change at the month
      after `left_month`; none if they're back straight away);
    - from `from_month` they owe `monthly_fee_paise` if it was sent, else `return_fee`: the
      latest fee the owner set on or before that month (never an 'away' row);
    - every fee change after `left_month` and before `from_month` is removed (replaced by one
      'away' row), and so is every 'away' row after `left_month` (leftovers of earlier
      returns); a fee change at `from_month` gets that fee. Fee changes the owner set after
      `from_month`, a planned month off included, are kept;
    - `left_month` is cleared.

    422 (on `from_month`) if they haven't been marked as left, if `from_month` isn't after
    `left_month`, or if it is more than 24 months ahead. The first fee (at `joined_month`) is
    never touched: it is always on or before `left_month`.
    """
    lock_for_writing(session)
    student = get_student_row(session, student_id)
    left = student.left_month
    if left is None:
        raise unprocessable("They haven't been marked as left", field="from_month")
    back = parse_month(body.from_month)
    first_away = add_months(left, 1)
    if back < first_away:
        raise unprocessable(
            f"They can only be back from {first_away:%B %Y} on, the month after they left",
            field="from_month",
        )
    check_month("from_month", back, current_month)

    fee_back = (
        body.monthly_fee_paise
        if body.monthly_fee_paise is not None
        else return_fee(student.fee_changes, back)
    )
    stale = [
        f
        for f in student.fee_changes
        # The gap is rewritten; 'away' rows after leaving are leftovers of earlier returns.
        if left < f.effective_month < back or (f.kind is FeeKind.away and f.effective_month > left)
    ]
    for change in stale:
        student.fee_changes.remove(change)  # delete-orphan: the row is deleted
    session.flush()  # delete before inserting, so a change at `first_away` can't clash
    gap = back > first_away
    if gap:
        student.fee_changes.append(
            FeeChange(effective_month=first_away, amount_paise=0, kind=FeeKind.away)
        )
        session.flush()
    at_back = next((f for f in student.fee_changes if f.effective_month == back), None)
    if at_back is not None:
        at_back.amount_paise, at_back.kind = fee_back, FeeKind.fee
    elif gap or to_record(student).fee_in_effect(back) != fee_back:
        # After a gap there is always a fee row at `back`, even ₹0: it ends the months away.
        student.fee_changes.append(FeeChange(effective_month=back, amount_paise=fee_back))
    session.flush()
    student.left_month = None

    session.commit()
    session.expire(student)
    return get_student(session, student.id, current_month)


def return_fee(fee_changes: Iterable[FeeChange], back: dt.date) -> int:
    """The fee someone coming back from `back` owes: the latest fee the owner set (`kind`
    'fee') on or before `back`. 'away' rows (an earlier return's months away) never count.
    Usually that's the fee they paid when they left; a raise set for a month while they were
    away counts, and so does a ₹0 month off the owner set. The first fee is always a 'fee' on
    or before `back`, so there is always one."""
    eligible = [f for f in fee_changes if f.effective_month <= back and f.kind is FeeKind.fee]
    return max(eligible, key=lambda f: f.effective_month).amount_paise


def _drop_stale_away(session: Session, student: Student, left: dt.date) -> None:
    """The left month is being set to `left`: remove the 'away' rows (months away of an
    earlier return) that no longer match. A run of months away starts at an 'away' row and
    ends before the next 'fee' row. If that run ends before `left`, it's an earlier absence
    and stays. If it reaches `left` or comes after it, it contradicts "they owe up to `left`"
    (say the left month was corrected from March to May), so it goes: those months are owed
    again, up to `left`, and nothing is owed after it anyway."""
    rows = sorted(student.fee_changes, key=lambda f: f.effective_month)
    stale: list[FeeChange] = []
    for i, row in enumerate(rows):
        if row.kind is not FeeKind.away:
            continue
        end = next((f.effective_month for f in rows[i + 1 :] if f.kind is FeeKind.fee), None)
        if end is None or add_months(end, -1) >= left:
            stale.append(row)
    for row in stale:
        student.fee_changes.remove(row)
    session.flush()


def delete_fee_change(
    session: Session, student_id: int, fee_change_id: int, current_month: dt.date
) -> None:
    """Remove a fee change that hasn't started yet (PRD ledger rule 7). The fee before it then
    carries on until the next fee change, if any.

    404 if the student, or that fee change of theirs, doesn't exist. 422 for the first fee (at
    `joined_month`, which every student must have) and for a fee change that has already
    started (its month is the current month or earlier), since that would rewrite what past
    months were owed.
    """
    lock_for_writing(session)
    student = get_student_row(session, student_id)
    fees = sorted(student.fee_changes, key=lambda f: f.effective_month)
    change = next((f for f in fees if f.id == fee_change_id), None)
    if change is None:
        raise not_found("fee change", fee_change_id)
    if change is fees[0]:
        raise unprocessable(
            "The first fee can't be removed. To change it, use Edit.",
            field="fee_change_id",
            location="path",
        )
    i = fees.index(change)
    if change.kind is FeeKind.fee and fees[i - 1].kind is FeeKind.away:
        # Without it the months away would never end, though they're coming again.
        raise unprocessable(
            "This is the fee they came back on. To change it, set a new fee in Edit.",
            field="fee_change_id",
            location="path",
        )
    if change.effective_month <= current_month:
        raise unprocessable(
            "Only a fee change that hasn't started yet can be removed. To change a fee that has "
            "started, set a new fee with Edit.",
            field="fee_change_id",
            location="path",
        )
    student.fee_changes.remove(change)
    session.commit()


def delete_student(session: Session, student_id: int) -> None:
    """Hard delete; the database cascades to fee changes and payments (they aren't loaded)."""
    student = session.get(Student, student_id) if valid_id(student_id) else None
    if student is None:
        raise not_found("student", student_id)
    session.delete(student)
    session.commit()
