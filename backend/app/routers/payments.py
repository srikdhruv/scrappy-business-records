"""Payments: list, create, detail, update, delete.

Contract only — the bodies are filled in by the backend PR.
"""

from fastapi import APIRouter, HTTPException, Query, status

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
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "Not implemented")


@router.post(
    "",
    response_model=PaymentRead,
    status_code=status.HTTP_201_CREATED,
    responses={404: {"model": ErrorResponse, "description": "No student with this id"}},
    operation_id="createPayment",
)
def create_payment(body: PaymentCreate, session: SessionDep) -> PaymentRead:
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "Not implemented")


@router.get(
    "/{payment_id}",
    response_model=PaymentRead,
    responses=NOT_FOUND,
    operation_id="getPayment",
)
def get_payment(payment_id: int, session: SessionDep) -> PaymentRead:
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "Not implemented")


@router.patch(
    "/{payment_id}",
    response_model=PaymentRead,
    responses=NOT_FOUND,
    operation_id="updatePayment",
)
def update_payment(payment_id: int, body: PaymentUpdate, session: SessionDep) -> PaymentRead:
    """Partial update. Only fields that are sent change."""
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "Not implemented")


@router.delete(
    "/{payment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses=NOT_FOUND,
    operation_id="deletePayment",
)
def delete_payment(payment_id: int, session: SessionDep) -> None:
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "Not implemented")
