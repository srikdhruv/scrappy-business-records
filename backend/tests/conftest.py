from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

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
    yield home
    dispose_engines()


@pytest.fixture
def client() -> Iterator[TestClient]:
    """A client for a fresh app; entering it runs startup (folders + migrations)."""
    with TestClient(create_app()) as c:
        yield c
