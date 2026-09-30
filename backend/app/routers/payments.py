"""Payments: list, create, detail, update, delete. The work is in `app/services/payments.py`."""

from fastapi import APIRouter, Query, status

from app.clock import TodayDep
from app.db import SessionDep
from app.schemas import (
    ErrorResponse,
    Month,
    PaymentCreate,
    PaymentRead,
    PaymentSort,
    PaymentUpdate,
    SortOrder,
)
from app.services import payments as service

router = APIRouter(prefix="/payments", tags=["payments"])

NOT_FOUND = {404: {"model": ErrorResponse, "description": "No payment with this id"}}


@router.get("", response_model=list[PaymentRead], operation_id="listPayments")
def list_payments(
    session: SessionDep,
    student_id: int | None = Query(None, gt=0, description="Only this student's payments."),
    month: Month | None = Query(None, description="Only payments for this month (`for_month`)."),
    q: str | None = Query(
        None, max_length=200, description="Case-insensitive search on student name and note."
    ),
    sort: PaymentSort = Query(PaymentSort.paid_on),
    order: SortOrder = Query(SortOrder.desc),
) -> list[PaymentRead]:
    """Every payment matching the filters, with the student's name."""
    return service.list_payments(
        session, student_id=student_id, month=month, q=q, sort=sort, order=order
    )


@router.post(
    "",
    response_model=PaymentRead,
    status_code=status.HTTP_201_CREATED,
    responses={404: {"model": ErrorResponse, "description": "No student with this id"}},
    operation_id="createPayment",
)
def create_payment(body: PaymentCreate, session: SessionDep, today: TodayDep) -> PaymentRead:
    return service.create_payment(session, body, today)


@router.get(
    "/{payment_id}",
    response_model=PaymentRead,
    responses=NOT_FOUND,
    operation_id="getPayment",
)
def get_payment(payment_id: int, session: SessionDep) -> PaymentRead:
    return service.get_payment(session, payment_id)


@router.patch(
    "/{payment_id}",
    response_model=PaymentRead,
    responses=NOT_FOUND,
    operation_id="updatePayment",
)
def update_payment(
    payment_id: int, body: PaymentUpdate, session: SessionDep, today: TodayDep
) -> PaymentRead:
    """Partial update. Only fields that are sent change."""
    return service.update_payment(session, payment_id, body, today)


@router.delete(
    "/{payment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses=NOT_FOUND,
    operation_id="deletePayment",
)
def delete_payment(payment_id: int, session: SessionDep) -> None:
    service.delete_payment(session, payment_id)
