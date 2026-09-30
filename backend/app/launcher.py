"""What the Desktop shortcut runs: `pythonw.exe -m app.launcher`.

1. Ask `http://127.0.0.1:<port>/api/health` whether Scrappy Records is already running.
2. If nothing is listening, start the server (`pythonw.exe -m app`) fully detached, so it keeps
   running after this launcher exits, with its raw output going to `logs/server-console.log`.
3. Wait for it to answer (about 20 seconds; longer if it is visibly still starting).
4. Open the default browser at the app.
5. If anything goes wrong, including another program using the port, show a plain-language
   message box that names the log file.

Two launches at once (a double double-click) don't start two servers: the check-and-start step
holds a lock file, so the second launcher waits, sees the server is up and just opens the browser.

Environment switches, for tests and CI:
- `SCRAPPY_NO_BROWSER=1`: don't open the browser.
- `SCRAPPY_NO_DIALOG=1`: don't show message boxes (they would block an unattended run).
Exit code 0 means the app is up; 1 means it isn't.
"""

from __future__ import annotations

import contextlib
import http.client
import json
import logging
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from collections.abc import Iterator
from enum import Enum
from pathlib import Path
from typing import IO

from app import config, logs

log = logging.getLogger("scrappy.launcher")

APP_TITLE = "Scrappy Records"
START_TIMEOUT = 20.0  # seconds to wait for a newly started server...
SLOW_START_TIMEOUT = 60.0  # ...or this long, if it's still running (e.g. a slow first start)
LOCK_TIMEOUT = SLOW_START_TIMEOUT + 15.0
POLL_INTERVAL = 0.25
IS_WINDOWS = sys.platform == "win32"

# Our own copy of the app lives next to this file; the server runs from that folder.
BUNDLE_ROOT = Path(__file__).resolve().parent.parent


class Status(Enum):
    OURS = "ours"  # Scrappy Records answered
    DOWN = "down"  # nothing is listening
    OTHER = "other"  # something else answered, or something is listening but not answering


class LaunchError(Exception):
    """Something the user needs to be told about, in plain words."""


def _flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() not in ("", "0", "false", "no")


def app_url(port: int) -> str:
    return f"http://{config.HOST}:{port}/"


def check_health(port: int, timeout: float = 3.0) -> Status:
    url = f"http://{config.HOST}:{port}/api/health"
    # Never go through a proxy: some laptops have one configured, and it can't reach loopback.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url, timeout=timeout) as response:
            body = json.loads(response.read(64 * 1024).decode("utf-8"))
    except urllib.error.HTTPError:
        return Status.OTHER  # a web server that isn't us (we always answer /api/health)
    except urllib.error.URLError as exc:
        return Status.DOWN if isinstance(exc.reason, ConnectionRefusedError) else Status.OTHER
    except ConnectionRefusedError:
        return Status.DOWN
    except (OSError, http.client.HTTPException, ValueError):
        return Status.OTHER  # something is there, but it isn't answering like we do
    if isinstance(body, dict) and body.get("app") == config.APP_ID:
        return Status.OURS
    return Status.OTHER


