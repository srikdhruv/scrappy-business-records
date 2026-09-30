"""Students: list, create, detail, update, delete, and payment suggestion.

Contract only — the bodies are filled in by the backend PR. Keep routers thin: business rules
(dues, statuses, balances) belong in `app/services/ledger.py`.
"""

from fastapi import APIRouter, HTTPException, Query, status

from app.db import SessionDep
from app.schemas import (
    ErrorResponse,
    StudentCreate,
    StudentDetail,
    StudentListFilter,
    StudentRead,
    StudentUpdate,
    SuggestedPayment,
)

router = APIRouter(prefix="/students", tags=["students"])

NOT_FOUND = {404: {"model": ErrorResponse, "description": "No student with this id"}}


@router.get("", response_model=list[StudentRead], operation_id="listStudents")
def list_students(
    session: SessionDep,
    status_filter: StudentListFilter = Query(
        StudentListFilter.active,
        alias="status",
        description="`active` (default), `left` (archived) or `all`.",
    ),
    q: str | None = Query(
        None, max_length=200, description="Case-insensitive search on name, phone, guardian."
    ),
) -> list[StudentRead]:
    """Students sorted by name, each with their current fee and balance."""
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "Not implemented")


@router.post(
    "",
    response_model=StudentDetail,
    status_code=status.HTTP_201_CREATED,
    operation_id="createStudent",
)
def create_student(body: StudentCreate, session: SessionDep) -> StudentDetail:
    """Create a student. Also records their first fee change at `joined_month`."""
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "Not implemented")


@router.get(
    "/{student_id}",
    response_model=StudentDetail,
    responses=NOT_FOUND,
    operation_id="getStudent",
)
def get_student(student_id: int, session: SessionDep) -> StudentDetail:
    """A student with their fee history and month-by-month ledger."""
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "Not implemented")


@router.patch(
    "/{student_id}",
    response_model=StudentDetail,
    responses=NOT_FOUND,
    operation_id="updateStudent",
)
def update_student(student_id: int, body: StudentUpdate, session: SessionDep) -> StudentDetail:
    """Partial update. A new fee (`monthly_fee_paise`) is recorded as a fee change from
    `fee_effective_month` (default: the current month)."""
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "Not implemented")


@router.delete(
    "/{student_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses=NOT_FOUND,
    operation_id="deleteStudent",
)
def delete_student(student_id: int, session: SessionDep) -> None:
    """Hard delete. Their fee changes and payments are deleted too."""
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "Not implemented")


@router.get(
    "/{student_id}/suggest-payment",
    response_model=SuggestedPayment,
    responses=NOT_FOUND,
    operation_id="suggestPayment",
)
def suggest_payment(student_id: int, session: SessionDep) -> SuggestedPayment:
    """The oldest unpaid or partial month and what's left on it; otherwise the current month
    and its fee."""
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "Not implemented")
