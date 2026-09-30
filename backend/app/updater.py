"""Updating from inside the app: look for a new version, and install it when the owner asks.

ADR 0006. Two parts:

**The check** (`UpdateChecker`). A background thread (`scrappy-update-check`) asks GitHub for
the latest release (`config.update_feed_url()`: public release information only, no account,
nothing about the owner is sent) when the app starts, then every 12 hours (an hour after a
failed try), and whenever Settings → About → Check for updates is clicked. GitHub's "latest"
skips drafts and prereleases, and the release pipeline only promotes a release to latest after
checking it; a prerelease that shows up anyway is ignored. GitHub allows 60 unauthenticated
requests an hour per address: when it says "wait" (403/429 with its rate-limit headers), the
app waits until the time it gives. The answer is cached in memory; the page reads it from
`GET /api/update`, which never waits for the internet.

**The update** (`UpdateRunner`), when the owner clicks Update now:
1. download the NEW release's installer (`install.ps1` / `install.sh` at the release's tag, so
   installer and release match) into a temporary folder;
2. write `logs/update-attempt.json` (running: from, to, when);
3. start it fully detached (Windows: `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP |
   CREATE_NO_WINDOW`; macOS: a new session), so it survives this server being stopped by that
   same installer, with its output in `logs/update.log`, and `-Version <tag>`;
4. the installer stops the app, backs up, swaps the new version in, and opens it again. It
   knows it was started from here (`SCRAPPY_UPDATE_FROM_APP=1`): if it fails after stopping the
   app, it opens the old version again.
5. The next server to start reads `update-attempt.json`: its own version is the new one →
   succeeded; otherwise → failed. If the installer fails while this server still runs (say the
   download failed), the watcher thread marks it failed straight away.

The page polls `/api/health` until the version changes, then reloads; see
`frontend/src/lib/update.ts`.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import http.client
import json
import logging
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any, Literal

from app import __version__, config, versions
from app.feedback_sender import ssl_context, usable_url
from app.schemas import (
    UpdateAttemptRead,
    UpdateCheckError,
    UpdateInfo,
    UpdateOutcome,
    UpdateReason,
)

log = logging.getLogger("scrappy.update")

CHECK_INTERVAL = 12 * 3600.0  # seconds between checks that worked
RETRY_INTERVAL = 3600.0  # ...and after one that didn't
MAX_WAIT = 24 * 3600.0  # the longest a rate limit can make us wait
TICK_SECONDS = 60.0  # how often the thread looks at the clock (wall clock: laptops sleep)
FEED_TIMEOUT = 15.0
INSTALLER_TIMEOUT = 30.0
PAGE_WAITING_SECONDS = 30.0
NOTES_LIMIT = 4000
_MAX_FEED_BYTES = 2 * 1024 * 1024
_MAX_INSTALLER_BYTES = 2 * 1024 * 1024
_MAX_LOG_BYTES = 1_000_000

UPDATE_LOG = "update.log"
ATTEMPT_FILE = "update-attempt.json"

Platform = Literal["windows", "macos"]
ASSETS: dict[Platform, str] = {
    "windows": "scrappy-records-windows-x64.zip",
    "macos": "scrappy-records-macos-arm64.zip",
}
SCRIPTS: dict[Platform, str] = {"windows": "install.ps1", "macos": "install.sh"}

# Only plain release tags reach a URL or a command line: v1.2.3, nothing else.
_RELEASE_TAG = re.compile(r"^v?\d{1,9}\.\d{1,9}\.\d{1,9}$")


def update_log_file() -> Path:
    return config.log_dir() / UPDATE_LOG


def attempt_file() -> Path:
    return config.log_dir() / ATTEMPT_FILE


def _utcnow() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


# --------------------------------------------------------------------------- where we run


def platform_kind() -> Platform | None:
    """The computers that can update themselves: Windows, and Macs with Apple Silicon."""
    if sys.platform == "win32":
        return "windows"
    if sys.platform == "darwin" and platform.machine() == "arm64":
        return "macos"
    return None


def bundle_root() -> Path:
    """The folder holding `app/`, `python/` and `VERSION` in an installed copy."""
    return Path(__file__).resolve().parent.parent


def installed_bundle() -> Path | None:
    """The installed app folder (`<install root>/app`) this server runs from, or None when it
    runs from a source checkout (dev mode, tests), which must never "update" itself."""
    root = bundle_root()
    kind = platform_kind()
    if kind is None or root.name != "app" or not (root / "VERSION").is_file():
        return None
    python = root / ("python/pythonw.exe" if kind == "windows" else "python/bin/python3")
    return root if python.is_file() else None


# --------------------------------------------------------------------------- the release feed


def plain_notes(text: object, limit: int = NOTES_LIMIT) -> str:
    """A release's notes (GitHub Markdown) as plain text: no headings marks, links, bold or
    HTML; bullets as •; at most `limit` characters."""
    if not isinstance(text, str):
        return ""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    lines = []
    for raw in text.split("\n"):
        line = raw.rstrip()
        line = re.sub(r"^\s{0,3}#{1,6}\s*", "", line)
        line = re.sub(r"^(\s*)[*+-]\s+", r"\1• ", line)
        line = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", line)
        line = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", line)
        line = re.sub(r"(\*\*|__)(.+?)\1", r"\2", line)
        line = re.sub(r"`([^`]*)`", r"\1", line)
        line = re.sub(r"</?[A-Za-z][^>]*>", "", line)
        lines.append(line)
    text = "\n".join(lines)
    text = "".join(ch for ch in text if ch in "\n\t" or (ch.isprintable() and ch != "\u2028"))
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(text) > limit:
        text = text[:limit].rstrip() + "…"
    return text


@dataclass(frozen=True)
class FeedResult:
    """One look at the feed. `ok` means it answered sensibly (even "no release yet")."""

    ok: bool
    latest: str | None = None  # "0.3.0"
    tag: str | None = None  # "v0.3.0", exactly as released
    notes: str = ""
    assets: frozenset[str] = frozenset()
    error: UpdateCheckError | None = None
    retry_after: float = 0.0  # seconds GitHub asked us to wait


def parse_feed(payload: object) -> FeedResult:
    """GitHub's `releases/latest` answer → what we need. A draft, a prerelease or a tag that
    isn't a plain version counts as "no release": never offered."""
    if not isinstance(payload, dict):
        return FeedResult(ok=False, error=UpdateCheckError.bad_answer)
    if payload.get("draft") is True or payload.get("prerelease") is True:
        return FeedResult(ok=True)
    tag = payload.get("tag_name")
    if not isinstance(tag, str) or not _RELEASE_TAG.match(tag.strip()):
        return FeedResult(ok=True)
    tag = tag.strip()
    version = versions.parse(tag)
    if version is None or version.is_prerelease:
        return FeedResult(ok=True)
    assets: set[str] = set()
    raw_assets = payload.get("assets")
    if isinstance(raw_assets, list):
        for asset in raw_assets:
            if not isinstance(asset, dict) or not isinstance(asset.get("name"), str):
                continue
            if asset.get("state", "uploaded") == "uploaded":
                assets.add(asset["name"])
    return FeedResult(
        ok=True,
        latest=str(version),
        tag=tag,
        notes=plain_notes(payload.get("body")),
        assets=frozenset(assets),
    )


