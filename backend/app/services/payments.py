"""Payments: list (filter, search, sort), create, read, update, delete."""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable

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
from app.services.bounds import check_month, check_paid_on, valid_id
from app.services.text import contains, fold

_Row = tuple[Payment, str]

_SORT_KEYS: dict[PaymentSort, Callable[[_Row], object]] = {
    PaymentSort.paid_on: lambda r: r[0].paid_on,
    PaymentSort.for_month: lambda r: r[0].for_month,
    PaymentSort.amount: lambda r: r[0].amount_paise,
    PaymentSort.student: lambda r: fold(r[1]),
    PaymentSort.method: lambda r: r[0].method.value,
}


def payment_read(payment: Payment, student_name: str) -> PaymentRead:
    return PaymentRead(
        id=payment.id,
        student_id=payment.student_id,
        student_name=student_name,
        amount_paise=payment.amount_paise,
        paid_on=payment.paid_on,
        for_month=format_month(payment.for_month),
        method=payment.method,
        note=payment.note,
        created_at=payment.created_at,
        updated_at=payment.updated_at,
    )


def list_payments(
    session: Session,
    *,
    student_id: int | None = None,
    month: str | None = None,
    q: str | None = None,
    sort: PaymentSort = PaymentSort.paid_on,
    order: SortOrder = SortOrder.desc,
) -> list[PaymentRead]:
    """Payments matching every filter given, in one query.

    - `month` matches `for_month`.
    - `q` searches the student's name and the payment's note, ignoring case and accents.
    - Sorted by `sort` in `order` (student names ignoring case and accents); ties go to the most
      recent `paid_on`, then the newest entry.

    Search and sort happen in Python because SQLite only understands A-Z case.
    """
    if student_id is not None and not valid_id(student_id):
        return []
    stmt = select(Payment, Student.name).join(Student, Payment.student_id == Student.id)
    if student_id is not None:
        stmt = stmt.where(Payment.student_id == student_id)
    if month is not None:
        stmt = stmt.where(Payment.for_month == parse_month(month))
    rows: list[_Row] = [(p, name) for p, name in session.execute(stmt)]

    if q and q.strip():
        needle = fold(q.strip())
        rows = [(p, name) for p, name in rows if contains(name, needle) or contains(p.note, needle)]

    rows.sort(key=lambda r: (r[0].paid_on, r[0].id), reverse=True)  # the tie-breakers
    rows.sort(key=_SORT_KEYS[sort], reverse=order is SortOrder.desc)  # stable
    return [payment_read(p, name) for p, name in rows]


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


def get_payment(session: Session, payment_id: int) -> PaymentRead:
    payment = _get_row(session, payment_id)
    return payment_read(payment, _student_name(session, payment.student_id))


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
    return get_payment(session, payment.id)


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
    return get_payment(session, payment.id)


def delete_payment(session: Session, payment_id: int) -> None:
    session.delete(_get_row(session, payment_id))
    session.commit()
