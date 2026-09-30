"""Dashboard for a selected month. See the PRD's "Dashboard for a selected month M"."""

from fastapi import APIRouter, Query

from app.clock import CurrentMonthDep
from app.db import SessionDep
from app.months import parse_month
from app.schemas import DashboardResponse, Month
from app.services import dashboard as service

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("", response_model=DashboardResponse, operation_id="getDashboard")
def get_dashboard(
    session: SessionDep,
    current: CurrentMonthDep,
    month: Month | None = Query(None, description="Defaults to the current month."),
) -> DashboardResponse:
    """Summary, yet-to-pay, backlog and overpaid lists for one month."""
    return service.get_dashboard(session, parse_month(month) if month else current, current)
