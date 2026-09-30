"""Payments: list (filter, search, sort), create, read, update, delete."""

from __future__ import annotations

from sqlalchemy import Select, func, or_, select
from sqlalchemy.orm import Session

from app.models import Payment, Student
from app.months import format_month, parse_month
from app.schemas import (
    PaymentCreate,
    PaymentRead,
    PaymentSort,
    PaymentUpdate,
    SortOrder,
)
from app.services.errors import NotFound

_SORT_COLUMNS = {
    PaymentSort.paid_on: Payment.paid_on,
    PaymentSort.for_month: Payment.for_month,
    PaymentSort.amount: Payment.amount_paise,
    PaymentSort.student: func.lower(Student.name),
    PaymentSort.method: Payment.method,
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


def _query() -> Select[tuple[Payment, str]]:
    return select(Payment, Student.name).join(Student, Payment.student_id == Student.id)


def list_payments(
    session: Session,
    *,
    student_id: int | None = None,
    month: str | None = None,
    q: str | None = None,
    sort: PaymentSort = PaymentSort.paid_on,
    order: SortOrder = SortOrder.desc,
) -> list[PaymentRead]:
    """Payments matching every filter given.

    - `month` matches `for_month`.
    - `q` is a case-insensitive search on the student's name and the payment's note.
    - Sorted by `sort` in `order`; ties go to the most recent `paid_on`, then the newest entry.
    """
    stmt = _query()
    if student_id is not None:
        stmt = stmt.where(Payment.student_id == student_id)
    if month is not None:
        stmt = stmt.where(Payment.for_month == parse_month(month))
    if q and q.strip():
        needle = q.strip()
        stmt = stmt.where(
            or_(
                Student.name.icontains(needle, autoescape=True),
                Payment.note.icontains(needle, autoescape=True),
            )
        )
    column = _SORT_COLUMNS[sort]
    primary = column.asc() if order is SortOrder.asc else column.desc()
    stmt = stmt.order_by(primary, Payment.paid_on.desc(), Payment.id.desc())
    return [payment_read(p, name) for p, name in session.execute(stmt)]


def _student_name(session: Session, student_id: int) -> str:
    name = session.scalar(select(Student.name).where(Student.id == student_id))
    if name is None:
        raise NotFound("student", student_id)
    return name


def _get_row(session: Session, payment_id: int) -> Payment:
    payment = session.get(Payment, payment_id)
    if payment is None:
        raise NotFound("payment", payment_id)
    return payment


def get_payment(session: Session, payment_id: int) -> PaymentRead:
    payment = _get_row(session, payment_id)
    return payment_read(payment, _student_name(session, payment.student_id))


def create_payment(session: Session, body: PaymentCreate) -> PaymentRead:
    """404 if the student doesn't exist. Any month is accepted: a payment for a month the
    student isn't active in shows up as Overpaid (see the ledger rules)."""
    _student_name(session, body.student_id)
    payment = Payment(
        student_id=body.student_id,
        amount_paise=body.amount_paise,
        paid_on=body.paid_on,
        for_month=parse_month(body.for_month),
        method=body.method,
        note=body.note,
    )
    session.add(payment)
    session.commit()
    session.refresh(payment)
    return get_payment(session, payment.id)


def update_payment(session: Session, payment_id: int, body: PaymentUpdate) -> PaymentRead:
    """Partial update. 404 if the payment, or a newly given student, doesn't exist."""
    payment = _get_row(session, payment_id)
    sent = body.model_fields_set
    if "student_id" in sent and body.student_id is not None:
        _student_name(session, body.student_id)
        payment.student_id = body.student_id
    if "amount_paise" in sent and body.amount_paise is not None:
        payment.amount_paise = body.amount_paise
    if "paid_on" in sent and body.paid_on is not None:
        payment.paid_on = body.paid_on
    if "for_month" in sent and body.for_month is not None:
        payment.for_month = parse_month(body.for_month)
    if "method" in sent and body.method is not None:
        payment.method = body.method
    if "note" in sent:
        payment.note = body.note
    session.commit()
    session.refresh(payment)
    return get_payment(session, payment.id)


def delete_payment(session: Session, payment_id: int) -> None:
    session.delete(_get_row(session, payment_id))
    session.commit()
