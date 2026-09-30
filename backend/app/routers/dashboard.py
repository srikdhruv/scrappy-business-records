"""Dashboard for a selected month. See the PRD's "Dashboard for a selected month M".

Contract only — the body is filled in by the backend PR.
"""

from fastapi import APIRouter, HTTPException, Query, status

from app.db import SessionDep
from app.schemas import DashboardResponse, Month

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("", response_model=DashboardResponse, operation_id="getDashboard")
def get_dashboard(
    session: SessionDep,
    month: Month | None = Query(None, description="Defaults to the current month."),
) -> DashboardResponse:
    """Summary, yet-to-pay, backlog and overpaid lists for one month."""
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, "Not implemented")
