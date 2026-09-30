import datetime as dt
from pathlib import Path

import pytest

from app import config
from app.months import add_months, format_month, month_range, parse_month


def test_paths_follow_env(scrappy_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    assert config.home_dir() == scrappy_home.resolve()
    assert config.db_path() == scrappy_home.resolve() / "data" / "records.db"
    assert config.log_dir() == scrappy_home.resolve() / "logs"

    other = scrappy_home.parent / "elsewhere"
    monkeypatch.setenv("SCRAPPY_DATA_DIR", str(other))
    assert config.db_path() == other.resolve() / "records.db"


def test_port(monkeypatch: pytest.MonkeyPatch) -> None:
    assert config.port() == 8765
    monkeypatch.setenv("SCRAPPY_PORT", "9000")
    assert config.port() == 9000


def test_defaults_without_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SCRAPPY_HOME")
    monkeypatch.delenv("SCRAPPY_BACKUP_DIR")
    assert config.home_dir().name == "ScrappyRecords"
    assert config.backup_dir().name == "ScrappyRecords Backups"


def test_months() -> None:
    assert parse_month("2026-10") == dt.date(2026, 10, 1)
    assert format_month(dt.date(2026, 10, 17)) == "2026-10"
    assert add_months(dt.date(2026, 1, 1), -1) == dt.date(2025, 12, 1)
    assert add_months(dt.date(2025, 11, 1), 14) == dt.date(2027, 1, 1)
    assert month_range(dt.date(2025, 11, 1), dt.date(2026, 2, 1)) == [
        dt.date(2025, 11, 1),
        dt.date(2025, 12, 1),
        dt.date(2026, 1, 1),
        dt.date(2026, 2, 1),
    ]
    for bad in ["2026-13", "2026-1", "x"]:
        with pytest.raises(ValueError):
            parse_month(bad)
