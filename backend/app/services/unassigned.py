"""Unassigned payments: uploaded payments whose student couldn't be matched.

They belong to no student, so the ledger never sees them (no student's or month's totals, no
Collected) until the owner assigns one: that moves it into `payments` for the chosen student,
in one transaction (the payment added, the unassigned row deleted). Or she deletes it.
"""

from __future__ import annotations

import datetime as dt

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import lock_for_writing
from app.errors import not_found, unprocessable
from app.models import Payment, Student, UnassignedPayment
from app.months import format_month
from app.schemas import PaymentRead, UnassignedPaymentRead
from app.services.bounds import check_month, valid_id
from app.services.matching import PeopleIndex, Person, text_digits, text_key
from app.services.payments import get_payment


def _suggested(row: UnassignedPayment, index: PeopleIndex[int], names: dict[int, str]) -> list[int]:
    """Who it may be, best first: the same phone digits, then the same name, then anyone whose
    name has its words, then a name a letter or two apart. At most 5."""
    text = row.student_text
    key, digits = text_key(text), text_digits(text, row.phone)

    def ordered(people: list[Person[int]]) -> list[int]:
        return sorted((p.ident for p in people), key=lambda i: (names[i].casefold(), i))

    found = [
        *ordered(index.same_phone(digits)),
        *ordered(index.same_name(key)),
        *ordered(index.words(key)),
        *ordered(index.near(key)),
    ]
    return list(dict.fromkeys(found))[:5]


def _read(
    row: UnassignedPayment, index: PeopleIndex[int], names: dict[int, str]
) -> UnassignedPaymentRead:
    return UnassignedPaymentRead(
        id=row.id,
        student_text=row.student_text,
        phone=row.phone,
        amount_paise=row.amount_paise,
        paid_on=row.paid_on,
        for_month=format_month(row.for_month),
        method=row.method,
        note=row.note,
        source=row.source,
        created_at=row.created_at,  # type: ignore[arg-type]
        suggested_student_ids=_suggested(row, index, names),
    )


def list_unassigned(session: Session) -> list[UnassignedPaymentRead]:
    """Oldest paid first, as they would appear in a bank statement."""
    rows = session.scalars(
        select(UnassignedPayment).order_by(UnassignedPayment.paid_on, UnassignedPayment.id)
    ).all()
    if not rows:
        return []
    students = list(session.execute(select(Student.id, Student.name, Student.phone)))
    index = PeopleIndex(Person(sid, name, phone) for sid, name, phone in students)
    names = {sid: name for sid, name, _ in students}
    return [_read(r, index, names) for r in rows]


def _get_row(session: Session, row_id: int) -> UnassignedPayment:
    row = session.get(UnassignedPayment, row_id) if valid_id(row_id) else None
    if row is None:
        raise not_found("unassigned payment", row_id)
    return row


def assign(session: Session, row_id: int, student_id: int, today: dt.date) -> PaymentRead:
    """Move it into `payments` for `student_id`, in one transaction. 422 (on `student_id`) if
    that student already has the same payment (amount, paid-on date and month), or if the
    student doesn't exist; 404 if the unassigned payment is gone."""
    lock_for_writing(session)
    row = _get_row(session, row_id)
    student = session.get(Student, student_id) if valid_id(student_id) else None
    if student is None:
        raise unprocessable("That student no longer exists. Choose another.", field="student_id")
    check_month("for_month", row.for_month, today.replace(day=1))
    duplicate = session.scalar(
        select(Payment.id).where(
            Payment.student_id == student_id,
            Payment.amount_paise == row.amount_paise,
            Payment.paid_on == row.paid_on,
            Payment.for_month == row.for_month,
        )
    )
    if duplicate is not None:
        raise unprocessable(
            f"{student.name} already has this payment: the same amount, paid on the same day, "
            f"for {row.for_month:%B %Y}. If it's the same one, delete this one. If they really "
            "paid twice, log it with + Log payment and delete this one.",
            field="student_id",
        )
    payment = Payment(
        student_id=student_id,
        amount_paise=row.amount_paise,
        paid_on=row.paid_on,
        for_month=row.for_month,
        method=row.method,
        note=row.note,
    )
    session.add(payment)
    session.delete(row)
    session.commit()
    return get_payment(session, payment.id, today.replace(day=1))


def delete(session: Session, row_id: int) -> None:
    session.delete(_get_row(session, row_id))
    session.commit()
