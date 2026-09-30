"""Database engine and session.

The engine is created lazily and cached per database URL, so tests that point `SCRAPPY_HOME` at
a temporary folder get their own engine. Every connection turns on SQLite foreign keys, which
are off by default and are needed for `ON DELETE CASCADE`.
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


def get_session() -> Iterator[Session]:
    """FastAPI dependency: one session per request, closed afterwards.

    Routers commit explicitly; anything left uncommitted is rolled back on close.
    """
    session = sessionmaker(bind=get_engine(), expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()


SessionDep = Annotated[Session, Depends(get_session)]
"""Use as a router parameter type: `def handler(session: SessionDep): ...`."""
