"""In-app feedback: saved on the laptop first, then sent by `app.feedback_sender`.

Saving never needs the internet. What is sent (`relay_payload`) is the owner's message, the
picture of the screen she chose to include, and facts about the app (`app.diagnostics`), never
the database, its backups or exports. See docs/data-model.md, "Feedback".
"""

from __future__ import annotations

import base64
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
PAYLOAD_MAX_BYTES = 2_000_000
"""What the app sends at most: under the relay's 2 MiB (2,097,152 bytes) limit."""
SLIM_LOG_LINES = 50
"""The log lines a second, slimmer try keeps (after the relay said "too large")."""
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
    return {"content_type": content_type, "data_base64": base64.b64encode(data).decode("ascii")}


def _json_size(payload: dict[str, Any]) -> int:
    return len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def _fit(payload: dict[str, Any], max_bytes: int) -> dict[str, Any]:
    """Make the payload fit `max_bytes`: drop the oldest log lines first (halving until it fits
    or nothing is left), then the recent errors, then the picture. The message always goes."""
    lines = payload["log_tail"].split("\n") if payload["log_tail"] else []
    while _json_size(payload) > max_bytes and lines:
        lines = lines[len(lines) // 2 + 1 :] if len(lines) > 1 else []
        payload["log_tail"] = "\n".join(lines)
    if _json_size(payload) > max_bytes:
        payload["errors"] = []
    if _json_size(payload) > max_bytes:
        payload["screenshot"] = None
    return payload


def relay_payload(
    row: Feedback, *, max_bytes: int = PAYLOAD_MAX_BYTES, slim: bool = False
) -> dict[str, Any]:
    """The JSON the relay takes (docs/data-model.md, "Feedback"), at most `max_bytes` (below the
    relay's 2 MiB limit). `slim`: no picture and only the last lines of the log, for a second try
    after the relay said it was too large."""
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
    log_tail = str(diag.get("log_tail", ""))
    if slim:
        log_tail = "\n".join(log_tail.split("\n")[-SLIM_LOG_LINES:])
    payload = {
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
        # The page only: a query (a search) could hold a name. Older rows may have one.
        "route": (row.route or "").split("?")[0].split("#")[0],
        "environment": {k: str(v)[:500] for k, v in environment.items() if v},
        "errors": list(client.get("errors") or [])[-20:],
        "log_tail": log_tail,
        "screenshot": None if slim else _read_screenshot(row),
    }
    return _fit(payload, max_bytes)


def _forget_picture(row: Feedback) -> None:
    """Delete the picture of the screen: once sent (the inbox has it) or refused for good."""
    if row.screenshot_file:
        with contextlib.suppress(OSError):
            (config.feedback_dir() / row.screenshot_file).unlink(missing_ok=True)


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
    _forget_picture(row)


def mark_not_sent(session: Session, feedback_id: str, error: str, *, final: bool) -> None:
    """A try that didn't work. `final`: the relay will never take it, so it's `failed`, never
    retried, and its picture is deleted."""
    row = session.get(Feedback, feedback_id)
    if row is None:
        return
    row.attempts += 1
    row.last_error = error[:1000]
    if final:
        row.status = FeedbackStatus.failed
    session.commit()
    if final:
        _forget_picture(row)
