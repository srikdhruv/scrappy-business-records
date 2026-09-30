"""In-app feedback: saved on the laptop first, then sent by `app.feedback_sender`.

Saving never needs the internet. What is sent (`relay_payload`) is the owner's message, the
picture of the screen she chose to include, and facts about the app (`app.diagnostics`), never
the database, its backups or exports. See docs/data-model.md, "Feedback".
"""

from __future__ import annotations

import contextlib
import datetime as dt
import json
import logging
import os
import uuid
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import __version__, build_id, config, diagnostics
from app.models import Feedback, FeedbackStatus
from app.schemas import FeedbackCreate, decode_screenshot, screenshot_type

log = logging.getLogger("scrappy")

RELAY_SCHEMA = 1
_EXTENSIONS = {"image/jpeg": "jpg", "image/png": "png"}


def _save_screenshot(feedback_id: str, data: bytes) -> str | None:
    """Write the picture to `<data>/feedback/<id>.jpg` (or .png). Returns the file name, or None
    if it couldn't be written: the feedback is still saved, without the picture."""
    content_type = screenshot_type(data)
    if content_type is None:
        return None
    name = f"{feedback_id}.{_EXTENSIONS[content_type]}"
    folder = config.feedback_dir()
    try:
        folder.mkdir(parents=True, exist_ok=True)
        tmp = folder / f"{name}.{os.getpid()}.tmp"
        tmp.write_bytes(data)
        os.replace(tmp, folder / name)
    except OSError:
        log.warning("Couldn't save the picture for feedback %s", feedback_id[:8])
        return None
    return name


def _db_revision(session: Session) -> str | None:
    return session.execute(text("SELECT version_num FROM alembic_version")).scalar()


def _diagnostics(session: Session, body: FeedbackCreate) -> dict[str, Any]:
    return {
        "install_id": diagnostics.install_id(),
        "server": diagnostics.server_environment(_db_revision(session)),
        "client": body.client.model_dump(),
        "log_tail": diagnostics.log_tail(),
    }


def create_feedback(session: Session, body: FeedbackCreate) -> Feedback:
    """Save it (with its picture and diagnostics). Idempotent on `body.id`: the same id again
    returns the row already saved, unchanged."""
    feedback_id = str(body.id or uuid.uuid4())
    existing = session.get(Feedback, feedback_id)
    if existing is not None:
        return existing
    screenshot_file = None
    if body.screenshot:
        screenshot_file = _save_screenshot(feedback_id, decode_screenshot(body.screenshot))
    row = Feedback(
        id=feedback_id,
        category=body.category,
        message=body.message,
        route=body.route or None,
        diagnostics=json.dumps(_diagnostics(session, body), ensure_ascii=False),
        screenshot_file=screenshot_file,
    )
    session.add(row)
    try:
        session.commit()
    except IntegrityError:
        # The same id saved by a second request at this very moment (a double click).
        session.rollback()
        existing = session.get(Feedback, feedback_id)
        if existing is None:
            raise
        return existing
    log.info("Feedback %s saved (%s)", feedback_id[:8], body.category.value)
    return row


def get_feedback(session: Session, feedback_id: str) -> Feedback | None:
    return session.get(Feedback, feedback_id)


def waiting_count(session: Session) -> int:
    return (
        session.scalar(
            select(func.count())
            .select_from(Feedback)
            .where(Feedback.status == FeedbackStatus.pending)
        )
        or 0
    )


def pending_ids(session: Session) -> list[str]:
    """Feedback still to send: the least-tried first, then the oldest, so one item that keeps
    failing doesn't hold the others back."""
    return list(
        session.scalars(
            select(Feedback.id)
            .where(Feedback.status == FeedbackStatus.pending)
            .order_by(Feedback.attempts, Feedback.created_at, Feedback.id)
        )
    )


def _utc(value: dt.datetime) -> str:
    value = value.replace(tzinfo=dt.UTC) if value.tzinfo is None else value.astimezone(dt.UTC)
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def _read_screenshot(row: Feedback) -> dict[str, str] | None:
    if not row.screenshot_file:
        return None
    try:
        data = (config.feedback_dir() / row.screenshot_file).read_bytes()
    except OSError:
        return None  # gone (it's only kept until sent); send the rest
    content_type = screenshot_type(data)
    if content_type is None:
        return None
    import base64

    return {"content_type": content_type, "data_base64": base64.b64encode(data).decode("ascii")}


def relay_payload(row: Feedback) -> dict[str, Any]:
    """The JSON the relay takes (docs/data-model.md, "Feedback", and relay/README.md)."""
    try:
        diag = json.loads(row.diagnostics or "{}")
    except ValueError:
        diag = {}
    if not isinstance(diag, dict):
        diag = {}
    server = diag.get("server") or {}
    client = diag.get("client") or {}
    environment = {
        "os": server.get("os", ""),
        "machine": server.get("machine", ""),
        "python": server.get("python", ""),
        "db_revision": server.get("db_revision", ""),
        "server_timezone": server.get("server_timezone", ""),
        "browser": client.get("user_agent", ""),
        "screen": client.get("screen", ""),
        "window": client.get("window", ""),
        "timezone": client.get("timezone", ""),
        "language": client.get("language", ""),
        "ui_build": client.get("ui_build", ""),
    }
    return {
        "schema": RELAY_SCHEMA,
        "id": row.id,
        "install_id": diag.get("install_id") or diagnostics.install_id(),
        "category": row.category.value,
        "message": row.message,
        "created_at": _utc(row.created_at),
        "local_time": client.get("local_time") or server.get("server_time", ""),
        # The version and build that saved it (it may be sent by a later one).
        "app_version": server.get("app_version") or __version__,
        "build_id": server.get("build_id") or build_id(),
        "route": row.route or "",
        "environment": {k: str(v)[:500] for k, v in environment.items() if v},
        "errors": list(client.get("errors") or [])[-20:],
        "log_tail": diag.get("log_tail", ""),
        "screenshot": _read_screenshot(row),
    }


def mark_sent(session: Session, feedback_id: str, issue_url: str) -> None:
    row = session.get(Feedback, feedback_id)
    if row is None:
        return
    row.status = FeedbackStatus.sent
    row.attempts += 1
    row.sent_at = dt.datetime.now(dt.UTC).replace(tzinfo=None)
    row.remote_ref = issue_url
    row.last_error = None
    session.commit()
    # The inbox has the picture now; don't keep a copy of the screen on the laptop.
    if row.screenshot_file:
        with contextlib.suppress(OSError):
            (config.feedback_dir() / row.screenshot_file).unlink(missing_ok=True)


def mark_not_sent(session: Session, feedback_id: str, error: str, *, permanent: bool) -> None:
    row = session.get(Feedback, feedback_id)
    if row is None:
        return
    row.attempts += 1
    row.last_error = error[:1000]
    if permanent:
        row.status = FeedbackStatus.failed
    session.commit()