def port_is_free(port: int) -> bool:
    """True if nothing is listening on 127.0.0.1:`port` (we could bind it ourselves).

    Quicker than an HTTP check on Windows, where a refused loopback connection takes ~2 s.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        if not IS_WINDOWS:
            # POSIX: don't let connections from a just-stopped server (TIME_WAIT) count as busy.
            # (On Windows this option would let us bind over a live listener, so it stays off.)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((config.HOST, port))
        except OSError:
            return False
    return True


# --------------------------------------------------------------------------- one launcher at a time


@contextlib.contextmanager
def single_instance(timeout: float = LOCK_TIMEOUT) -> Iterator[None]:
    """Hold `logs/launcher.lock` so only one launcher checks-and-starts at a time.

    The OS releases the lock if the process dies, so a crash can't leave it stuck.
    """
    path = config.log_dir() / "launcher.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+b")  # noqa: SIM115 - held for the duration of the block
    deadline = time.monotonic() + timeout
    locked = False
    try:
        while True:
            try:
                _lock(handle)
                locked = True
                break
            except OSError:
                if time.monotonic() >= deadline:
                    log.warning("Another launcher held the lock too long; carrying on anyway")
                    break
                time.sleep(POLL_INTERVAL)
        yield
    finally:
        if locked:
            with contextlib.suppress(OSError):
                _unlock(handle)
        handle.close()


def _lock(handle: IO[bytes]) -> None:
    if IS_WINDOWS:
        import msvcrt

        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock(handle: IO[bytes]) -> None:
    if IS_WINDOWS:
        import msvcrt

        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


# --------------------------------------------------------------------------- starting the server


def server_python() -> str:
    """`pythonw.exe` next to our interpreter on Windows (no console window), else ours."""
    exe = Path(sys.executable)
    if IS_WINDOWS:
        windowless = exe.with_name("pythonw.exe")
        if windowless.is_file():
            return str(windowless)
    return str(exe)


def server_command() -> list[str]:
    return [server_python(), "-m", "app"]


def _open_console_log() -> IO[bytes]:
    """The server's raw stdout/stderr, started fresh for each server so it can't grow forever.

    Nothing is lost: the previous server has stopped, and what it logged is in server.log.
    """
    path = logs.console_log_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    return open(path, "wb")


def start_server(port: int) -> subprocess.Popen[bytes]:
    """Start the server so it outlives this launcher and has no window."""
    env = dict(os.environ)
    env["SCRAPPY_PORT"] = str(port)
    kwargs: dict[str, object] = {}
    if IS_WINDOWS:
        kwargs["creationflags"] = (
            subprocess.DETACHED_PROCESS
            | subprocess.CREATE_NEW_PROCESS_GROUP
            | subprocess.CREATE_NO_WINDOW
        )
    else:
        kwargs["start_new_session"] = True  # not killed with the launcher's terminal
    command = server_command()
    log.info("Starting the server: %s", " ".join(command))
    with _open_console_log() as out:
        return subprocess.Popen(
            command,
            cwd=BUNDLE_ROOT,  # `-m app` then finds this copy, even without the .pth file
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=subprocess.STDOUT,
            close_fds=True,
            **kwargs,  # type: ignore[arg-type]
        )


def _port_in_use_message(port: int) -> str:
    return (
        f"{APP_TITLE} couldn't start because another program is using its connection "
        f"(port {port}).\n\n"
        "Restarting the laptop usually fixes this. Then open Scrappy Records again."
    )


def _looks_like_port_clash() -> bool:
    for path in (logs.console_log_file(), logs.log_file()):
        with contextlib.suppress(OSError):
            with open(path, "rb") as f:
                f.seek(0, os.SEEK_END)
                f.seek(max(0, f.tell() - 8192))
                tail = f.read().decode("utf-8", "replace").lower()
            if "address already in use" in tail or "10048" in tail:
                return True
    return False


def wait_until_up(port: int, proc: subprocess.Popen[bytes] | None) -> None:
    """Poll /api/health until the app answers. Raises LaunchError with a friendly message."""
    started = time.monotonic()
    while True:
        status = check_health(port, timeout=1.0)
        if status is Status.OURS:
            log.info("The server is up after %.1f s", time.monotonic() - started)
            return
        elapsed = time.monotonic() - started
        exited = proc is not None and proc.poll() is not None
        if exited:
            # One more look: another launcher's server may have won the race for the port.
            if check_health(port) is Status.OURS:
                return
            log.error("The server stopped straight away (exit code %s)", proc.returncode)
            if _looks_like_port_clash():
                raise LaunchError(_port_in_use_message(port))
            raise LaunchError(f"{APP_TITLE} couldn't start.")
        still_starting = proc is not None and not exited
        limit = SLOW_START_TIMEOUT if still_starting else START_TIMEOUT
        if elapsed >= limit:
            log.error("The server didn't answer within %.0f s (last check: %s)", elapsed, status)
            raise LaunchError(f"{APP_TITLE} is taking too long to start.")
        time.sleep(POLL_INTERVAL)


def ensure_server(port: int) -> subprocess.Popen[bytes] | None:
    """Make sure the app is answering on `port`. Returns the process if we started one."""
    with single_instance():
        if not port_is_free(port):
            status = check_health(port)
            if status is Status.OURS:
                log.info("Scrappy Records is already running on port %d", port)
                return None
            if status is Status.OTHER:
                log.error("Something else is using port %d", port)
                raise LaunchError(_port_in_use_message(port))
            # DOWN: the port only looked busy (e.g. a server that just stopped). Start ours.
        proc = start_server(port)
        wait_until_up(port, proc)
        return proc


# --------------------------------------------------------------------------- telling the user


def show_message(text: str) -> None:
    """A native message box; falls back to stderr. Never raises."""
    log.info("Message to the user: %s", text.replace("\n", " "))
    if _flag("SCRAPPY_NO_DIALOG"):
        if sys.stderr is not None:
            print(text, file=sys.stderr)
        return
    try:
        if IS_WINDOWS:
            import ctypes

            mb_ok_iconerror_topmost = 0x0 | 0x10 | 0x40000
            ctypes.windll.user32.MessageBoxW(None, text, APP_TITLE, mb_ok_iconerror_topmost)
        elif sys.platform == "darwin":
            script = (
                "on run argv\n"
                f'display dialog (item 1 of argv) with title "{APP_TITLE}" '
                'buttons {"OK"} default button "OK" with icon stop\n'
                "end run"
            )
            subprocess.run(["osascript", "-e", script, text], check=False, timeout=600)
        elif sys.stderr is not None:
            print(text, file=sys.stderr)
    except Exception:
        log.exception("Couldn't show the message box")
        if sys.stderr is not None:
            print(text, file=sys.stderr)


def _with_log_hint(text: str) -> str:
    return (
        f"{text}\n\n"
        "If it keeps happening, send this file to whoever set up the app:\n"
        f"{logs.log_file()}"
    )


def main() -> int:
    logs.ensure_std_streams()
    # If the log folder is unusable, carry on without a log file.
    with contextlib.suppress(Exception):
        logs.setup(rotate=False, console=sys.stderr.isatty())
    try:
        port = config.port()
    except ValueError:
        show_message(
            _with_log_hint(f"{APP_TITLE} couldn't start: SCRAPPY_PORT is not a valid number.")
        )
        return 1
    try:
        ensure_server(port)
    except LaunchError as exc:
        show_message(_with_log_hint(str(exc)))
        return 1
    except Exception as exc:
        log.exception("The launcher failed")
        show_message(_with_log_hint(f"{APP_TITLE} couldn't start ({exc})."))
        return 1

    if _flag("SCRAPPY_NO_BROWSER"):
        log.info("SCRAPPY_NO_BROWSER is set, so not opening the browser")
    elif not webbrowser.open(app_url(port)):
        show_message(
            f"{APP_TITLE} is running, but the browser didn't open.\n\n"
            f"Open your browser and go to {app_url(port)}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
