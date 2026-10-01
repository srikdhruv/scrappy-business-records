"""Settings → About: version, build and where the data lives."""

from fastapi import APIRouter

from app import __version__, backup, build_id, config, logs
from app.db import SessionDep
from app.feedback_sender import usable_url
from app.schemas import AboutResponse
from app.services import feedback

router = APIRouter(tags=["about"])


@router.get("/about", response_model=AboutResponse, operation_id="getAbout")
def get_about(session: SessionDep) -> AboutResponse:
    backups = config.backup_dir()
    if not backups.is_dir() and backup.fallback_dir().is_dir():
        backups = backup.fallback_dir()  # Documents couldn't be written (see app/backup.py)
    return AboutResponse(
        version=__version__,
        build_id=build_id(),
        data_dir=str(config.data_dir()),
        backup_dir=str(backups),
        log_dir=str(logs.log_file().parent),
        feedback_sending=usable_url(config.feedback_url()),
        feedback_waiting=feedback.waiting_count(session),
    )
