"""Unassigned payments: uploaded payments waiting to be given to a student. The work is in
`app/services/unassigned.py`."""

from fastapi import APIRouter, status

from app.clock import TodayDep
from app.db import SessionDep
from app.schemas import ErrorResponse, PaymentRead, UnassignedAssign, UnassignedPaymentRead
from app.services import unassigned as service

router = APIRouter(prefix="/unassigned-payments", tags=["unassigned payments"])

NOT_FOUND = {404: {"model": ErrorResponse, "description": "No unassigned payment with this id"}}


@router.get(
    "",
    response_model=list[UnassignedPaymentRead],
    operation_id="listUnassignedPayments",
)
def list_unassigned(session: SessionDep) -> list[UnassignedPaymentRead]:
    """Every payment waiting for a student, oldest paid first, each with likely students."""
    return service.list_unassigned(session)


@router.post(
    "/{unassigned_id}/assign",
    response_model=PaymentRead,
    status_code=status.HTTP_201_CREATED,
    responses=NOT_FOUND,
    operation_id="assignUnassignedPayment",
)
def assign(
    unassigned_id: int, body: UnassignedAssign, session: SessionDep, today: TodayDep
) -> PaymentRead:
    """Give it to a student: the payment is added for them and this one removed, together.
    422 if they already have the same payment (amount, paid-on date and month)."""
    return service.assign(session, unassigned_id, body.student_id, today)


@router.delete(
    "/{unassigned_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses=NOT_FOUND,
    operation_id="deleteUnassignedPayment",
)
def delete(unassigned_id: int, session: SessionDep) -> None:
    service.delete(session, unassigned_id)
