"""Payments: list (filter, search, sort), create, read, update, delete.

Every payment is returned exactly as typed, plus where its money went (PRD ledger rule 10:
its own month first, then the oldest unpaid months). That depends on the student's other
payments and fees, so the student's whole ledger is loaded with it.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable, Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import not_found
from app.models import Payment, Student
from app.months import format_month, parse_month
from app.schemas import (
    PaymentCreate,
    PaymentRead,
    PaymentSort,
    PaymentUpdate,
    SortOrder,
)
from app.services import ledger
from app.services.bounds import check_month, check_paid_on, valid_id
from app.services.students import (
    LEDGER_ROWS,
    all_students,
    extra_sent_read,
    to_record,
)
from app.services.text import contains, fold

_Row = tuple[Payment, str]

_SORT_KEYS: dict[PaymentSort, Callable[[_Row], object]] = {
    PaymentSort.paid_on: lambda r: r[0].paid_on,
    PaymentSort.for_month: lambda r: r[0].for_month,
    PaymentSort.amount: lambda r: r[0].amount_paise,
    PaymentSort.student: lambda r: fold(r[1]),
    PaymentSort.method: lambda r: r[0].method.value,
}


def _uses(
    students: Iterable[Student], current_month: dt.date
) -> dict[int, tuple[ledger.PaymentUse, int, bool]]:
    """Where each payment's money went, how many months ahead it pays, and whether it's worth a
    glance, by payment id."""
    out: dict[int, tuple[ledger.PaymentUse, int, bool]] = {}
    for student in students:
        for use in ledger.payment_uses(to_record(student), current_month):
            out[use.payment.id] = (
                use,
                ledger.months_ahead(use, current_month),
                ledger.needs_check(use, current_month),
            )
    return out


def payment_read(
    payment: Payment, student_name: str, use: tuple[ledger.PaymentUse, int, bool]
) -> PaymentRead:
    use_, ahead, check = use
    return PaymentRead(
        id=payment.id,
        student_id=payment.student_id,
        student_name=student_name,
        amount_paise=payment.amount_paise,
        paid_on=payment.paid_on,
        for_month=format_month(payment.for_month),
        method=payment.method,
        note=payment.note,
        paid_direct_paise=use_.direct_paise,
        needs_check=check,
        months_ahead=ahead,
        extra_sent=extra_sent_read(use_.sent),
        extra_unused_paise=use_.unused_paise,
        created_at=payment.created_at,
        updated_at=payment.updated_at,
    )


def list_payments(
    session: Session,
    current_month: dt.date,
    *,
    student_id: int | None = None,
    month: str | None = None,
    q: str | None = None,
    sort: PaymentSort = PaymentSort.paid_on,
    order: SortOrder = SortOrder.desc,
) -> list[PaymentRead]:
    """Payments matching every filter given, with where their money went, in three queries
    (the students, their fee changes and their payments) however many rows there are.

    - `month` matches `for_month`.
    - `q` searches the student's name and the payment's note, ignoring case and accents.
    - Sorted by `sort` in `order` (student names ignoring case and accents); ties go to the most
      recent `paid_on`, then the newest entry.

    Search and sort happen in Python because SQLite only understands A-Z case.
    """
    if student_id is not None and not valid_id(student_id):
        return []
    if student_id is None:
        students = all_students(session)
    else:
        one = session.get(Student, student_id, options=LEDGER_ROWS)
        students = [one] if one is not None else []
    uses = _uses(students, current_month)
    rows: list[_Row] = [(p, s.name) for s in students for p in s.payments]
    if month is not None:
        for_month = parse_month(month)
        rows = [(p, name) for p, name in rows if p.for_month == for_month]

    if q and q.strip():
        needle = fold(q.strip())
        rows = [(p, name) for p, name in rows if contains(name, needle) or contains(p.note, needle)]

    rows.sort(key=lambda r: (r[0].paid_on, r[0].id), reverse=True)  # the tie-breakers
    rows.sort(key=_SORT_KEYS[sort], reverse=order is SortOrder.desc)  # stable
    return [payment_read(p, name, uses[p.id]) for p, name in rows]


def _student_name(session: Session, student_id: int) -> str:
    name = (
        session.scalar(select(Student.name).where(Student.id == student_id))
        if valid_id(student_id)
        else None
    )
    if name is None:
        raise not_found("student", student_id)
    return name


def _get_row(session: Session, payment_id: int) -> Payment:
    payment = session.get(Payment, payment_id) if valid_id(payment_id) else None
    if payment is None:
        raise not_found("payment", payment_id)
    return payment


def get_payment(session: Session, payment_id: int, current_month: dt.date) -> PaymentRead:
    """One payment, with where its money went: the student and their whole ledger in three
    queries."""
    student = (
        session.scalar(
            select(Student)
            .join(Payment, Payment.student_id == Student.id)
            .where(Payment.id == payment_id)
            .options(*LEDGER_ROWS)
        )
        if valid_id(payment_id)
        else None
    )
    if student is None:
        raise not_found("payment", payment_id)
    uses = _uses([student], current_month)
    payment = next(p for p in student.payments if p.id == payment_id)
    return payment_read(payment, student.name, uses[payment.id])


def create_payment(session: Session, body: PaymentCreate, today: dt.date) -> PaymentRead:
    """404 if the student doesn't exist. Any month within the limits is accepted: a payment for
    a month the student isn't active in shows up as Overpaid (see the ledger rules)."""
    for_month = parse_month(body.for_month)
    check_month("for_month", for_month, today.replace(day=1))
    check_paid_on(body.paid_on, today)
    _student_name(session, body.student_id)
    payment = Payment(
        student_id=body.student_id,
        amount_paise=body.amount_paise,
        paid_on=body.paid_on,
        for_month=for_month,
        method=body.method,
        note=body.note,
    )
    session.add(payment)
    session.commit()
    return get_payment(session, payment.id, today.replace(day=1))


def update_payment(
    session: Session, payment_id: int, body: PaymentUpdate, today: dt.date
) -> PaymentRead:
    """Partial update. 404 if the payment, or a newly given student, doesn't exist."""
    payment = _get_row(session, payment_id)
    sent = body.model_fields_set
    if "for_month" in sent and body.for_month is not None:
        for_month = parse_month(body.for_month)
        check_month("for_month", for_month, today.replace(day=1))
        payment.for_month = for_month
    if "paid_on" in sent and body.paid_on is not None:
        check_paid_on(body.paid_on, today)
        payment.paid_on = body.paid_on
    if "student_id" in sent and body.student_id is not None:
        _student_name(session, body.student_id)
        payment.student_id = body.student_id
    if "amount_paise" in sent and body.amount_paise is not None:
        payment.amount_paise = body.amount_paise
    if "method" in sent and body.method is not None:
        payment.method = body.method
    if "note" in sent:
        payment.note = body.note
    session.commit()
    return get_payment(session, payment.id, today.replace(day=1))


def delete_payment(session: Session, payment_id: int) -> None:
    session.delete(_get_row(session, payment_id))
    session.commit()
