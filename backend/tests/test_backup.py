import datetime as dt
import io
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import backup, config, migrate
from app.main import create_app


def _make_db(rows: int = 1) -> Path:
    config.ensure_dirs()
    db = config.db_path()
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS t (x INTEGER)")
        conn.executemany("INSERT INTO t VALUES (?)", [(i,) for i in range(rows)])
    conn.close()
    return db


def _rows(db: Path) -> int:
    conn = sqlite3.connect(db)
    try:
        return conn.execute("SELECT count(*) FROM t").fetchone()[0]
    finally:
        conn.close()


def test_no_database_means_no_backup() -> None:
    assert backup.daily_backup() is None
    assert backup.backup("pre-update") is None
    assert not config.db_path().exists(), "a backup must never create the live database"


def test_daily_backup_once_per_day() -> None:
    _make_db(3)
    first = backup.daily_backup(dt.date(2026, 10, 5))
    assert first is not None
    assert first == config.backup_dir() / "records-2026-10-05.db"
    assert _rows(first) == 3
    # Same day again: nothing new, even if the data changed.
    _make_db(1)
    assert backup.daily_backup(dt.date(2026, 10, 5)) is None
    assert _rows(first) == 3
    assert not list(config.backup_dir().glob("*.partial"))


def test_daily_backups_keep_newest_30_and_leave_others_alone() -> None:
    _make_db()
    folder = config.backup_dir()
    start = dt.date(2026, 1, 1)
    for i in range(35):
        written = backup.daily_backup(start + dt.timedelta(days=i))
        assert written is not None
        _set_mtime(written, start + dt.timedelta(days=i))
    keepers = [
        folder / "records-pre-update-20260101-101500.db",
        folder / "records-pre-migration-20260101-101500.db",
        folder / "my-own-copy.db",
    ]
    for keeper in keepers:
        keeper.write_bytes(b"x")
    backup.daily_backup(start + dt.timedelta(days=35))

    dailies = sorted(p.name for p in folder.glob("records-????-??-??.db"))
    assert len(dailies) == backup.DAILY_KEEP
    assert dailies[0] == f"records-{start + dt.timedelta(days=6):%Y-%m-%d}.db"
    assert dailies[-1] == f"records-{start + dt.timedelta(days=35):%Y-%m-%d}.db"
    assert all(k.exists() for k in keepers)


def _set_mtime(path: Path, day: dt.date) -> None:
    stamp = dt.datetime.combine(day, dt.time(9)).timestamp()
    os.utime(path, (stamp, stamp))


def test_a_wrong_clock_never_prunes_the_backup_just_taken() -> None:
    """A dead clock battery can put the laptop in 2001. The new daily backup's name then sorts
    first, but it must be kept (and the oldest real one pruned instead)."""
    _make_db()
    folder = config.backup_dir()
    start = dt.date(2026, 1, 1)
    for i in range(backup.DAILY_KEEP):
        written = backup.daily_backup(start + dt.timedelta(days=i))
        assert written is not None
        _set_mtime(written, start + dt.timedelta(days=i))

    new = backup.daily_backup(dt.date(2001, 1, 1))
    assert new is not None and new.exists()
    dailies = sorted(p.name for p in folder.glob("records-????-??-??.db"))
    assert len(dailies) == backup.DAILY_KEEP
    assert "records-2001-01-01.db" in dailies
    assert "records-2026-01-01.db" not in dailies  # the oldest by time written went instead


def test_one_off_backups_are_named_by_reason_and_never_collide() -> None:
    _make_db(2)
    now = dt.datetime(2026, 10, 5, 10, 15, 0)
    a = backup.backup("pre-update", now)
    b = backup.backup("pre-update", now)
    assert a is not None and b is not None
    assert a.name == "records-pre-update-20261005-101500.db"
    assert b.name == "records-pre-update-20261005-101500-2.db"
    assert _rows(b) == 2
    # One-off backups are never pruned.
    backup.prune_daily(keep=0)
    assert a.exists() and b.exists()


def test_unknown_reason_is_rejected() -> None:
    with pytest.raises(ValueError):
        backup.backup("whenever")


def test_falls_back_to_data_folder_when_backup_folder_is_unwritable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _make_db()
    blocker = tmp_path / "not-a-folder"
    blocker.write_text("a file where the backup folder should be")
    monkeypatch.setenv("SCRAPPY_BACKUP_DIR", str(blocker / "backups"))
    target = backup.backup("manual")
    assert target is not None
    assert target.parent == config.data_dir() / "backups"
    assert _rows(target) == 1


