"""Students: list, create, detail, update, delete, and payment suggestion.

Routers stay thin: the work is in `app/services/students.py`, and the rules (dues, statuses,
balances) in `app/services/ledger.py`.
"""

from fastapi import APIRouter, Query, status

from app.clock import CurrentMonthDep
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
from app.services import students as service

router = APIRouter(prefix="/students", tags=["students"])

NOT_FOUND = {404: {"model": ErrorResponse, "description": "No student with this id"}}


@router.get("", response_model=list[StudentRead], operation_id="listStudents")
def list_students(
    session: SessionDep,
    current: CurrentMonthDep,
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
    return service.list_students(session, status_filter, q, current)


@router.post(
    "",
    response_model=StudentDetail,
    status_code=status.HTTP_201_CREATED,
    operation_id="createStudent",
)
def create_student(
    body: StudentCreate, session: SessionDep, current: CurrentMonthDep
) -> StudentDetail:
    """Create a student. Also records their first fee change at `joined_month`."""
    return service.create_student(session, body, current)


@router.get(
    "/{student_id}",
    response_model=StudentDetail,
    responses=NOT_FOUND,
    operation_id="getStudent",
)
def get_student(student_id: int, session: SessionDep, current: CurrentMonthDep) -> StudentDetail:
    """A student with their fee history and month-by-month ledger."""
    return service.get_student(session, student_id, current)


@router.patch(
    "/{student_id}",
    response_model=StudentDetail,
    responses=NOT_FOUND,
    operation_id="updateStudent",
)
def update_student(
    student_id: int, body: StudentUpdate, session: SessionDep, current: CurrentMonthDep
) -> StudentDetail:
    """Partial update. A new fee (`monthly_fee_paise`) is recorded as a fee change from
    `fee_effective_month` (default: the current month)."""
    return service.update_student(session, student_id, body, current)


@router.delete(
    "/{student_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses=NOT_FOUND,
    operation_id="deleteStudent",
)
def delete_student(student_id: int, session: SessionDep) -> None:
    """Hard delete. Their fee changes and payments are deleted too."""
    service.delete_student(session, student_id)


@router.get(
    "/{student_id}/suggest-payment",
    response_model=SuggestedPayment,
    responses=NOT_FOUND,
    operation_id="suggestPayment",
)
def suggest_payment(
    student_id: int, session: SessionDep, current: CurrentMonthDep
) -> SuggestedPayment:
    """The oldest unpaid or partial month and what's left on it; otherwise the current month
    and its fee."""
    return service.suggest_payment(session, student_id, current)