def _header_float(headers: Any, name: str) -> float | None:
    try:
        value = headers.get(name) if headers is not None else None
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _rate_limit_wait(status: int, headers: Any, now: float) -> float | None:
    """Seconds GitHub asked us to wait, if this answer is a rate limit (else None)."""
    retry_after = _header_float(headers, "Retry-After")
    remaining = _header_float(headers, "X-RateLimit-Remaining")
    reset = _header_float(headers, "X-RateLimit-Reset")
    if status == 429 or (status == 403 and (remaining == 0 or retry_after is not None)):
        if retry_after is not None:
            wait = retry_after
        elif reset is not None:
            wait = reset - now
        else:
            wait = RETRY_INTERVAL
        return max(60.0, min(wait, MAX_WAIT))
    return None


def fetch_feed(url: str, timeout: float = FEED_TIMEOUT, now: float | None = None) -> FeedResult:
    """GET the feed and say what it means. Never raises."""
    now = time.time() if now is None else now
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": f"scrappy-records/{__version__} (update check)",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        context = ssl_context() if url.startswith("https:") else None
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            raw = response.read(_MAX_FEED_BYTES + 1)
    except urllib.error.HTTPError as e:
        wait = _rate_limit_wait(e.code, e.headers, now)
        if wait is not None:
            log.info("GitHub asked us to wait %.0f s before checking for updates again", wait)
            return FeedResult(ok=False, error=UpdateCheckError.rate_limited, retry_after=wait)
        if e.code == 404:
            return FeedResult(ok=True)  # nothing published yet
        log.info("The update check got HTTP %s", e.code)
        return FeedResult(ok=False, error=UpdateCheckError.bad_answer)
    except (OSError, http.client.HTTPException, ValueError) as e:
        log.info("Couldn't check for updates: %s", getattr(e, "reason", None) or e)
        return FeedResult(ok=False, error=UpdateCheckError.offline)
    if len(raw) > _MAX_FEED_BYTES:
        return FeedResult(ok=False, error=UpdateCheckError.bad_answer)
    try:
        payload = json.loads(raw.decode("utf-8"))
    except ValueError:
        return FeedResult(ok=False, error=UpdateCheckError.bad_answer)
    return parse_feed(payload)


