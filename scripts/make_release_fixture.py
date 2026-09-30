"""Make the saved-data sample for a release: `backend/tests/fixtures/releases/<tag>.db` and its
manifest `<tag>.json`. Run it once after every release, and commit the two files via a PR.

    python3 scripts/make_release_fixture.py v0.1.0 [--today 2026-09-30]

It checks the tag out into a temporary folder (a git worktree), installs *that* release's
dependencies with uv, and fills a new database through that release's own startup and API
(`scripts/release_fixture_populate.py`). So the file is exactly what the released app writes,
not what today's code would write. The manifest records every table's row count and every row's
stored values (see `backend/tests/release_data.py`), which `test_release_upgrades.py` checks
after upgrading the file with today's code.

`--today` fixes "today" for the release's clock (default: the day the tag was made), so the
data is the same each time. Needs git and uv; everything else is the standard library.
"""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "backend" / "tests" / "fixtures" / "releases"
POPULATE = ROOT / "scripts" / "release_fixture_populate.py"
MAX_BYTES = 200 * 1024


def _release_data() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "release_data", ROOT / "backend" / "tests" / "release_data.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout.strip()


def _run(cmd: list[str], cwd: Path, env: dict[str, str]) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=cwd, env=env, check=True)


def make(tag: str, today: dt.date | None, out_dir: Path) -> tuple[Path, Path]:
    try:
        _git("rev-parse", "--verify", "--quiet", f"{tag}^{{commit}}")
    except subprocess.CalledProcessError:
        sys.exit(f"No such tag: {tag}. Fetch the tags first (git fetch --tags).")
    today = today or dt.date.fromisoformat(_git("log", "-1", "--format=%cs", tag))

    with tempfile.TemporaryDirectory(prefix="scrappy-fixture-") as tmp_name:
        tmp = Path(tmp_name)
        src = tmp / "src"
        _git("worktree", "add", "--detach", str(src), tag)
        try:
            env = {k: v for k, v in os.environ.items() if k not in ("VIRTUAL_ENV", "PYTHONPATH")}
            env |= {
                "SCRAPPY_HOME": str(tmp / "home"),
                "SCRAPPY_BACKUP_DIR": str(tmp / "home" / "backups"),
                "UV_PROJECT_ENVIRONMENT": str(tmp / "venv"),
                "PYTHONPATH": str(src / "backend"),
            }
            env.pop("SCRAPPY_DATA_DIR", None)
            backend = src / "backend"
            _run(["uv", "sync", "--frozen", "--project", str(backend)], backend, env)
            populate = tmp / "populate.py"
            shutil.copy(POPULATE, populate)
            uv_run = ["uv", "run", "--frozen", "--project", str(backend), "python"]
            _run([*uv_run, str(populate), "--today", today.isoformat()], backend, env)
            live = tmp / "home" / "data" / "records.db"
            out_dir.mkdir(parents=True, exist_ok=True)
            db = out_dir / f"{tag}.db"
            db.unlink(missing_ok=True)
            conn = sqlite3.connect(live)
            try:
                conn.execute("VACUUM INTO ?", (str(db),))  # a compact, self-contained copy
            finally:
                conn.close()
        finally:
            _git("worktree", "remove", "--force", str(src))

    data = _release_data()
    manifest = out_dir / f"{tag}.json"
    data.write_manifest(manifest, data.manifest(db, tag, today.isoformat()))
    size = db.stat().st_size
    if size > MAX_BYTES:
        sys.exit(f"{db} is {size} bytes; keep a release fixture under {MAX_BYTES}.")
    return db, manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("tag", help="a release tag, e.g. v0.1.0")
    parser.add_argument("--today", type=dt.date.fromisoformat, help="default: the tag's date")
    parser.add_argument("--out", type=Path, default=FIXTURES, help=argparse.SUPPRESS)
    args = parser.parse_args()
    db, manifest = make(args.tag, args.today, args.out)
    tables = _release_data().read_manifest(manifest)["tables"]
    counts = ", ".join(f"{t} {s['count']}" for t, s in tables.items())
    print(f"Wrote {db.relative_to(ROOT) if db.is_relative_to(ROOT) else db} ({counts})")
    print(f"and {manifest.name}. Commit both via a PR.")


if __name__ == "__main__":
    main()
