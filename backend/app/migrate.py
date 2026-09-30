"""Run Alembic migrations from code.

The app migrates itself at startup, from wherever it happens to be installed, so this never
relies on the current working directory or on `alembic.ini` (which exists only for developers
running the `alembic` CLI from `backend/`).

Safety (see `migrations/env.py`): migrations run with SQLite foreign keys OFF, inside a single
transaction, and roll back if `PRAGMA foreign_key_check` finds broken references afterwards.
"""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

from app import config

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"


def alembic_config(db_url: str | None = None, script_location: Path | None = None) -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(script_location or MIGRATIONS_DIR))
    # `%` must be escaped for ConfigParser interpolation.
    cfg.set_main_option("sqlalchemy.url", (db_url or config.db_url()).replace("%", "%%"))
    return cfg


def head_revision(script_location: Path | None = None) -> str | None:
    cfg = alembic_config(script_location=script_location)
    return ScriptDirectory.from_config(cfg).get_current_head()


def _database_file(db_url: str) -> Path | None:
    database = make_url(db_url).database
    return Path(database) if database and database != ":memory:" else None


def current_revision(db_url: str | None = None) -> str | None:
    """The revision the database is at, or None for a new database.

    Never creates the database file: a missing file simply means "no revision yet".
    """
    url = db_url or config.db_url()
    db_file = _database_file(url)
    if db_file is not None and not db_file.exists():
        return None
    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            return MigrationContext.configure(conn).get_current_revision()
    finally:
        engine.dispose()


def needs_upgrade(db_url: str | None = None) -> bool:
    """True if the database is behind the latest migration (including a brand-new database).

    The startup code uses this to decide whether to take a pre-migration backup.
    """
    return current_revision(db_url) != head_revision()


def upgrade_to_head(db_url: str | None = None, script_location: Path | None = None) -> None:
    command.upgrade(alembic_config(db_url, script_location), "head")
