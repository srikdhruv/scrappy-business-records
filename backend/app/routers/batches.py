"""Batches: list, create, edit, delete, each batch's fees for a month, and turning the old
"class or batch" labels into batches. The work is in `app/services/batches.py`."""

from fastapi import APIRouter, Query, status

from app.clock import CurrentMonthDep
from app.db import SessionDep
from app.months import parse_month
from app.schemas import (
    MAX_AMOUNT_PAISE,
    BatchCreate,
    BatchOverview,
    BatchRead,
    BatchUpdate,
    ErrorResponse,
    FeePlan,
    LabelConversion,
    LabelPreview,
    Month,
    MoveResult,
    MoveStudents,
)
from app.services import batches as service

router = APIRouter(prefix="/batches", tags=["batches"])

NOT_FOUND = {404: {"model": ErrorResponse, "description": "No batch with this id"}}


@router.get("", response_model=list[BatchRead], operation_id="listBatches")
def list_batches(session: SessionDep, current: CurrentMonthDep) -> list[BatchRead]:
    """Every batch, sorted by name, with how many students are in it."""
    return service.list_batches(session, current)


@router.post(
    "",
    response_model=BatchRead,
    status_code=status.HTTP_201_CREATED,
    operation_id="createBatch",
)
def create_batch(body: BatchCreate, session: SessionDep, current: CurrentMonthDep) -> BatchRead:
    """Create a batch. Its name must be new (ignoring capitals and spaces)."""
    return service.create_batch(session, body, current)


# Before /{batch_id}, so these words aren't read as an id.
@router.get("/summary", response_model=BatchOverview, operation_id="getBatchOverview")
def get_overview(
    session: SessionDep,
    current: CurrentMonthDep,
    month: Month | None = Query(None, description="Defaults to the current month."),
) -> BatchOverview:
    """Each batch's fees for a month (and the students in no batch): expected, collected,
    still due, % paid. They add up to the dashboard's summary."""
    return service.overview(session, parse_month(month) if month else current, current)


@router.get("/from-labels", response_model=LabelPreview, operation_id="previewLabelConversion")
def preview_labels(session: SessionDep, current: CurrentMonthDep) -> LabelPreview:
    """What "Create batches from existing labels" would do. Changes nothing."""
    return service.label_preview(session, current)


@router.post("/move", response_model=MoveResult, operation_id="moveStudents")
def move_students(body: MoveStudents, session: SessionDep) -> MoveResult:
    """Put these students in a batch (or none), all at once. Their fees don't change."""
    return MoveResult(moved=service.move_students(session, body.student_ids, body.batch_id))


@router.post("/from-labels", response_model=LabelConversion, operation_id="convertLabels")
def convert_labels(session: SessionDep) -> LabelConversion:
    """Create batches from the students' labels and place them in those batches, in one go,
    after a backup. Labels are kept as they are. Running it again does nothing."""
    return service.convert_labels(session)


@router.get("/{batch_id}", response_model=BatchRead, responses=NOT_FOUND, operation_id="getBatch")
def get_batch(batch_id: int, session: SessionDep, current: CurrentMonthDep) -> BatchRead:
    return service.get_batch(session, batch_id, current)


@router.get(
    "/{batch_id}/fee-plan",
    response_model=FeePlan,
    responses=NOT_FOUND,
    operation_id="getFeePlan",
)
def get_fee_plan(
    batch_id: int,
    session: SessionDep,
    current: CurrentMonthDep,
    fee_paise: int = Query(ge=0, le=MAX_AMOUNT_PAISE, description="The new usual fee."),
    from_month: Month = Query(description="The first month of the new fee."),
) -> FeePlan:
    """What "Also charge the new usual fee" would do to each student of the batch, and who is
    ticked at first. Changes nothing; `PATCH` with `apply_fee` uses the same rule."""
    return service.fee_plan(session, batch_id, fee_paise, parse_month(from_month), current)


@router.patch(
    "/{batch_id}", response_model=BatchRead, responses=NOT_FOUND, operation_id="updateBatch"
)
def update_batch(
    batch_id: int, body: BatchUpdate, session: SessionDep, current: CurrentMonthDep
) -> BatchRead:
    """Partial update. A new default fee changes no student's fee, unless `apply_fee` names the
    students to charge it to, and from which month."""
    return service.update_batch(session, batch_id, body, current)


@router.delete(
    "/{batch_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses=NOT_FOUND,
    operation_id="deleteBatch",
)
def delete_batch(batch_id: int, session: SessionDep) -> None:
    """Delete a batch. Its students aren't deleted: they are then in no batch."""
    service.delete_batch(session, batch_id)