Fetcher = Callable[[str, float, float], FeedResult]


class UpdateChecker:
    """Keeps the latest answer from the feed. `check_now()` asks (tests call it directly);
    `start()` runs a thread that asks when due."""

    def __init__(
        self,
        url: Callable[[], str] = config.update_feed_url,
        fetch: Fetcher = fetch_feed,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.url = url
        self.fetch = fetch
        self.clock = clock
        self.result: FeedResult | None = None  # the last answer that made sense
        self.checked_at: dt.datetime | None = None
        self.error: UpdateCheckError | None = None  # the last try's problem, if it had one
        self.last_try: float | None = None
        self.wait_until = 0.0  # rate limited until then
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def enabled(self) -> bool:
        return usable_url(self.url())

    def _waiting(self, now: float) -> bool:
        """Rate limited: GitHub asked us to wait until `wait_until`. (A wait much longer than
        it could have asked for means the clock went back: stop waiting.)"""
        return now < self.wait_until <= now + MAX_WAIT

    def due(self) -> bool:
        now = self.clock()
        if self._waiting(now):
            return False
        if self.last_try is None or now < self.last_try:  # never tried, or the clock went back
            return True
        interval = CHECK_INTERVAL if self.error is None else RETRY_INTERVAL
        return now - self.last_try >= interval

    def check_now(self) -> None:
        """Ask the feed now (unless it asked us to wait). One at a time: a second caller waits
        for the first one's answer instead of asking again."""
        if not self.enabled:
            return
        if not self._lock.acquire(blocking=False):
            with self._lock:  # someone else is asking: wait for their answer
                return
        try:
            now = self.clock()
            if self._waiting(now):
                self.error = UpdateCheckError.rate_limited
                return
            self.last_try = now
            result = self.fetch(self.url(), FEED_TIMEOUT, now)
            if result.ok:
                self.result = result
                self.checked_at = dt.datetime.fromtimestamp(now, dt.UTC)
                self.error = None
                self.wait_until = 0.0
                if result.latest:
                    log.info("Update check: the latest release is %s", result.latest)
            else:
                self.error = result.error
                if result.retry_after:
                    self.wait_until = now + result.retry_after
        finally:
            self._lock.release()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                if self.due():
                    self.check_now()
            except Exception:
                log.exception("The update check failed")
            self._stop.wait(TICK_SECONDS)

    def start(self) -> UpdateChecker:
        self._thread = threading.Thread(target=self._run, name="scrappy-update-check", daemon=True)
        self._thread.start()
        return self

    def stop(self, timeout: float = 2.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)


# --------------------------------------------------------------------------- the last attempt


@dataclass
class Attempt:
    """`logs/update-attempt.json`. An older app writes it and the newer one reads it, so keep
    these fields and their meaning (docs/runbooks/release.md, "Updating from inside the app")."""

    from_version: str
    to_version: str
    tag: str
    started_at: str  # ISO 8601, UTC
    outcome: str = UpdateOutcome.running.value
    finished_at: str | None = None
    detail: str = ""

    def read(self) -> UpdateAttemptRead | None:
        try:
            return UpdateAttemptRead(
                from_version=self.from_version,
                to_version=self.to_version,
                started_at=dt.datetime.fromisoformat(self.started_at),
                finished_at=dt.datetime.fromisoformat(self.finished_at)
                if self.finished_at
                else None,
                outcome=UpdateOutcome(self.outcome),
                detail=self.detail,
            )
        except ValueError:
            return None


def load_attempt() -> Attempt | None:
    try:
        data = json.loads(attempt_file().read_text(encoding="utf-8"))
        return Attempt(
            from_version=str(data["from_version"]),
            to_version=str(data["to_version"]),
            tag=str(data.get("tag", "")),
            started_at=str(data["started_at"]),
            outcome=str(data.get("outcome", UpdateOutcome.running.value)),
            finished_at=data.get("finished_at") or None,
            detail=str(data.get("detail", "")),
        )
    except (OSError, ValueError, KeyError, TypeError):
        return None


def save_attempt(attempt: Attempt) -> None:
    path = attempt_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    data = asdict(attempt)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _failed_detail(to_version: str, current: str) -> str:
    return (
        f"The update to version {to_version} didn't finish, so you still have version "
        f"{current}. Your records are as they were."
    )


def reconcile_attempt(current: str = __version__) -> Attempt | None:
    """At startup: settle an attempt that was running when the previous server stopped."""
    attempt = load_attempt()
    if attempt is None or attempt.outcome != UpdateOutcome.running.value:
        return attempt
    now = _utcnow().isoformat()
    running, target = versions.parse(current), versions.parse(attempt.to_version)
    if running is not None and target is not None and running >= target:
        attempt = replace(attempt, outcome=UpdateOutcome.succeeded.value, finished_at=now)
        log.info("Updated from %s to %s", attempt.from_version, current)
    else:
        attempt = replace(
            attempt,
            outcome=UpdateOutcome.failed.value,
            finished_at=now,
            detail=_failed_detail(attempt.to_version, current),
        )
        log.warning("The update to %s didn't finish; still on %s", attempt.to_version, current)
    with contextlib.suppress(OSError):
        save_attempt(attempt)
    return attempt


# --------------------------------------------------------------------------- running the installer


class UpdateError(Exception):
    """Something the page shows in plain words. `status` is the HTTP status to answer with."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def download_installer(url: str, dest: Path, timeout: float = INSTALLER_TIMEOUT) -> None:
    """Fetch the installer script to `dest`. Raises UpdateError (424) if it can't: not 502,
    which the page reads as "the app isn't answering"."""
    cant = (
        "Couldn't download the update. Check that the laptop is connected to the internet, "
        "then try again. Nothing was changed."
    )
    if not usable_url(url):
        log.error("The installer address isn't https: %s", url)
        raise UpdateError(424, cant)
    request = urllib.request.Request(
        url, headers={"User-Agent": f"scrappy-records/{__version__} (update)"}
    )
    try:
        context = ssl_context() if url.startswith("https:") else None
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            body = response.read(_MAX_INSTALLER_BYTES + 1)
    except (OSError, http.client.HTTPException, ValueError) as e:
        log.warning("Couldn't download the installer from %s: %s", url, e)
        raise UpdateError(424, cant) from e
    if not body or len(body) > _MAX_INSTALLER_BYTES or body.lstrip()[:1] == b"<":
        # Empty, huge, or a web page (a Wi-Fi login page, an error page) instead of a script.
        log.warning("The installer from %s doesn't look like a script (%d bytes)", url, len(body))
        raise UpdateError(424, cant)
    dest.write_bytes(body)


def _open_update_log() -> Any:
    path = update_log_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        if path.stat().st_size > _MAX_LOG_BYTES:
            os.replace(path, path.with_name(UPDATE_LOG + ".1"))
    return open(path, "ab")  # handed to the installer, closed by the caller


def installer_env(root: Path) -> dict[str, str]:
    """The installer's environment: ours, plus how it was started (the contract with future
    installers, docs/runbooks/release.md)."""
    env = dict(os.environ)
    for name in ("SCRAPPY_INSTALL_VERSION", "SCRAPPY_NO_LAUNCH", "SCRAPPY_AFTER_UPDATE"):
        env.pop(name, None)
    env["SCRAPPY_UPDATE_FROM_APP"] = "1"
    env["SCRAPPY_INSTALL_ROOT"] = str(root.parent)  # update the copy that is running
    zip_path = config.update_zip()
    if zip_path:
        env["SCRAPPY_INSTALL_ZIP"] = zip_path
    else:
        env.pop("SCRAPPY_INSTALL_ZIP", None)
    return env


def installer_command(kind: Platform, script: Path, tag: str) -> list[str]:
    if kind == "windows":
        # (Windows environment names ignore case: this is %SystemRoot%.)
        system_root = Path(os.environ.get("SYSTEMROOT") or r"C:\Windows")
        powershell = system_root / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
        exe = str(powershell) if powershell.is_file() else "powershell.exe"
        return [
            exe,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
            "-Version",
            tag,
        ]
    return ["/bin/sh", str(script), "--version", tag]


def spawn_installer(
    command: list[str], env: dict[str, str], cwd: Path, log_handle: Any
) -> subprocess.Popen[bytes]:
    """Start the installer so it outlives this server (which it is about to stop)."""
    kwargs: dict[str, Any] = {}
    if sys.platform == "win32":
        flags = (
            subprocess.DETACHED_PROCESS
            | subprocess.CREATE_NEW_PROCESS_GROUP
            | subprocess.CREATE_NO_WINDOW
        )
        # Leave any job object we're in (a terminal's), so closing it can't kill the update.
        # Not every job allows that, so try without if it's refused.
        attempts = [flags | subprocess.CREATE_BREAKAWAY_FROM_JOB, flags]
    else:
        kwargs["start_new_session"] = True
        attempts = [0]
    last: OSError | None = None
    for creationflags in attempts:
        try:
            return subprocess.Popen(
                command,
                cwd=cwd,  # never the app folder: Windows can't rename a folder in use
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                close_fds=True,
                creationflags=creationflags,
                **kwargs,
            )
        except OSError as e:
            last = e
    assert last is not None
    raise last


def _installer_problem(code: int) -> str:
    """The installer's own "Details:" line from update.log, if it printed one."""
    with contextlib.suppress(OSError):
        with open(update_log_file(), "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - 8192))
            tail = f.read().decode("utf-8", "replace")
        for line in reversed(tail.splitlines()):
            if line.strip().startswith("Details:"):
                return line.strip()[:300]
    return f"The installer stopped with code {code}."


def _clean_old_temp_folders() -> None:
    with contextlib.suppress(OSError):
        for old in Path(tempfile.gettempdir()).glob("scrappy-update-*"):
            if old.is_dir() and time.time() - old.stat().st_mtime > 24 * 3600:
                shutil.rmtree(old, ignore_errors=True)


class UpdateRunner:
    """Starts the installer, once. `spawn` is replaceable for tests."""

    def __init__(
        self,
        spawn: Callable[[list[str], dict[str, str], Path, Any], Any] = spawn_installer,
        download: Callable[[str, Path], None] = download_installer,
    ) -> None:
        self.spawn = spawn
        self.download = download
        self._lock = threading.Lock()
        self.process: Any = None

    def start(self, kind: Platform, root: Path, tag: str, to_version: str) -> Attempt:
        if not self._lock.acquire(blocking=False):
            raise UpdateError(409, "The update has already started.")
        try:
            current = load_attempt()
            if current is not None and current.outcome == UpdateOutcome.running.value:
                raise UpdateError(409, "The update has already started.")
            _clean_old_temp_folders()
            folder = Path(tempfile.mkdtemp(prefix=f"scrappy-update-{tag}-"))
            script = folder / SCRIPTS[kind]
            self.download(config.update_installer_url(tag, SCRIPTS[kind]), script)
            if kind == "macos":
                script.chmod(0o700)
            attempt = Attempt(
                from_version=__version__,
                to_version=to_version,
                tag=tag,
                started_at=_utcnow().isoformat(),
            )
            save_attempt(attempt)
            command = installer_command(kind, script, tag)
            log.info("Updating from %s to %s: %s", __version__, tag, " ".join(command))
            handle = _open_update_log()
            try:
                header = (
                    f"\n==== {attempt.started_at} Updating from {__version__} to {tag} "
                    f"(started from the app) ====\n"
                )
                handle.write(header.encode("utf-8"))
                handle.flush()
                try:
                    self.process = self.spawn(command, installer_env(root), folder, handle)
                except OSError as e:
                    log.exception("Couldn't start the installer")
                    failed = replace(
                        attempt,
                        outcome=UpdateOutcome.failed.value,
                        finished_at=_utcnow().isoformat(),
                        detail="The update couldn't start. Nothing was changed.",
                    )
                    save_attempt(failed)
                    raise UpdateError(
                        500, "The update couldn't start. Nothing was changed. Try again later."
                    ) from e
            finally:
                handle.close()
            threading.Thread(
                target=self._watch,
                args=(self.process, attempt),
                name="scrappy-update-watch",
                daemon=True,
            ).start()
            return attempt
        finally:
            self._lock.release()

    def _watch(self, process: Any, attempt: Attempt) -> None:
        """If the installer ends while this server still runs, it didn't get as far as
        replacing the app: say so (the installer has already put everything back)."""
        try:
            code = process.wait()
        except Exception:
            log.exception("Lost track of the installer")
            return
        log.info("The installer ended with code %s", code)
        current = load_attempt()
        if current is None or current.started_at != attempt.started_at:
            return
        if current.outcome != UpdateOutcome.running.value:
            return
        problem = _installer_problem(code) if code else "The installer ended without restarting."
        save_attempt(
            replace(
                current,
                outcome=UpdateOutcome.failed.value,
                finished_at=_utcnow().isoformat(),
                detail=f"{_failed_detail(current.to_version, __version__)} {problem}",
            )
        )


# --------------------------------------------------------------------------- all together


class Updater:
    """What the routes talk to: the checker, the runner, and the page-waiting signal."""

    def __init__(
        self,
        checker: UpdateChecker | None = None,
        runner: UpdateRunner | None = None,
        kind: Callable[[], Platform | None] = platform_kind,
        installed: Callable[[], Path | None] = installed_bundle,
    ) -> None:
        self.checker = checker or UpdateChecker()
        self.runner = runner or UpdateRunner()
        self.kind = kind
        self.installed = installed
        self._page_seen = 0.0

    def start(self) -> Updater:
        """At startup: settle the last attempt, then start looking (if checks are on)."""
        reconcile_attempt()
        if self.checker.enabled:
            self.checker.start()
        elif self.checker.url():
            log.warning("Update checks are off: the feed address isn't https")
        return self

    def stop(self) -> None:
        self.checker.stop()

    def note_page_waiting(self) -> None:
        self._page_seen = time.monotonic()

    @property
    def page_waiting(self) -> bool:
        return self._page_seen > 0 and time.monotonic() - self._page_seen < PAGE_WAITING_SECONDS

    def _blocker(self, result: FeedResult | None, available: bool) -> UpdateReason | None:
        attempt = load_attempt()
        if attempt is not None and attempt.outcome == UpdateOutcome.running.value:
            return UpdateReason.updating
        if not self.checker.enabled:
            return UpdateReason.checks_off
        if result is None:
            return UpdateReason.check_failed if self.checker.error else UpdateReason.not_checked_yet
        if not available:
            return UpdateReason.up_to_date
        kind = self.kind()
        if kind is None:
            return UpdateReason.unsupported
        if self.installed() is None:
            return UpdateReason.not_installed
        if ASSETS[kind] not in result.assets:
            return UpdateReason.no_download
        return None

    def info(self) -> UpdateInfo:
        result = self.checker.result
        latest = result.latest if result else None
        available = versions.is_newer(latest, __version__)
        reason = self._blocker(result, available)
        attempt = load_attempt()
        return UpdateInfo(
            current=__version__,
            latest=latest,
            update_available=available,
            notes=result.notes if result and available else "",
            checked_at=self.checker.checked_at,
            can_update=reason is None,
            reason=reason,
            check_error=self.checker.error,
            last_attempt=attempt.read() if attempt else None,
            page_waiting=self.page_waiting,
            log_file=str(update_log_file()),
        )

    def start_update(self, version: str) -> UpdateInfo:
        info = self.info()
        if info.reason is UpdateReason.updating:
            raise UpdateError(409, "The update has already started.")
        if not info.can_update:
            raise UpdateError(409, _cant_update_message(info))
        if versions.parse(version) != versions.parse(info.latest):
            raise UpdateError(
                409,
                f"The newest version is now {info.latest}. Close this and try again.",
            )
        kind, root, result = self.kind(), self.installed(), self.checker.result
        assert kind is not None and root is not None and result is not None and result.tag
        self.runner.start(kind, root, result.tag, str(info.latest))
        return self.info()


def _cant_update_message(info: UpdateInfo) -> str:
    return {
        UpdateReason.up_to_date: "You already have the newest version.",
        UpdateReason.checks_off: "This copy of the app doesn't look for updates.",
        UpdateReason.not_checked_yet: "The app hasn't found out about new versions yet. "
        "Try again in a minute.",
        UpdateReason.check_failed: "The app couldn't check for new versions. Is the internet on?",
        UpdateReason.not_installed: "This copy of the app can't update itself (it isn't an "
        "installed copy).",
        UpdateReason.unsupported: "This computer can't update the app by itself.",
        UpdateReason.no_download: "The new version isn't ready to download yet. Try again later.",
    }.get(info.reason or UpdateReason.up_to_date, "The app can't update right now.")
