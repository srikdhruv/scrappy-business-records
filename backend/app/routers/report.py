"""The monthly report: every student for one month, on screen and as an Excel file."""

from urllib.parse import quote

from fastapi import APIRouter, Query
from fastapi.responses import Response

from app.clock import CurrentMonthDep, TodayDep
from app.db import SessionDep
from app.models import Batch
from app.months import parse_month
from app.routers.students import batch_filter
from app.schemas import Month, ReportFilter, ReportGroup, ReportResponse, ReportSort, SortOrder
from app.services import report as service
from app.services import report_xlsx
from app.services.bounds import valid_id

router = APIRouter(tags=["report"])

_MONTH = Query(None, description="Defaults to the current month.")


@router.get("/report", response_model=ReportResponse, operation_id="getReport")
def get_report(
    session: SessionDep,
    current: CurrentMonthDep,
    today: TodayDep,
    month: Month | None = _MONTH,
) -> ReportResponse:
    """Every student for one month: fee, paid, credit, extra, short, status and what's owed."""
    return service.get_report(session, parse_month(month) if month else current, current, today)


@router.get(
    "/report.xlsx",
    response_class=Response,
    operation_id="downloadReport",
    responses={
        200: {
            "content": {report_xlsx.XLSX: {"schema": {"type": "string", "format": "binary"}}},
            "description": "The report as an Excel workbook (.xlsx), as a download.",
        }
    },
)
def download_report(
    session: SessionDep,
    current: CurrentMonthDep,
    today: TodayDep,
    month: Month | None = _MONTH,
    status: ReportFilter = Query(ReportFilter.all, description="The page's status filter."),
    q: str | None = Query(None, max_length=200, description="The page's search."),
    sort: ReportSort | None = Query(None, description="The column the page is sorted by."),
    order: SortOrder = Query(SortOrder.asc),
    batch: str | None = Query(
        None, max_length=30, description="The page's batch filter: an id, or `none`."
    ),
    group: ReportGroup = Query(ReportGroup.none, description="Grouped by batch, or not."),
) -> Response:
    """The report as the page shows it (filters, search, sort and grouping), as an Excel file
    named like `scrappy-records-report-2026-10.xlsx`."""
    report = service.get_report(session, parse_month(month) if month else current, current, today)
    chosen = batch_filter(batch)
    rows = service.shown(report, status, q, sort, order, batch=chosen, group=group)
    batch_words = None
    if chosen == "none":
        batch_words = "in no batch"
    elif chosen is not None:
        found = session.get(Batch, chosen) if valid_id(chosen) else None
        batch_words = f"in {found.name}" if found else "in a batch that no longer exists"
    name = report_xlsx.filename(report.month)
    return Response(
        content=report_xlsx.workbook(
            rows, status, q, sort, order, group=group, batch_words=batch_words
        ),
        media_type=report_xlsx.XLSX,
        headers={
            "Content-Disposition": f'attachment; filename="{name}"; '
            f"filename*=UTF-8''{quote(name)}",
            "Cache-Control": "no-store",
        },
    )
