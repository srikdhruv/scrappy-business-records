"""Paths and ports.

Everything is resolved lazily, every time a function is called, so tests and dev mode can point
the app somewhere else by setting environment variables before (or even after) import.

| Variable             | Default (Windows)                     | Purpose                     |
|----------------------|---------------------------------------|-----------------------------|
| `SCRAPPY_HOME`       | `%LOCALAPPDATA%\\ScrappyRecords`       | Root for `data/` and `logs/` |
| `SCRAPPY_DATA_DIR`   | `$SCRAPPY_HOME\\data`                  | SQLite file location        |
| `SCRAPPY_BACKUP_DIR` | `Documents\\ScrappyRecords Backups`    | Backups                     |
| `SCRAPPY_PORT`       | `8765`                                | Server port                 |
| `SCRAPPY_FEEDBACK_URL` | `FEEDBACK_URL` below                | Feedback relay; empty = off |

On macOS the home is `~/Library/Application Support/ScrappyRecords`.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import platformdirs

APP_ID = "scrappy-records"
APP_DIR_NAME = "ScrappyRecords"
BACKUP_DIR_NAME = "ScrappyRecords Backups"
DB_FILENAME = "records.db"
HOST = "127.0.0.1"  # Never bind anything else: the app must not be reachable from the network.
DEFAULT_PORT = 8765

FEEDBACK_URL = "https://scrappy-feedback.srikdhruv.workers.dev/feedback"
"""The feedback relay (a Cloudflare Worker, `relay/`), e.g.
`https://scrappy-feedback.<account>.workers.dev/feedback`. Sending feedback is the app's only
outbound call at runtime, and only feedback the owner chose to send goes there (ADR 0005).
Empty means sending is off: feedback is still saved on the laptop and goes out once a version
with a URL is installed. Set it when the relay is deployed
(docs/runbooks/feedback-relay-setup.md)."""


def _env_path(name: str) -> Path | None:
    value = os.environ.get(name, "").strip()
    return Path(value).expanduser().resolve() if value else None


def home_dir() -> Path:
    """Root folder for `data/` and `logs/`."""
    return _env_path("SCRAPPY_HOME") or Path(
        platformdirs.user_data_dir(APP_DIR_NAME, appauthor=False, roaming=False)
    )


def data_dir() -> Path:
    """Folder holding the live SQLite database. Installs and updates never touch it."""
    return _env_path("SCRAPPY_DATA_DIR") or home_dir() / "data"


def log_dir() -> Path:
    return home_dir() / "logs"


def backup_dir() -> Path:
    """Where backups go: the user's Documents folder unless `SCRAPPY_BACKUP_DIR` is set.

    Note this does *not* follow `SCRAPPY_HOME`. Dev mode (`make dev`) and the test suite set
    `SCRAPPY_BACKUP_DIR` explicitly so they never write into a real Documents folder.
    """
    return _env_path("SCRAPPY_BACKUP_DIR") or (
        Path(platformdirs.user_documents_dir()) / BACKUP_DIR_NAME
    )


def db_path() -> Path:
    return data_dir() / DB_FILENAME


def db_url() -> str:
    return f"sqlite:///{db_path().as_posix()}"


def port() -> int:
    value = os.environ.get("SCRAPPY_PORT", "").strip()
    return int(value) if value else DEFAULT_PORT


def feedback_url() -> str:
    """Where the server sends feedback. `SCRAPPY_FEEDBACK_URL` overrides `FEEDBACK_URL` (even
    when set to empty, which turns sending off: tests and dev mode do that)."""
    value = os.environ.get("SCRAPPY_FEEDBACK_URL")
    return (FEEDBACK_URL if value is None else value).strip()


def feedback_dir() -> Path:
    """Screenshots of feedback waiting to be sent (deleted once sent)."""
    return data_dir() / "feedback"


def install_id_file() -> Path:
    """A random ID for this copy of the app, made once (see app/diagnostics.py)."""
    return data_dir() / "install-id"


def static_dir() -> Path:
    """The built React UI (`vite build` writes here). May not exist in dev or tests."""
    return Path(__file__).resolve().parent / "static"


def ensure_dirs() -> None:
    """Create the data, log and backup folders if they are missing.

    The backup folder is best-effort: if it can't be created (for example, macOS refuses access
    to Documents), the app still starts and `app.backup` falls back to `data/backups`.
    """
    for d in (data_dir(), log_dir()):
        d.mkdir(parents=True, exist_ok=True)
    try:
        backup_dir().mkdir(parents=True, exist_ok=True)
    except OSError:
        logging.getLogger("scrappy").warning("Couldn't create the backup folder %s", backup_dir())
