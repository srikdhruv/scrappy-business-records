"""The monthly report: every student for one month, on screen and as an Excel file."""

from urllib.parse import quote

from fastapi import APIRouter, Query
from fastapi.responses import Response

from app.clock import CurrentMonthDep, TodayDep
from app.db import SessionDep
from app.months import parse_month
from app.schemas import Month, ReportResponse
from app.services import report as service
from app.services import report_xlsx

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
) -> Response:
    """The same report as an Excel file, named like `scrappy-records-report-2026-10.xlsx`."""
    report = service.get_report(session, parse_month(month) if month else current, current, today)
    name = report_xlsx.filename(report.month)
    return Response(
        content=report_xlsx.workbook(report),
        media_type=report_xlsx.XLSX,
        headers={
            "Content-Disposition": f'attachment; filename="{name}"; '
            f"filename*=UTF-8''{quote(name)}",
            "Cache-Control": "no-store",
        },
    )
