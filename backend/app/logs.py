"""Log files, under `$SCRAPPY_HOME/logs/`.

- `server.log`: what the server and the launcher say. Rotates at about 1 MB, keeping 3 files
  (`server.log`, `server.log.1`, `server.log.2`). Only the server process rotates it; the launcher
  just appends a few lines, so two processes never fight over the rename on Windows.
- `server-console.log`: the server process's raw stdout/stderr (set up by the launcher). Normally
  near-empty; it catches crashes that happen before logging is set up.

Everything is plain text with no colours, and nothing here assumes a console exists: under
`pythonw.exe` there is no `sys.stdout` or `sys.stderr` at all.
"""

from __future__ import annotations

import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

from app import config

LOG_FILENAME = "server.log"
CONSOLE_LOG_FILENAME = "server-console.log"
MAX_BYTES = 1_000_000
BACKUP_COUNT = 2  # server.log + 2 old files = 3 files, about 3 MB at most

FORMAT = "%(asctime)s %(levelname)-7s [%(process)d] %(name)s: %(message)s"

# uvicorn's loggers. They get no handlers of their own and propagate to the root logger.
_UVICORN_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access")


def log_file() -> Path:
    return config.log_dir() / LOG_FILENAME


def console_log_file() -> Path:
    return config.log_dir() / CONSOLE_LOG_FILENAME


class _Tagged:
    """Marker so `setup()` can find and replace the handlers it added before."""

    scrappy = True


class _RotatingHandler(_Tagged, RotatingFileHandler):
    pass


class _AppendHandler(_Tagged, logging.FileHandler):
    pass


class _ConsoleHandler(_Tagged, logging.StreamHandler):
    pass


def ensure_std_streams() -> None:
    """Give Python somewhere to write if it started without a console (pythonw.exe).

    Libraries that print (or check `sys.stdout.isatty()`) would otherwise crash.
    """
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")  # noqa: SIM115
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")  # noqa: SIM115


def setup(*, rotate: bool, console: bool = False, level: int = logging.INFO) -> Path:
    """Send the root logger (and uvicorn's loggers) to `server.log`. Safe to call repeatedly.

    `rotate=True` is for the long-running server; the short-lived launcher passes False so it
    never tries to rename a file the server has open. `console=True` also echoes to stderr.
    Returns the log file path.
    """
    path = log_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    handler: logging.Handler
    if rotate:
        handler = _RotatingHandler(
            path, maxBytes=MAX_BYTES, backupCount=BACKUP_COUNT, encoding="utf-8"
        )
    else:
        handler = _AppendHandler(path, encoding="utf-8")
    handler.setFormatter(logging.Formatter(FORMAT))
    handlers = [handler]
    if console and sys.stderr is not None:
        stream = _ConsoleHandler(sys.stderr)
        stream.setFormatter(logging.Formatter(FORMAT))
        handlers.append(stream)

    root = logging.getLogger()
    for existing in list(root.handlers):
        if getattr(existing, "scrappy", False):
            root.removeHandler(existing)
            existing.close()
    for h in handlers:
        root.addHandler(h)
    root.setLevel(level)

    for name in _UVICORN_LOGGERS:
        lg = logging.getLogger(name)
        lg.handlers = []
        lg.propagate = True
    # One line per request would push useful errors out of the log quickly.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    # Alembic lists its plugins on every start; only its migration lines are worth keeping.
    logging.getLogger("alembic.runtime.plugins").setLevel(logging.WARNING)
    return path
