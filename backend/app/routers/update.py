"""Updating from inside the app (ADR 0006): is there a new version, and "Update now".

The two POSTs change something outside the browser (an outbound check; installing a new
version), so they only accept requests from the app's own page (`same_app_only`):
- `Content-Type: application/json`, which a plain HTML form on another website can't send;
- the `X-Scrappy-Request: 1` header, which another website's script can't add without asking
  first (a CORS preflight this server never approves);
- `Host` must be this app (`127.0.0.1:<port>` or `localhost:<port>`), which also stops a
  website whose name points at 127.0.0.1 (DNS rebinding);
- `Origin` and `Sec-Fetch-Site`, when the browser sends them, must say it came from this app.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app import config
from app.schemas import ErrorResponse, UpdateInfo, UpdateStart
from app.updater import UpdateError, Updater

router = APIRouter(prefix="/update", tags=["update"])

REQUEST_HEADER = "X-Scrappy-Request"


def get_updater(request: Request) -> Updater:
    updater = getattr(request.app.state, "updater", None)
    if updater is None:  # an app built without its startup (some tests)
        updater = request.app.state.updater = Updater()
    return updater


def _app_hosts() -> set[str]:
    try:
        port = config.port()
    except ValueError:
        return set()
    return {f"127.0.0.1:{port}", f"localhost:{port}"}


def same_app_only(request: Request) -> None:
    """Refuse anything that isn't the app's own page (see the module docstring)."""
    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if content_type != "application/json":
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "This request must be sent as JSON."
        )
    if request.headers.get(REQUEST_HEADER) != "1":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the app itself can do this.")
    hosts = _app_hosts()
    if request.headers.get("host", "").lower() not in hosts:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the app itself can do this.")
    origin = request.headers.get("origin")
    if origin is not None and origin.lower() not in {f"http://{h}" for h in hosts}:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the app itself can do this.")
    fetch_site = request.headers.get("sec-fetch-site")
    if fetch_site is not None and fetch_site.lower() not in ("same-origin", "none"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the app itself can do this.")


_GUARDED = {
    403: {"model": ErrorResponse, "description": "Not sent by the app's own page."},
    415: {"model": ErrorResponse, "description": "Not sent as JSON."},
}


@router.get("", response_model=UpdateInfo, operation_id="getUpdate")
def get_update(updater: Updater = Depends(get_updater)) -> UpdateInfo:
    """What the last check found (it never waits for the internet)."""
    return updater.info()


@router.post(
    "/check",
    response_model=UpdateInfo,
    operation_id="checkForUpdate",
    dependencies=[Depends(same_app_only)],
    responses=_GUARDED,
)
def check_for_update(updater: Updater = Depends(get_updater)) -> UpdateInfo:
    """About → Check for updates: ask GitHub now (up to 15 s), then answer like GET."""
    updater.checker.check_now()
    return updater.info()


@router.post(
    "/start",
    response_model=UpdateInfo,
    status_code=status.HTTP_202_ACCEPTED,
    operation_id="startUpdate",
    dependencies=[Depends(same_app_only)],
    responses={
        **_GUARDED,
        409: {
            "model": ErrorResponse,
            "description": "Can't update now (already updating, "
            "up to date, or `version` isn't the latest).",
        },
        502: {"model": ErrorResponse, "description": "The installer couldn't be downloaded."},
    },
)
def start_update(body: UpdateStart, updater: Updater = Depends(get_updater)) -> UpdateInfo:
    """Update now: download the new release's installer and start it, detached. It stops this
    server, backs up, installs `version` and opens the app again. The page then polls
    `/api/health?waiting_for_update=true` until the version changes."""
    try:
        return updater.start_update(body.version)
    except UpdateError as e:
        raise HTTPException(e.status, str(e)) from e
