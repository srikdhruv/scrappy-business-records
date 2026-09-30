"""Alembic environment.

Used both by the `alembic` CLI (run from `backend/`, reading `alembic.ini`) and by
`app.migrate.upgrade_to_head()` at app startup (which builds the config in code).

Two SQLite details matter for the user's data:

1. **Foreign keys are OFF while migrating.** `batch_alter_table` rebuilds a table by copying it
   and dropping the original. With foreign keys on, dropping `students` would cascade-delete
   every payment and fee change. So the migration connection turns them off (before any
   transaction; SQLite ignores the pragma inside one), and after the migration
   `PRAGMA foreign_key_check` must come back empty or the whole migration is rolled back.
2. **The migration is one real transaction.** Python's sqlite3 module doesn't send BEGIN before
   DDL, so by default a failed migration could leave half-altered tables. This connection runs
   in driver-autocommit mode and emits BEGIN itself, so everything (DDL included) commits or
   rolls back together.
"""

from __future__ import annotations

from logging.config import fileConfig
from pathlib import Path
from typing import Any

from alembic import context
from sqlalchemy import Engine, create_engine, event
from sqlalchemy.engine import make_url

from app import config as app_config
from app.models import Base

config = context.config

# Only the CLI has an ini file with logging config; at app startup we leave logging alone.
if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


class ForeignKeyViolationError(RuntimeError):
    """A migration left rows pointing at missing parents; it has been rolled back."""


def _url() -> str:
    return config.get_main_option("sqlalchemy.url") or app_config.db_url()


def migration_engine(url: str) -> Engine:
    """An engine for migrating: foreign keys OFF, and explicit, all-or-nothing transactions."""
    engine = create_engine(url)

    @event.listens_for(engine, "connect")
    def _on_connect(dbapi_connection: Any, _record: Any) -> None:
        dbapi_connection.isolation_level = None  # we send BEGIN ourselves (see below)
        dbapi_connection.execute("PRAGMA foreign_keys=OFF")

    @event.listens_for(engine, "begin")
    def _on_begin(connection: Any) -> None:
        connection.exec_driver_sql("BEGIN")

    return engine


def check_foreign_keys(connection: Any) -> None:
    rows = connection.exec_driver_sql("PRAGMA foreign_key_check").fetchall()
    if rows:
        details = ", ".join(f"{r[0]} rowid {r[1]} -> {r[2]}" for r in rows[:10])
        raise ForeignKeyViolationError(
            f"Migration rolled back: {len(rows)} row(s) would break foreign keys ({details})"
        )


def run_migrations_offline() -> None:
    context.configure(
        url=_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    url = _url()
    database = make_url(url).database
    if database and database != ":memory:":
        Path(database).parent.mkdir(parents=True, exist_ok=True)
    engine = migration_engine(url)
    try:
        with engine.connect() as connection:
            context.configure(
                connection=connection,
                target_metadata=target_metadata,
                # SQLite can't ALTER most things in place; batch mode copies the table instead.
                render_as_batch=True,
                compare_type=True,
                # Alembic assumes SQLite DDL isn't transactional and would commit after each
                # revision. With our explicit BEGIN it is, so run everything in one transaction.
                transactional_ddl=True,
            )
            with context.begin_transaction():
                context.run_migrations()
                # Inside the transaction, so a violation rolls the whole migration back.
                check_foreign_keys(connection)
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
