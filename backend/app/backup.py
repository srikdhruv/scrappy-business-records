"""Backups of the SQLite database, into the backup folder (`config.backup_dir()`).

| When                          | File                                     | Kept            |
|-------------------------------|------------------------------------------|-----------------|
| First server start of the day | `records-YYYY-MM-DD.db`                  | newest 30       |
| Before an update (installer)  | `records-pre-update-YYYYMMDD-HHMMSS.db`   | until deleted   |
| Before a database upgrade     | `records-pre-migration-YYYYMMDD-HHMMSS.db` | until deleted  |
| By hand                       | `records-manual-YYYYMMDD-HHMMSS.db`       | until deleted   |

Copies use SQLite's online backup API, so they are consistent even while the server is running.
Each copy is written to a temporary name first and renamed into place, so a half-written file
never looks like a finished backup.

If the backup folder can't be written (for example, macOS refuses access to Documents), the copy
goes to `<data folder>/backups` instead, and the problem is logged.

Command line (used by the installers before an update):

    python -m app.backup --reason pre-update
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import os
import re
import sqlite3
import sys
from pathlib import Path

from app import config

log = logging.getLogger("scrappy.backup")

DAILY_KEEP = 30
REASONS = ("pre-update", "pre-migration", "manual")
_DAILY_RE = re.compile(r"^records-\d{4}-\d{2}-\d{2}\.db$")


def fallback_dir() -> Path:
    """Used only when the normal backup folder can't be written."""
    return config.data_dir() / "backups"


def _copy_database(source: Path, target: Path) -> None:
    """Consistent copy of `source` to `target` via `sqlite3.Connection.backup`, atomically."""
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".partial")
    partial.unlink(missing_ok=True)
    # Read-only, so a backup can never create or change the live database.
    src = sqlite3.connect(f"{source.resolve().as_uri()}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(partial)
        try:
            src.backup(dst)
        finally:
            dst.close()
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    finally:
        src.close()
    os.replace(partial, target)


def _write(name: str) -> Path | None:
    """Copy the live database to `name` in the backup folder (or the fallback folder).

    Returns the new file, or None if there is no database yet. Raises if both folders fail.
    """
    source = config.db_path()
    if not source.is_file():
        log.info("No database yet at %s, so there is nothing to back up", source)
        return None
    try:
        target = config.backup_dir() / name
        _copy_database(source, target)
    except OSError as exc:
        target = fallback_dir() / name
        log.warning(
            "Couldn't write the backup to %s (%s); saving it to %s instead",
            config.backup_dir(),
            exc,
            target.parent,
        )
        _copy_database(source, target)
    log.info("Backup saved: %s", target)
    return target


def _unique_name(prefix: str, now: dt.datetime) -> str:
    """`records-<prefix>-YYYYMMDD-HHMMSS.db`, with `-2`, `-3`... if that second is taken."""
    stem = f"records-{prefix}-{now:%Y%m%d-%H%M%S}"
    name, n = f"{stem}.db", 1
    while any((d / name).exists() for d in (config.backup_dir(), fallback_dir())):
        n += 1
        name = f"{stem}-{n}.db"
    return name


def backup(reason: str, now: dt.datetime | None = None) -> Path | None:
    """A one-off backup that is never deleted automatically. None if there's no database yet."""
    if reason not in REASONS:
        raise ValueError(f"reason must be one of {', '.join(REASONS)}, not {reason!r}")
    return _write(_unique_name(reason, now or dt.datetime.now()))


def prune_daily(keep: int = DAILY_KEEP) -> list[Path]:
    """Delete all but the `keep` newest daily backups (in each folder). Returns what was deleted.

    Only files named exactly `records-YYYY-MM-DD.db` are considered, so pre-update,
    pre-migration and manual backups, and anything the user put there, are never touched.
    """
    deleted: list[Path] = []
    for folder in (config.backup_dir(), fallback_dir()):
        if not folder.is_dir():
            continue
        dailies = sorted(p for p in folder.iterdir() if _DAILY_RE.match(p.name) and p.is_file())
        for old in dailies[:-keep] if keep > 0 else dailies:
            try:
                old.unlink()
                deleted.append(old)
            except OSError as exc:
                log.warning("Couldn't delete old backup %s: %s", old, exc)
    return deleted


def daily_backup(today: dt.date | None = None) -> Path | None:
    """Take today's backup if there isn't one yet, then keep only the newest 30.

    Never raises: a failed daily backup is logged, and the app still opens.
    Returns the new file, or None if nothing was written.
    """
    try:
        name = f"records-{(today or dt.date.today()):%Y-%m-%d}.db"
        if any((d / name).is_file() for d in (config.backup_dir(), fallback_dir())):
            return None
        target = _write(name)
        if target is not None:
            prune_daily()
        return target
    except Exception:
        log.exception("The daily backup failed")
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.backup", description="Back up the Scrappy Records database."
    )
    parser.add_argument("--reason", choices=("manual", "pre-update"), default="manual")
    args = parser.parse_args(argv)
    if sys.stderr is not None:
        logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        target = backup(args.reason)
    except Exception as exc:
        print(f"Backup FAILED: {exc}", file=sys.stderr)
        return 1
    if target is None:
        print(f"No database at {config.db_path()} yet, so there was nothing to back up.")
    else:
        print(f"Backup saved: {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
