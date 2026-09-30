"""What feedback carries besides the owner's message: facts about this copy of the app.

Everything here is about the app and the laptop, never the owner's records. Nothing reads the
database's students, fees or payments, and the database file, its backups and exports are never
attached (`tests/test_feedback.py` checks that no stored record shows up in what is sent).

- `install_id()`: a random ID for this copy of the app, made once and kept in the data folder,
  so feedback from the same laptop can be grouped. It says nothing about who uses it.
- `log_tail()`: the last lines of `server.log`, with the laptop's home folder shortened to `~`
  and any values a database error might print (`[parameters: ...]`) hidden.
- `server_environment()`: app version, build ID, operating system, Python, database revision.
"""

from __future__ import annotations

import datetime as dt
import logging
import os
import platform
import uuid
from pathlib import Path

from app import __version__, build_id, config, logs

log = logging.getLogger("scrappy")

LOG_TAIL_LINES = 200
LOG_TAIL_MAX_CHARS = 64 * 1024
LOG_LINE_MAX_CHARS = 500
_READ_BYTES = 256 * 1024  # enough for 200 long lines, without reading a whole 1 MB log


# --------------------------------------------------------------------------- install ID


def install_id() -> str:
    """This copy's random ID (a UUID), made the first time it's needed. Never raises: if the
    data folder can't be written, a fresh ID is returned (and logged) without being kept."""
    path = config.install_id_file()
    try:
        existing = path.read_text(encoding="ascii").strip()
        return str(uuid.UUID(existing))
    except (OSError, ValueError, UnicodeDecodeError):
        pass
    new = str(uuid.uuid4())
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        tmp.write_text(new + "\n", encoding="ascii")
        os.replace(tmp, path)
    except OSError:
        log.warning("Couldn't save the install ID in %s", redact(str(path.parent)))
    return new


# --------------------------------------------------------------------------- log tail


def _home_variants() -> list[str]:
    home = str(Path.home())
    variants = {home, home.replace("\\", "/")}
    # Windows paths also appear with the drive letter in the other case.
    variants |= {v[0].swapcase() + v[1:] for v in list(variants) if len(v) > 1 and v[1] == ":"}
    return sorted((v for v in variants if len(v) > 1), key=len, reverse=True)


def redact(text: str) -> str:
    """Shorten the home folder (which holds the laptop user's name) to `~`, and hide the values
    SQLAlchemy prints after a database error (`[parameters: ('Ananya Rao', ...)]`)."""
    for home in _home_variants():
        text = text.replace(home, "~")
    lines = []
    for line in text.split("\n"):
        if "[parameters:" in line:
            line = line[: line.index("[parameters:")] + "[parameters: hidden]"
        lines.append(line)
    return "\n".join(lines)


def _last_lines(path: Path, count: int) -> list[str]:
    try:
        with path.open("rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - _READ_BYTES))
            data = f.read()
    except OSError:
        return []
    lines = data.decode("utf-8", errors="replace").splitlines()
    if size > _READ_BYTES and lines:
        lines = lines[1:]  # the first line is probably cut in half
    return lines[-count:] if count > 0 else []


def log_tail(count: int = LOG_TAIL_LINES) -> str:
    """The last `count` lines of `server.log` (reaching into `server.log.1` when the current file
    has just rotated), redacted, each at most 500 characters, 64 KB at most in all."""
    current = logs.log_file()
    lines = _last_lines(current, count)
    if len(lines) < count:
        older = current.with_name(current.name + ".1")
        lines = _last_lines(older, count - len(lines)) + lines
    trimmed = [
        line if len(line) <= LOG_LINE_MAX_CHARS else line[:LOG_LINE_MAX_CHARS] + "…"
        for line in (redact(line) for line in lines)
    ]
    text = "\n".join(trimmed)
    if len(text) > LOG_TAIL_MAX_CHARS:
        text = text[-LOG_TAIL_MAX_CHARS:]
        text = text[text.find("\n") + 1 :] if "\n" in text else text
    return text


# --------------------------------------------------------------------------- environment


def server_environment(db_revision: str | None = None) -> dict[str, str]:
    """Facts about the app and the laptop (no paths, no names, no records)."""
    now = dt.datetime.now().astimezone()
    return {
        "app_version": __version__,
        "build_id": build_id(),
        "os": platform.platform(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "db_revision": db_revision or "none",
        "server_time": now.isoformat(timespec="seconds"),
        "server_timezone": now.tzname() or "",
    }