def test_falls_back_when_sqlite_cant_open_the_backup_file(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Controlled Folder Access or a OneDrive lock shows up as a sqlite3 error, not OSError."""
    _make_db()
    real_connect = sqlite3.connect
    blocked = str(config.backup_dir())

    def connect(database, *args, **kwargs):  # type: ignore[no-untyped-def]
        if str(database).startswith(blocked):
            raise sqlite3.OperationalError("unable to open database file")
        return real_connect(database, *args, **kwargs)

    monkeypatch.setattr(backup.sqlite3, "connect", connect)
    target = backup.backup("pre-migration")
    assert target is not None
    assert target.parent == config.data_dir() / "backups"
    assert _rows(target) == 1


def _leave_hot_journal(db: Path) -> None:
    """Start a big transaction in another process and kill it before it commits, the way a
    force-killed server or a power cut would. SQLite leaves `records.db-journal` behind."""
    child = (
        "import os, sqlite3\n"
        f"c = sqlite3.connect({str(db)!r}, isolation_level=None)\n"
        "c.execute('PRAGMA cache_size=2')\n"  # tiny cache: changes spill into the file
        "c.execute('BEGIN')\n"
        "c.execute(\"UPDATE filler SET x = 'changed'\")\n"
        "os._exit(1)\n"
    )
    subprocess.run([sys.executable, "-c", child], check=False, timeout=60)
    assert Path(f"{db}-journal").exists(), "the test needs a hot journal to be meaningful"


def test_backup_and_startup_survive_a_hot_journal() -> None:
    with TestClient(create_app(), base_url="http://127.0.0.1:8765"):
        pass
    db = config.db_path()
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE filler (x TEXT)")
        conn.executemany("INSERT INTO filler VALUES (?)", [("original" * 50,)] * 2000)
    conn.close()
    _leave_hot_journal(db)

    target = backup.backup("pre-update")
    assert target is not None
    conn = sqlite3.connect(target)
    try:
        # The unfinished transaction was rolled back, not copied half-done.
        assert conn.execute("SELECT DISTINCT x FROM filler").fetchall() == [("original" * 50,)]
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        conn.close()

    _leave_hot_journal(db)
    with TestClient(
        create_app(), base_url="http://127.0.0.1:8765"
    ) as client:  # daily backup, migrations check, serve
        assert client.get("/api/health").status_code == 200
    assert (config.backup_dir() / f"records-{dt.date.today():%Y-%m-%d}.db").is_file()


def test_cli(capsys: pytest.CaptureFixture[str]) -> None:
    assert backup.main(["--reason", "pre-update"]) == 0
    assert "nothing to back up" in capsys.readouterr().out
    _make_db()
    assert backup.main(["--reason", "pre-update"]) == 0
    out = capsys.readouterr().out
    assert "records-pre-update-" in out
    assert len(list(config.backup_dir().glob("records-pre-update-*.db"))) == 1


# --------------------------------------------------------------------------- startup wiring


def _backups() -> list[str]:
    return sorted(p.name for p in config.backup_dir().glob("*.db"))


def test_first_start_takes_no_backups() -> None:
    with TestClient(create_app(), base_url="http://127.0.0.1:8765"):
        pass
    assert config.db_path().is_file()
    assert _backups() == []


def test_later_start_takes_a_daily_backup_but_no_pre_migration_one() -> None:
    with TestClient(create_app(), base_url="http://127.0.0.1:8765"):
        pass
    with TestClient(create_app(), base_url="http://127.0.0.1:8765"):
        pass
    names = _backups()
    assert names == [f"records-{dt.date.today():%Y-%m-%d}.db"]


def test_start_with_an_outdated_database_takes_a_pre_migration_backup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config.ensure_dirs()
    migrate.upgrade_to_head()
    head = migrate.head_revision()
    # Pretend the database is at an older revision.
    with sqlite3.connect(config.db_path()) as conn:
        conn.execute("UPDATE alembic_version SET version_num = 'older'")
    conn.close()
    assert migrate.needs_upgrade()

    def fake_upgrade(db_url: str | None = None) -> None:
        with sqlite3.connect(config.db_path()) as c:
            c.execute("UPDATE alembic_version SET version_num = ?", (head,))
        c.close()

    monkeypatch.setattr(migrate, "upgrade_to_head", fake_upgrade)
    with TestClient(create_app(), base_url="http://127.0.0.1:8765"):
        pass

    pre = list(config.backup_dir().glob("records-pre-migration-*.db"))
    assert len(pre) == 1
    # The copy was taken before the upgrade ran.
    conn = sqlite3.connect(pre[0])
    try:
        assert conn.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "older"
    finally:
        conn.close()
    assert f"records-{dt.date.today():%Y-%m-%d}.db" in _backups()
    assert not migrate.needs_upgrade()


def test_cli_prints_any_path_even_to_a_narrow_code_page(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """On Windows, output to a pipe uses the ANSI code page (cp1252). A Documents folder under
    a username like "Rāhul" must not make the pre-update backup fail."""
    monkeypatch.setenv("SCRAPPY_BACKUP_DIR", str(tmp_path / "Rāhul रिकॉर्ड" / "backups"))
    _make_db()
    raw = io.BytesIO()
    narrow = io.TextIOWrapper(raw, encoding="cp1252")
    monkeypatch.setattr(sys, "stdout", narrow)
    assert backup.main(["--reason", "pre-update"]) == 0
    narrow.flush()
    assert b"Backup saved" in raw.getvalue()
