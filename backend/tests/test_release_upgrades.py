"""Every released version's data upgrades intact (ADR 0004).

`fixtures/releases/` holds one database per release, made by that release's own code
(`scripts/make_release_fixture.py`), with a manifest of every row it stores. For each one, this
copies it into a fresh data folder and starts today's app the way the laptop does (the startup
code: backups, `alembic upgrade head`, the foreign-key check), then checks that:

- no row is lost and every stored value (names, phones, notes, amounts, dates, months, methods,
  fee changes and their kind) is exactly what the release saved;
- the backup taken before upgrading exists, opens, and holds the release's data unchanged;
- the API serves every student, every payment and the dashboard for every month, and shows the
  same values;
- going back down to the release's revision and up again keeps the data.

Each fixture runs twice: against today's migrations, and with one more (additive) migration on
top that rebuilds the `students` table, as the next release's might. So the "upgrade needed"
path (pre-migration backup, table copy) is always exercised, even while the newest fixture is
already at the latest revision.
"""

from __future__ import annotations

import datetime as dt
import re
import shutil
import sqlite3
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
import release_data
from alembic import command
from fastapi.testclient import TestClient

from app import config, migrate
from app.clock import get_today
from app.db import dispose_engines
from app.main import create_app

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "releases"
MONTH_COLUMNS = {"joined_month", "left_month", "effective_month", "for_month"}

NEXT_MIGRATION = '''"""A pretend next release: adds a column, copying the students table."""

import sqlalchemy as sa
from alembic import op

revision = "next_release"
down_revision = "{down}"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("students", recreate="always") as batch:
        batch.add_column(sa.Column("nickname", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("students") as batch:
        batch.drop_column("nickname")
'''


def _version(path: Path) -> tuple[int, ...]:
    return tuple(int(n) for n in re.findall(r"\d+", path.stem))


RELEASES = sorted(FIXTURES.glob("v*.db"), key=_version)


@dataclass
class Release:
    tag: str
    source: Path
    manifest: dict[str, Any]

    @property
    def revision(self) -> str:
        return self.manifest["revision"]

    @property
    def today(self) -> dt.date:
        return dt.date.fromisoformat(self.manifest["today"])

    @property
    def tables(self) -> dict[str, dict[str, Any]]:
        return self.manifest["tables"]

    def rows(self, table: str) -> list[dict[str, Any]]:
        spec = self.tables[table]
        return [dict(zip(spec["columns"], row, strict=True)) for row in spec["rows"]]


def test_every_release_fixture_has_a_manifest() -> None:
    assert RELEASES, f"No release fixtures in {FIXTURES}"
    for db in RELEASES:
        assert db.with_suffix(".json").is_file(), f"{db.name} has no manifest"
        assert db.stat().st_size < 200 * 1024, f"{db.name} is too big for a fixture"


@pytest.fixture(params=RELEASES, ids=[p.stem for p in RELEASES])
def release(request: pytest.FixtureRequest) -> Release:
    source: Path = request.param
    manifest = release_data.read_manifest(source.with_suffix(".json"))
    assert manifest["tag"] == source.stem
    # The committed file itself is still exactly what its manifest says.
    assert release_data.revision(source) == manifest["revision"]
    assert release_data.dump(source) == manifest["tables"]
    return Release(source.stem, source, manifest)


@pytest.fixture(params=["to-head", "plus-next-migration"])
def migrations(
    request: pytest.FixtureRequest, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[Path]:
    """Today's migrations, or today's plus one more on top (a pretend next release)."""
    if request.param == "to-head":
        yield migrate.MIGRATIONS_DIR
        return
    scripts = tmp_path / "migrations"
    shutil.copytree(migrate.MIGRATIONS_DIR, scripts, ignore=shutil.ignore_patterns("__pycache__"))
    (scripts / "versions" / "next_release.py").write_text(
        NEXT_MIGRATION.format(down=migrate.head_revision()), encoding="utf-8"
    )
    monkeypatch.setattr(migrate, "MIGRATIONS_DIR", scripts)
    yield scripts


def _assert_intact(db: Path, release: Release, when: str) -> None:
    """Every table, row and stored value in the release's manifest is in `db`, unchanged."""
    stored = release_data.dump_like(db, release.tables)
    problems = []
    for table, expected in release.tables.items():
        before = {tuple(r[:1]): r for r in expected["rows"]}
        after = {tuple(r[:1]): r for r in stored[table]["rows"]}
        problems += [f"{table}: lost {before[k]}" for k in before.keys() - after.keys()]
        problems += [f"{table}: new {after[k]}" for k in after.keys() - before.keys()]
        problems += [
            f"{table}: {before[k]} became {after[k]}"
            for k in before.keys() & after.keys()
            if before[k] != after[k]
        ]
    assert not problems, f"{release.tag}: data changed {when}:\n" + "\n".join(sorted(problems))
    assert stored == release.tables


def _check_database(db: Path) -> None:
    conn = sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True)
    try:
        assert conn.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        conn.close()


