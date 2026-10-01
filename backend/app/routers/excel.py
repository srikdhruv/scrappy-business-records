"""Excel downloads and uploads. The work is in `app/services/exports.py` (downloads) and
`app/services/imports.py` (uploads: preview, then add)."""

from urllib.parse import quote

from fastapi import APIRouter, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response

from app.clock import CurrentMonthDep, TodayDep
from app.db import SessionDep
from app.errors import unprocessable
from app.models import PaymentMethod
from app.routers import students as students_router
from app.schemas import (
    ExportTemplateKind,
    ImportCommit,
    ImportPreview,
    ImportResult,
    Month,
    PaymentSort,
    SortOrder,
    StudentListFilter,
)
from app.services import exports, imports
from app.services.spreadsheet import MAX_FILE_BYTES

router = APIRouter(tags=["excel"])

_XLSX_RESPONSE = {
    200: {
        "content": {exports.XLSX: {"schema": {"type": "string", "format": "binary"}}},
        "description": "An Excel workbook (.xlsx), as a download.",
    }
}


def _xlsx(data: bytes, filename: str) -> Response:
    return Response(
        content=data,
        media_type=exports.XLSX,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"; '
            f"filename*=UTF-8''{quote(filename)}",
            "Cache-Control": "no-store",
        },
    )


@router.get(
    "/export/students.xlsx",
    response_class=Response,
    responses=_XLSX_RESPONSE,
    operation_id="exportStudents",
)
def export_students(
    session: SessionDep,
    current: CurrentMonthDep,
    today: TodayDep,
    status_filter: StudentListFilter = Query(StudentListFilter.active, alias="status"),
    q: str | None = Query(None, max_length=200, description="The Students page's search."),
    batch: str | None = Query(
        None, max_length=30, description="The batch tab: a batch's id, or `none` for no batch."
    ),
) -> Response:
    """The students on the Students page for this batch tab, Show choice and search, as an
    Excel file."""
    rows = exports.students_shown(
        session, status_filter, q, current, batch=students_router.batch_filter(batch)
    )
    return _xlsx(exports.students_workbook(rows), exports.filename("students", today))


@router.get(
    "/export/payments.xlsx",
    response_class=Response,
    responses=_XLSX_RESPONSE,
    operation_id="exportPayments",
)
def export_payments(
    session: SessionDep,
    today: TodayDep,
    current: CurrentMonthDep,
    student_id: int | None = Query(None, gt=0),
    month: Month | None = Query(None),
    q: str | None = Query(None, max_length=200),
    method: PaymentMethod | None = Query(None),
    sort: PaymentSort = Query(PaymentSort.paid_on),
    order: SortOrder = Query(SortOrder.desc),
) -> Response:
    """The payments on the Payments page for these filters, in its order, as an Excel file."""
    rows = exports.payments_shown(
        session,
        current,
        student_id=student_id,
        month=month,
        q=q,
        method=method,
        sort=sort,
        order=order,
    )
    return _xlsx(exports.payments_workbook(session, rows), exports.filename("payments", today))


@router.get(
    "/export/everything.xlsx",
    response_class=Response,
    responses=_XLSX_RESPONSE,
    operation_id="exportEverything",
)
def export_everything(
    session: SessionDep,
    current: CurrentMonthDep,
    today: TodayDep,
) -> Response:
    """Every record in one workbook: Students, Fee history, Payments and Unassigned payments.
    Uploading it into an empty app restores everything."""
    return _xlsx(
        exports.everything_workbook(session, current), exports.filename("everything", today)
    )


@router.get(
    "/import/template.xlsx",
    response_class=Response,
    responses=_XLSX_RESPONSE,
    operation_id="importTemplate",
)
def import_template(kind: ExportTemplateKind = Query(...)) -> Response:
    """A blank sheet to fill in and upload."""
    return _xlsx(exports.template_workbook(kind), f"scrappy-records-{kind.value}-template.xlsx")


async def _read_body(request: Request) -> bytes:
    """The uploaded file, refusing anything over 5 MB without reading it all."""
    too_big = unprocessable("This file is bigger than 5 MB. Upload a smaller one.")
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_FILE_BYTES:
        raise too_big
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_FILE_BYTES:
            raise too_big
        chunks.append(chunk)
    return b"".join(chunks)


@router.post(
    "/import/preview",
    response_model=ImportPreview,
    operation_id="previewImport",
    openapi_extra={
        "requestBody": {
            "required": True,
            "description": "The .xlsx file itself, as the request body (at most 5 MB).",
            "content": {exports.XLSX: {"schema": {"type": "string", "format": "binary"}}},
        }
    },
)
async def preview_import(
    request: Request,
    session: SessionDep,
    today: TodayDep,
    current: CurrentMonthDep,
    filename: str | None = Query(None, max_length=255, description="The file's name."),
) -> ImportPreview:
    """What adding this file's students and payments would do, row by row. Nothing is saved.
    A file that can't be read is a 422 with a plain message."""
    data = await _read_body(request)
    return await run_in_threadpool(imports.preview, session, data, filename, today, current)


@router.post("/import/commit", response_model=ImportResult, operation_id="commitImport")
def commit_import(
    body: ImportCommit, session: SessionDep, today: TodayDep, current: CurrentMonthDep
) -> ImportResult:
    """Add the rows from a preview, with the owner's choices, after checking all of them again
    against the records as they are now. A `pre-import` backup is taken first, and it all
    happens in one transaction: on any error nothing is added."""
    return imports.commit_or_rollback(session, body, today, current)
