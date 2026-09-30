"""Log files, under `$SCRAPPY_HOME/logs/`.

- `server.log`: what the server (`python -m app`) and the launcher say. Rotates at about 1 MB,
  keeping 3 files (`server.log`, `server.log.1`, `server.log.2`). Only the server rotates it; the
  launcher just appends a few lines, so two processes never fight over a rename on Windows.
- `server-console.log`: the server's raw stdout/stderr, started fresh by the launcher each time
  it starts the server. It catches anything printed outside logging, such as a crash before
  logging was set up.

Plain text, no colours. Nothing here assumes a console: under `pythonw.exe` there may be no
`sys.stdout` or `sys.stderr` at all.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
from logging.handlers import RotatingFileHandler
from pathlib import Path

from app import config

LOG_FILENAME = "server.log"
CONSOLE_LOG_FILENAME = "server-console.log"
MAX_BYTES = 1_000_000
BACKUP_COUNT = 2  # server.log + 2 old files = 3 files, about 3 MB at most

FORMAT = "%(asctime)s %(levelname)-7s [%(process)d] %(name)s: %(message)s"


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
    handler.addFilter(_Quieter())
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
    return path


def setup_server_log() -> Path | None:
    """For `python -m app`: the rotating server.log, plus logging of uncaught exceptions.

    Never raises: if the log folder can't be written, the server still runs (without a file).
    """
    try:
        path = setup(rotate=True)
    except Exception:
        return None
    log_uncaught_exceptions()
    return path


def log_uncaught_exceptions() -> None:
    """Send uncaught exceptions (main thread and other threads) to the log, not just stderr."""
    logger = logging.getLogger("scrappy")
    previous = sys.excepthook

    def hook(exc_type, exc, tb) -> None:  # type: ignore[no-untyped-def]
        if not issubclass(exc_type, KeyboardInterrupt):
            logger.critical("Uncaught error, stopping", exc_info=(exc_type, exc, tb))
        if previous is not None and sys.stderr is not None:
            previous(exc_type, exc, tb)

    def thread_hook(args: threading.ExceptHookArgs) -> None:
        logger.error(
            "Uncaught error in thread %s",
            args.thread.name if args.thread else "?",
            exc_info=(args.exc_type, args.exc_value, args.exc_traceback),  # type: ignore[arg-type]
        )

    sys.excepthook = hook
    threading.excepthook = thread_hook


class _Quieter(logging.Filter):
    """Keep noise out of the log file: one line per HTTP request would push useful errors out
    quickly, and Alembic lists its plugins on every start."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.levelno >= logging.WARNING:
            return True
        return record.name not in ("uvicorn.access", "alembic.runtime.plugins")
