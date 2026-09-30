"""The running server's lifetime lock, polite stop requests and daily backups (app/lifetime.py)."""

from __future__ import annotations

import datetime as dt
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from fastapi.testclient import TestClient

from app import config, lifetime
from app.main import create_app


@dataclass
class FakeServer:
    started: bool = True
    should_exit: bool = False


def test_server_lock_is_exclusive() -> None:
    first = lifetime.acquire_server_lock()
    assert first is not None
    try:
        assert lifetime.server_lock_held()
        assert lifetime.acquire_server_lock(wait=0.2) is None
    finally:
        first.close()
    assert not lifetime.server_lock_held()


def test_a_second_server_exits_cleanly_without_touching_the_database(scrappy_home: Path) -> None:
    held = lifetime.acquire_server_lock()
    assert held is not None
    try:
        result = subprocess.run(
            [sys.executable, "-m", "app"],
            env={**os.environ, "SCRAPPY_PORT": "1"},  # would fail to bind if it got that far
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=60,
            check=False,
        )
    finally:
        held.close()
    assert result.returncode == 0
    assert not config.db_path().exists(), "it must stop before backups and migrations"
    log_text = (scrappy_home / "logs" / "server.log").read_text(encoding="utf-8")
    assert "already running or starting" in log_text


def test_stop_request_makes_the_server_exit() -> None:
    server = FakeServer()
    keeper = lifetime.Housekeeper(server)
    keeper.step()
    assert not server.should_exit
    lifetime.request_stop()
    keeper.step()
    assert server.should_exit
    assert not lifetime.stop_request_path().exists()


def test_a_stale_stop_request_is_ignored() -> None:
    lifetime.request_stop()  # left over from before this server started
    server = FakeServer()
    lifetime.Housekeeper(server).step()
    assert not server.should_exit


def test_daily_backup_when_the_date_changes_while_running() -> None:
    with TestClient(create_app()):  # creates the database; no backup on the very first start
        pass
    day = {"today": dt.date(2026, 10, 5)}
    clock = {"now": 0.0}
    server = FakeServer(started=False)
    keeper = lifetime.Housekeeper(server, today=lambda: day["today"], clock=lambda: clock["now"])

    def backups() -> list[str]:
        return sorted(p.name for p in config.backup_dir().glob("records-*.db"))

    day["today"] = dt.date(2026, 10, 6)
    keeper.step()
    assert backups() == [], "not while startup (backups, migrations) is still running"

    server.started = True
    keeper.step()
    assert backups() == ["records-2026-10-06.db"]
    keeper.step()  # same day: nothing new
    assert backups() == ["records-2026-10-06.db"]

    day["today"] = dt.date(2026, 10, 7)  # the laptop slept past midnight
    keeper.step()
    assert backups() == ["records-2026-10-06.db", "records-2026-10-07.db"]


def test_housekeeping_retries_hourly_if_a_backup_failed(monkeypatch) -> None:
    calls: list[dt.date] = []
    monkeypatch.setattr(lifetime.backup, "daily_backup", lambda today: calls.append(today))
    clock = {"now": 0.0}
    keeper = lifetime.Housekeeper(FakeServer(), clock=lambda: clock["now"])
    keeper.step()
    assert calls == []
    clock["now"] = lifetime.DAILY_RETRY_SECONDS + 1
    keeper.step()
    assert calls == [dt.date.today()]