def _api_value(column: str, value: Any) -> Any:
    """A stored value as the API shows it: months as "YYYY-MM"."""
    return value[:7] if column in MONTH_COLUMNS and value is not None else value


def _same_as_stored(api_row: dict[str, Any], stored: dict[str, Any]) -> None:
    shown = {c: api_row[c] for c in stored if c in api_row}
    assert shown == {c: _api_value(c, v) for c, v in stored.items() if c in api_row}


def _months(first: str, last: dt.date) -> list[str]:
    year, month = int(first[:4]), int(first[5:7])
    out = []
    while (year, month) <= (last.year, last.month):
        out.append(f"{year:04d}-{month:02d}")
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return out


def _check_api(client: TestClient, release: Release) -> None:
    students = release.rows("students")
    payments = release.rows("payments")
    fee_changes = release.rows("fee_changes")

    listed = client.get("/api/students", params={"status": "all"})
    assert listed.status_code == 200, listed.text
    assert sorted(s["id"] for s in listed.json()) == sorted(s["id"] for s in students)
    for status in ("active", "left"):
        assert client.get("/api/students", params={"status": status}).status_code == 200

    for stored in students:
        detail = client.get(f"/api/students/{stored['id']}")
        assert detail.status_code == 200, detail.text
        body = detail.json()
        _same_as_stored(body, stored)
        history = {f["id"]: f for f in body["fee_history"]}
        own = [f for f in fee_changes if f["student_id"] == stored["id"]]
        assert sorted(history) == sorted(f["id"] for f in own)
        for fee in own:
            _same_as_stored(history[fee["id"]], fee)
        suggestion = client.get(f"/api/students/{stored['id']}/suggest-payment")
        assert suggestion.status_code == 200, suggestion.text

    listed = client.get("/api/payments")
    assert listed.status_code == 200, listed.text
    by_id = {p["id"]: p for p in listed.json()}
    assert sorted(by_id) == sorted(p["id"] for p in payments)
    for stored in payments:
        _same_as_stored(by_id[stored["id"]], stored)
        one = client.get(f"/api/payments/{stored['id']}")
        assert one.status_code == 200, one.text

    # The dashboard for every month the data touches, and a little beyond.
    earliest = min(s["joined_month"] for s in students)
    earliest = min([earliest, *(p["for_month"] for p in payments)])
    last = release.today + dt.timedelta(days=31 * 3)
    for month in _months(earliest, last):
        response = client.get("/api/dashboard", params={"month": month})
        assert response.status_code == 200, f"{month}: {response.text}"
    assert client.get("/api/dashboard").status_code == 200


def test_release_data_upgrades_intact(release: Release, migrations: Path) -> None:
    db = config.db_path()
    db.parent.mkdir(parents=True)
    shutil.copyfile(release.source, db)
    upgrading = release.revision != migrate.head_revision()

    app = create_app()
    app.dependency_overrides[get_today] = lambda: release.today
    with TestClient(app) as client:  # the real startup: backups, then alembic upgrade head
        assert migrate.current_revision() == migrate.head_revision()
        _check_database(db)
        _assert_intact(db, release, "while upgrading")

        _check_api(client, release)
        # And with the laptop's real clock, as the owner would open it today.
        app.dependency_overrides.clear()
        assert client.get("/api/students", params={"status": "all"}).status_code == 200
        assert client.get("/api/dashboard").status_code == 200
        _assert_intact(db, release, "just by reading it")

    # Backups: the one taken before upgrading holds the release's data, untouched.
    backups = sorted(config.backup_dir().glob("records-pre-migration-*.db"))
    if upgrading:
        assert len(backups) == 1, backups
        _check_database(backups[0])
        assert release_data.revision(backups[0]) == release.revision
        _assert_intact(backups[0], release, "in the backup")
    else:
        assert backups == [], "nothing to upgrade, so no pre-migration backup"
    daily = sorted(config.backup_dir().glob("records-????-??-??.db"))
    assert len(daily) == 1
    assert release_data.revision(daily[0]) == release.revision
    _assert_intact(daily[0], release, "in the backup")

    # Back down to the release's revision (what a developer or a rollback would do), and up.
    dispose_engines()
    command.downgrade(migrate.alembic_config(), release.revision)
    assert migrate.current_revision() == release.revision
    _check_database(db)
    _assert_intact(db, release, "going back down")
    migrate.upgrade_to_head()
    assert migrate.current_revision() == migrate.head_revision()
    _check_database(db)
    _assert_intact(db, release, "going up again")

    # And the app still starts on it and serves it.
    with TestClient(app) as client:
        _check_api(client, release)
