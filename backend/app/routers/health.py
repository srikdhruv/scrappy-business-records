from fastapi import APIRouter

from app import __version__
from app.config import APP_ID
from app.schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse, operation_id="getHealth")
def get_health() -> HealthResponse:
    """Liveness check. The launcher uses `app == "scrappy-records"` to recognise a running copy
    of this app on the port."""
    return HealthResponse(app=APP_ID, version=__version__, status="ok")
