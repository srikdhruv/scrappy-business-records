"""Backups of the SQLite database, into the backup folder (`config.backup_dir()`).

| When                          | File                                     | Kept            |
|-------------------------------|------------------------------------------|-----------------|
| First time the server runs on a day | `records-YYYY-MM-DD.db`            | newest 30       |
| Before an update (installer)  | `records-pre-update-YYYYMMDD-HHMMSS.db`   | until deleted   |
| Before a database upgrade     | `records-pre-migration-YYYYMMDD-HHMMSS.db` | until deleted  |
| Before adding an Excel upload | `records-pre-import-YYYYMMDD-HHMMSS.db`   | until deleted   |
| By hand                       | `records-manual-YYYYMMDD-HHMMSS.db`       | until deleted   |

The daily backup is taken at server start, and again by the running server whenever the date
changes (`app.lifetime`), so a laptop that only ever sleeps still gets one a day.

Copies use SQLite's online backup API, so they are consistent even while the server is running.
The live database is opened read-write (never created): if a crash left a "hot" rollback journal
(`records.db-journal`), SQLite rolls the unfinished transaction back first, as it would for the
app. A read-only connection can't do that and fails with "attempt to write a readonly database".
Each copy is written to a temporary name first and renamed into place, so a half-written file
never looks like a finished backup.

If the backup folder can't be written (for example, macOS refuses access to Documents, or
Windows' Controlled Folder Access or a OneDrive lock blocks it), the copy goes to
`<data folder>/backups` instead, and the problem is logged.

Command line (used by the installers before an update):

    python -m app.backup --reason pre-update

Compatibility: `scripts/install.ps1` and `install.sh` always come from `main`, but run this
command with the *installed* (older) bundle's Python. Keep `--reason pre-update` working, with
exit code 0 meaning "backed up, or nothing to back up".
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

from app import config, logs

log = logging.getLogger("scrappy.backup")

DAILY_KEEP = 30
REASONS = ("pre-update", "pre-migration", "pre-import", "manual")
_DAILY_RE = re.compile(r"^records-\d{4}-\d{2}-\d{2}\.db$")


def fallback_dir() -> Path:
    """Used only when the normal backup folder can't be written."""
    return config.data_dir() / "backups"


def _copy_database(source: Path, target: Path) -> None:
    """Consistent copy of `source` to `target` via `sqlite3.Connection.backup`, atomically."""
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".partial")
    partial.unlink(missing_ok=True)
    # mode=rw: never creates the database, but can roll back a hot journal (see the docstring).
    src = sqlite3.connect(f"{source.resolve().as_uri()}?mode=rw", uri=True, timeout=30)
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
    except (OSError, sqlite3.Error) as exc:
        # sqlite3 reports an unwritable folder as "unable to open database file".
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


def prune_daily(keep: int = DAILY_KEEP, protect: Path | None = None) -> list[Path]:
    """Delete all but the `keep` newest daily backups (in each folder). Returns what was deleted.

    "Newest" means most recently written (modification time), not the date in the name: if the
    laptop's clock was wrong (a dead clock battery can put it in 2001), the name would sort
    first and the fresh backup would be pruned at once. `protect` (the backup just written) is
    never deleted and counts as one of the `keep`.

    Only files named exactly `records-YYYY-MM-DD.db` are considered, so pre-update,
    pre-migration and manual backups, and anything the user put there, are never touched.
    """
    deleted: list[Path] = []
    for folder in (config.backup_dir(), fallback_dir()):
        if not folder.is_dir():
            continue
        dailies = [p for p in folder.iterdir() if _DAILY_RE.match(p.name) and p.is_file()]
        protected = [p for p in dailies if protect is not None and p == protect]
        others = sorted(
            (p for p in dailies if p not in protected),
            key=lambda p: (p.stat().st_mtime_ns, p.name),
            reverse=True,  # newest first
        )
        for old in others[max(0, keep - len(protected)) :]:
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
            prune_daily(protect=target)
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
    logs.safe_std_streams()  # the paths printed below may have any letters in them
    if sys.stderr is not None:  # show warnings, e.g. about falling back to data/backups
        logging.basicConfig(level=logging.WARNING, format="%(message)s")
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
