from fastapi import APIRouter, Query, Request

from app import __version__
from app.config import APP_ID
from app.schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse, operation_id="getHealth")
def get_health(
    request: Request,
    waiting_for_update: bool = Query(
        False,
        description="Sent by a page waiting for an update to finish. The launcher then knows "
        "that page will reload itself, and doesn't open another browser tab (ADR 0006). "
        "Older versions' pages send it to newer servers: keep accepting it.",
    ),
) -> HealthResponse:
    """Liveness check. The launcher uses `app == "scrappy-records"` to recognise a running copy
    of this app on the port; a page that is updating polls it until `version` changes."""
    if waiting_for_update:
        updater = getattr(request.app.state, "updater", None)
        if updater is not None:
            updater.note_page_waiting()
    return HealthResponse(app=APP_ID, version=__version__, status="ok")
