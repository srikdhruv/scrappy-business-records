"""What the running server (`python -m app`) does besides answering requests.

- **One server per database.** Before startup (so before any backup or migration), the server
  takes an exclusive lock on `<data folder>/server.lock` and keeps it until it exits. A second
  copy started by mistake (say, a double-click during a very slow first start) finds the lock
  taken, logs that, and exits with code 0 without touching the database. The operating system
  releases the lock if the process dies, so a crash can't leave it stuck. The launcher also
  uses the lock to tell "our server is starting or stuck" from "another program has the port".
- **Polite stop.** The installer asks the server to stop by creating
  `$SCRAPPY_HOME/stop-server.request`. The server notices within a second, finishes what it's
  doing and exits, instead of being killed in the middle of a write.
- **Daily backup while running.** A laptop that only ever sleeps never restarts the server, so
  the server calls `backup.daily_backup()` itself when the date changes (and hourly, in case an
  earlier attempt failed). It's a no-op if today's backup exists.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import logging
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import IO, Protocol

from app import backup, config

log = logging.getLogger("scrappy")

IS_WINDOWS = sys.platform == "win32"
LOCK_FILENAME = "server.lock"
STOP_REQUEST_FILENAME = "stop-server.request"
POLL_SECONDS = 1.0
DAILY_RETRY_SECONDS = 3600.0


# --------------------------------------------------------------------------- file locks


def lock_file(handle: IO[bytes]) -> None:
    """Exclusive, non-blocking lock on `handle`. Raises OSError if someone else holds it."""
    if IS_WINDOWS:
        import msvcrt

        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def unlock_file(handle: IO[bytes]) -> None:
    if IS_WINDOWS:
        import msvcrt

        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def server_lock_path() -> Path:
    return config.data_dir() / LOCK_FILENAME


def acquire_server_lock(wait: float = 3.0) -> IO[bytes] | None:
    """Take the server's lifetime lock, retrying for `wait` seconds (a launcher may be peeking
    at it for an instant). Returns the open handle, which must stay open, or None if another
    server holds it."""
    path = server_lock_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+b")  # noqa: SIM115 - held for the life of the process
    deadline = time.monotonic() + wait
    while True:
        try:
            lock_file(handle)
            return handle
        except OSError:
            if time.monotonic() >= deadline:
                handle.close()
                return None
            time.sleep(0.1)


def server_lock_held() -> bool:
    """True if a Scrappy Records server is running (or starting) for this database."""
    handle = acquire_server_lock(wait=0)
    if handle is None:
        return True
    with contextlib.suppress(OSError):
        unlock_file(handle)
    handle.close()
    return False


# --------------------------------------------------------------------------- housekeeping


def stop_request_path() -> Path:
    return config.home_dir() / STOP_REQUEST_FILENAME


def request_stop() -> Path:
    """Ask a running server to stop (what the installers do). Returns the request file."""
    path = stop_request_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("stop\n", encoding="utf-8")
    return path


class _Server(Protocol):
    started: bool
    should_exit: bool


class Housekeeper:
    """Runs `step()` every second on a daemon thread. Separate from the thread so tests can
    drive it directly."""

    def __init__(
        self,
        server: _Server,
        today: Callable[[], dt.date] = dt.date.today,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.server = server
        self.today = today
        self.clock = clock
        self.last_day = today()  # startup has just taken today's backup
        self.last_try = clock()
        # A request left over from before this server started is not meant for it.
        stop_request_path().unlink(missing_ok=True)

    def step(self) -> None:
        request = stop_request_path()
        if request.exists():
            log.info("Stopping: the installer asked (%s)", request)
            request.unlink(missing_ok=True)
            self.server.should_exit = True
            return
        if not self.server.started:
            return  # startup (backups, migrations) is still running
        today = self.today()
        if today != self.last_day or self.clock() - self.last_try >= DAILY_RETRY_SECONDS:
            self.last_day, self.last_try = today, self.clock()
            backup.daily_backup(today)


def start_housekeeping(server: _Server) -> threading.Event:
    """Start the housekeeping thread. Set the returned event to stop it."""
    keeper = Housekeeper(server)
    done = threading.Event()

    def run() -> None:
        while not done.wait(POLL_SECONDS):
            try:
                keeper.step()
            except Exception:
                log.exception("Housekeeping failed")

    threading.Thread(target=run, name="scrappy-housekeeping", daemon=True).start()
    return done
