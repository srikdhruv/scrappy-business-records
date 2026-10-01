from __future__ import annotations

import datetime as dt
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.clock import get_today
from app.db import dispose_engines
from app.main import create_app


@pytest.fixture(autouse=True)
def scrappy_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Point every path the app uses at a fresh temp folder, so no test touches real data."""
    home = tmp_path / "scrappy-home"
    monkeypatch.setenv("SCRAPPY_HOME", str(home))
    monkeypatch.setenv("SCRAPPY_BACKUP_DIR", str(home / "backups"))
    monkeypatch.delenv("SCRAPPY_DATA_DIR", raising=False)
    monkeypatch.delenv("SCRAPPY_PORT", raising=False)
    # Never send feedback anywhere from a test (tests that send use a fake relay).
    monkeypatch.setenv("SCRAPPY_FEEDBACK_URL", "")
    # Never look for updates on GitHub from a test (tests that do use a fake feed).
    monkeypatch.setenv("SCRAPPY_UPDATE_FEED_URL", "")
    for name in ("SCRAPPY_UPDATE_DOWNLOAD_URL", "SCRAPPY_TEST_MODE"):
        monkeypatch.delenv(name, raising=False)
    yield home
    dispose_engines()


@pytest.fixture
def client() -> Iterator[TestClient]:
    """A client for a fresh app; entering it runs startup (folders + migrations)."""
    with TestClient(create_app(), base_url="http://127.0.0.1:8765") as c:
        yield c


FROZEN_TODAY = dt.date(2026, 6, 15)
FROZEN_MONTH = FROZEN_TODAY.replace(day=1)
"""The current month as far as the `api` fixture's app is concerned."""


@pytest.fixture
def api() -> Iterator[TestClient]:
    """Like `client`, but the app's clock is frozen at `FROZEN_TODAY` (so the current month
    is `FROZEN_MONTH`, June 2026)."""
    app = create_app()
    app.dependency_overrides[get_today] = lambda: FROZEN_TODAY
    with TestClient(app, base_url="http://127.0.0.1:8765") as c:
        yield c
