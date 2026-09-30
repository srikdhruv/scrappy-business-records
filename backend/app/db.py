"""Database engine and session.

The engine is created lazily and cached per database URL, so tests that point `SCRAPPY_HOME` at
a temporary folder get their own engine. Every connection turns on SQLite foreign keys, which
are off by default and are needed for `ON DELETE CASCADE`.

Never run migrations through this engine: rebuilding a table with foreign keys on would
cascade-delete its children. Migrations use their own engine (`app/migrations/env.py`).
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from typing import Annotated, Any

from fastapi import Depends
from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app import config

_engines: dict[str, Engine] = {}
_factories: dict[str, sessionmaker[Session]] = {}
_lock = threading.Lock()


def _enable_foreign_keys(dbapi_connection: Any, _connection_record: Any) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


def make_engine(url: str) -> Engine:
    """A new SQLite engine with foreign keys enforced on every connection."""
    engine = create_engine(url, connect_args={"check_same_thread": False})
    event.listen(engine, "connect", _enable_foreign_keys)
    return engine


def get_engine() -> Engine:
    """The (cached) engine for the database at `config.db_url()`."""
    url = config.db_url()
    with _lock:
        engine = _engines.get(url)
        if engine is None:
            engine = _engines[url] = make_engine(url)
        return engine


def dispose_engines() -> None:
    """Close and forget every cached engine (tests use this to release temp files)."""
    with _lock:
        for engine in _engines.values():
            engine.dispose()
        _engines.clear()
        _factories.clear()


def session_factory() -> sessionmaker[Session]:
    """The (cached) session factory for the current database."""
    url = config.db_url()
    with _lock:
        factory = _factories.get(url)
    if factory is None:
        factory = sessionmaker(bind=get_engine(), expire_on_commit=False)
        with _lock:
            factory = _factories.setdefault(url, factory)
    return factory


def get_session() -> Iterator[Session]:
    """FastAPI dependency: one session per request, closed afterwards.

    Routers commit explicitly; anything left uncommitted is rolled back on close.
    """
    session = session_factory()()
    try:
        yield session
    finally:
        session.close()


SessionDep = Annotated[Session, Depends(get_session)]
"""Use as a router parameter type: `def handler(session: SessionDep): ...`."""
