"""Run Alembic migrations from code.

The app migrates itself at startup, from wherever it happens to be installed, so this never
relies on the current working directory or on `alembic.ini` (which exists only for developers
running the `alembic` CLI from `backend/`).
"""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory

from app import config
from app.db import make_engine

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"


def alembic_config(db_url: str | None = None) -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(MIGRATIONS_DIR))
    # `%` must be escaped for ConfigParser interpolation.
    cfg.set_main_option("sqlalchemy.url", (db_url or config.db_url()).replace("%", "%%"))
    return cfg


def head_revision() -> str | None:
    return ScriptDirectory.from_config(alembic_config()).get_current_head()


def current_revision(db_url: str | None = None) -> str | None:
    """The revision the database is at, or None for a new (empty) database."""
    engine = make_engine(db_url or config.db_url())
    try:
        with engine.connect() as conn:
            return MigrationContext.configure(conn).get_current_revision()
    finally:
        engine.dispose()


def needs_upgrade(db_url: str | None = None) -> bool:
    """True if the database is behind the latest migration (including a brand-new database)."""
    return current_revision(db_url) != head_revision()


def upgrade_to_head(db_url: str | None = None) -> None:
    command.upgrade(alembic_config(db_url), "head")
