"""Updating from inside the app (ADR 0006): version compare, the release feed, the API's
guards, starting the installer once, and settling the attempt after a restart.

The feed is a fake one: a small HTTP server on 127.0.0.1 that answers as scripted. The
installer is never really run here (CI's install jobs do that, scripts/ci/smoke_in_app_update.py):
starting it is replaced by a fake that records the command.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import hashlib
import http.server
import json
import os
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app import __version__, config, launcher, updater, versions
from app.main import create_app
from app.schemas import UpdateCheckError, UpdateReason
from app.updater import (
    Attempt,
    FeedResult,
    UpdateChecker,
    UpdateError,
    Updater,
    UpdateRunner,
    fetch_feed,
    parse_feed,
    plain_notes,
)

BASE = "http://127.0.0.1:8765"  # the app's own address (SCRAPPY_PORT is unset in tests)
GOOD_HEADERS = {"X-Scrappy-Request": "1", "Content-Type": "application/json"}
NEXT = "99.0.0"  # always newer than the version under test


def release(tag: str = f"v{NEXT}", **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "tag_name": tag,
        "name": tag,
        "draft": False,
        "prerelease": False,
        "body": "## What's new\n* **Faster** reports\n* See [the guide](https://example.com)",
        "html_url": f"https://github.com/example/releases/tag/{tag}",
        "assets": [
            {"name": name, "state": "uploaded"}
            for name in (
                "scrappy-records-windows-x64.zip",
                "scrappy-records-macos-arm64.zip",
                "install.ps1",
                "install.sh",
                "SHA256SUMS",
            )
        ],
    }
    body.update(overrides)
    return body


# --------------------------------------------------------------------------- versions


@pytest.mark.parametrize(
    ("older", "newer"),
    [
        ("0.1.0", "0.2.0"),
        ("0.9.0", "0.10.0"),  # numbers, not text
        ("0.2.9", "0.3.0"),
        ("1.9.9", "2.0.0"),
        ("v0.1.0", "0.1.1"),
        ("1.0.0-rc.1", "1.0.0"),
        # semver.org's own example order
        ("1.0.0-alpha", "1.0.0-alpha.1"),
        ("1.0.0-alpha.1", "1.0.0-alpha.beta"),
        ("1.0.0-alpha.beta", "1.0.0-beta"),
        ("1.0.0-beta", "1.0.0-beta.2"),
        ("1.0.0-beta.2", "1.0.0-beta.11"),
        ("1.0.0-beta.11", "1.0.0-rc.1"),
        ("0.0.0+unknown", "0.0.1"),
    ],
)
def test_version_order(older: str, newer: str) -> None:
    assert versions.parse(older) < versions.parse(newer)  # type: ignore[operator]
    assert versions.is_newer(newer, older)
    assert not versions.is_newer(older, newer)


def test_versions_equal_and_odd_input() -> None:
    assert versions.parse("0.2.0") == versions.parse("v0.2.0") == versions.parse("0.2.0+abc")
    assert not versions.is_newer("0.2.0", "0.2.0")
    for bad in ("", "1", "1.2", "1.2.3.4", "01.2.3", "1.2.3-", "x1.2.3", "1.2.3 ", None, 3):
        if bad == "1.2.3 ":
            assert versions.parse(bad) is not None  # surrounding spaces are fine
            continue
        assert versions.parse(bad) is None, bad
    assert not versions.is_newer("banana", "0.1.0")
    assert not versions.is_newer("0.2.0", None)
    assert versions.parse("1.0.0-rc.1").is_prerelease  # type: ignore[union-attr]
    assert str(versions.parse("v1.2.3-rc.1+x")) == "1.2.3-rc.1"


@given(st.tuples(*[st.integers(0, 50)] * 3), st.tuples(*[st.integers(0, 50)] * 3))
def test_version_compare_matches_tuples(a: tuple[int, ...], b: tuple[int, ...]) -> None:
    va, vb = versions.parse(".".join(map(str, a))), versions.parse(".".join(map(str, b)))
    assert (va < vb) == (a < b)  # type: ignore[operator]
    assert (va == vb) == (a == b)


# --------------------------------------------------------------------------- the feed


def test_parse_feed_reads_version_notes_and_assets() -> None:
    result = parse_feed(release())
    assert result.ok and result.latest == NEXT and result.tag == f"v{NEXT}"
    assert result.notes == "What's new\n• Faster reports\n• See the guide"
    assert "scrappy-records-windows-x64.zip" in result.assets


@pytest.mark.parametrize(
    "payload",
    [
        release(draft=True),
        release(prerelease=True),
        release(tag="v1.0.0-rc.1"),
        release(tag="nightly"),
        release(tag="v1.2.3+build"),
        release(tag="v1.2.3; rm -rf /"),
        release(tag=None),
        {},
    ],
)
def test_parse_feed_ignores_what_isnt_a_finished_release(payload: dict[str, Any]) -> None:
    result = parse_feed(payload)
    assert result.ok and result.latest is None


@pytest.mark.parametrize("payload", [[], "x", None, 3])
def test_parse_feed_bad_shape(payload: object) -> None:
    assert parse_feed(payload) == FeedResult(ok=False, error=UpdateCheckError.bad_answer)


def test_parse_feed_skips_assets_still_uploading_and_odd_ones() -> None:
    result = parse_feed(
        release(
            assets=[
                {"name": "scrappy-records-windows-x64.zip", "state": "starter"},
                {"name": 3},
                "x",
                {"name": "scrappy-records-macos-arm64.zip"},
            ]
        )
    )
    assert result.assets == frozenset({"scrappy-records-macos-arm64.zip"})
    assert parse_feed(release(assets="nope")).assets == frozenset()


def test_plain_notes() -> None:
    md = (
        "<!-- hidden -->## What's Changed\r\n"
        "* feat: `Update now` by @someone in https://github.com/x/pull/9\n\n\n\n"
        "- [link](http://a) and ![pic](http://b) <b>bold</b> __under__\x07\n"
        "**Full Changelog**: https://github.com/x/compare/v0.1.0...v0.2.0"
    )
    assert plain_notes(md) == (
        "What's Changed\n"
        "• feat: Update now by @someone in https://github.com/x/pull/9\n\n"
        "• link and pic bold under\n"
        "Full Changelog: https://github.com/x/compare/v0.1.0...v0.2.0"
    )
    assert plain_notes(None) == ""
    long = plain_notes("x" * 10_000)
    assert len(long) == updater.NOTES_LIMIT + 1 and long.endswith("…")


@dataclass
class FakeFeed:
    """Answers GET with the scripted (status, body, headers), else the release."""

    url: str = ""
    answers: list[tuple[int, bytes, dict[str, str]]] = field(default_factory=list)
    release: dict[str, Any] = field(default_factory=release)
    installer: bytes = b"# Scrappy Records installer\n"
    sums: bytes | None = None  # None: the right SHA256SUMS for `installer`
    requests: list[dict[str, str]] = field(default_factory=list)
    delay: float = 0.0


@pytest.fixture
def feed() -> Iterator[FakeFeed]:
    fake = FakeFeed()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            fake.requests.append({"path": self.path, **dict(self.headers)})
            if fake.delay:
                time.sleep(fake.delay)
            if self.path.startswith("/installer/"):
                status, body, headers = 200, fake.installer, {}
            elif self.path.startswith("/download/") and self.path.endswith("/SHA256SUMS"):
                right = f"{hashlib.sha256(fake.installer).hexdigest()}  install.ps1\n".encode()
                status, body, headers = 200, right if fake.sums is None else fake.sums, {}
            elif self.path.startswith("/download/") and self.path.endswith("/install.ps1"):
                status, body, headers = 200, fake.installer, {}
            elif self.path.startswith("/download/"):
                status, body, headers = 404, b"Not Found", {}
            elif fake.answers:
                status, body, headers = fake.answers.pop(0)
            else:
                status, body, headers = 200, json.dumps(fake.release).encode(), {}
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: object) -> None:
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    fake.url = f"http://127.0.0.1:{server.server_address[1]}/releases/latest"
    yield fake
    server.shutdown()
    server.server_close()


def test_fetch_feed_ok_and_sends_a_user_agent(feed: FakeFeed) -> None:
    result = fetch_feed(feed.url)
    assert result.ok and result.latest == NEXT
    [request] = feed.requests
    assert request["User-Agent"].startswith(f"scrappy-records/{__version__}")
    assert request["Accept"] == "application/vnd.github+json"
    assert "Authorization" not in request  # unauthenticated: nothing about the owner goes out


def test_fetch_feed_failures(feed: FakeFeed) -> None:
    now = 1_000_000.0
    feed.answers = [
        (200, b"{not json", {}),
        (404, b"{}", {}),  # nothing released yet
        (403, b"{}", {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": str(int(now + 1800))}),
        (429, b"{}", {"Retry-After": "120"}),
        (403, b"{}", {}),  # some other refusal: not a rate limit
        (500, b"oops", {}),
        (200, b"x" * (3 * 1024 * 1024), {}),
        (200, "é".encode("latin-1"), {}),
    ]
    assert fetch_feed(feed.url, now=now) == FeedResult(False, error=UpdateCheckError.bad_answer)
    assert fetch_feed(feed.url, now=now) == FeedResult(ok=True)
    limited = fetch_feed(feed.url, now=now)
    assert limited.error is UpdateCheckError.rate_limited and limited.retry_after == 1800
    limited = fetch_feed(feed.url, now=now)
    assert limited.error is UpdateCheckError.rate_limited and limited.retry_after == 120
    for _ in range(4):
        assert fetch_feed(feed.url, now=now).error is UpdateCheckError.bad_answer


def test_fetch_feed_offline_and_timeout(feed: FakeFeed) -> None:
    closed = "http://127.0.0.1:9/releases/latest"
    assert fetch_feed(closed).error is UpdateCheckError.offline
    feed.delay = 1.0
    assert fetch_feed(feed.url, timeout=0.2).error is UpdateCheckError.offline


class Clock:
    def __init__(self, now: float = 1_000_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def scripted(*results: FeedResult) -> tuple[list[float], Any]:
    calls: list[float] = []
    queue = list(results)

    def fetch(url: str, timeout: float, now: float) -> FeedResult:
        calls.append(now)
        return queue.pop(0) if queue else FeedResult(ok=True, latest=NEXT, tag=f"v{NEXT}")

    return calls, fetch


def test_checker_schedule_and_rate_limit() -> None:
    clock = Clock()
    offline = FeedResult(ok=False, error=UpdateCheckError.offline)
    limited = FeedResult(ok=False, error=UpdateCheckError.rate_limited, retry_after=7200)
    calls, fetch = scripted(offline, FeedResult(ok=True, latest=NEXT, tag=f"v{NEXT}"), limited)
    checker = UpdateChecker(url=lambda: "https://example.com/feed", fetch=fetch, clock=clock)
    assert checker.due()  # at startup
    checker.check_now()
    assert checker.error is UpdateCheckError.offline and checker.result is None
    clock.now += updater.RETRY_INTERVAL - 1
    assert not checker.due()
    clock.now += 1
    assert checker.due()  # an hour after a failure
    checker.check_now()
    assert checker.result and checker.result.latest == NEXT and checker.error is None
    assert checker.checked_at == dt.datetime.fromtimestamp(clock.now, dt.UTC)
    clock.now += updater.CHECK_INTERVAL - 1
    assert not checker.due()
    clock.now += 1
    assert checker.due()  # every 12 hours
    checker.check_now()
    assert checker.error is UpdateCheckError.rate_limited
    assert checker.result and checker.result.latest == NEXT  # the last good answer is kept
    # Rate limited for two hours: neither the schedule nor a click asks GitHub again.
    clock.now += updater.RETRY_INTERVAL
    assert not checker.due()
    checker.check_now()
    assert len(calls) == 3
    clock.now += updater.RETRY_INTERVAL
    assert checker.due()
    checker.check_now()
    assert len(calls) == 4 and checker.error is None
    # The clock set back (a flat battery) doesn't stop checks forever.
    clock.now -= 10 * 24 * 3600
    assert checker.due()


def test_checker_off_when_url_empty_or_not_https() -> None:
    calls, fetch = scripted()
    for url in ("", "http://example.com/feed", "ftp://x"):
        checker = UpdateChecker(url=lambda url=url: url, fetch=fetch)
        assert not checker.enabled
        checker.check_now()
    assert calls == []


def test_checker_two_clicks_at_once_ask_once() -> None:
    started = threading.Event()
    release_it = threading.Event()
    calls: list[int] = []

    def slow_fetch(url: str, timeout: float, now: float) -> FeedResult:
        calls.append(1)
        started.set()
        release_it.wait(5)
        return FeedResult(ok=True, latest=NEXT, tag=f"v{NEXT}")

    checker = UpdateChecker(url=lambda: "https://example.com/f", fetch=slow_fetch)
    first = threading.Thread(target=checker.check_now)
    first.start()
    started.wait(5)
    second = threading.Thread(target=checker.check_now)
    second.start()
    time.sleep(0.1)
    release_it.set()
    first.join(5)
    second.join(5)
    assert len(calls) == 1 and checker.result is not None


# --------------------------------------------------------------------------- the API


@dataclass
class FakeProcess:
    code: int | None = None
    done: threading.Event = field(default_factory=threading.Event)

    def wait(self) -> int:
        self.done.wait(10)
        return self.code if self.code is not None else 0


@dataclass
class Spawned:
    calls: list[tuple[list[str], dict[str, str], Path]] = field(default_factory=list)
    process: FakeProcess = field(default_factory=FakeProcess)
    error: OSError | None = None

    def __call__(self, command: list[str], env: dict[str, str], cwd: Path, log: Any) -> Any:
        if self.error:
            raise self.error
        self.calls.append((command, env, cwd))
        return self.process


@dataclass
class Rig:
    client: TestClient
    updater: Updater
    spawned: Spawned
    root: Path
    downloads: list[str]


@pytest.fixture
def rig(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Rig]:
    """The app, with a feed that says 99.0.0 is out, "installed" in a temp folder on Windows,
    and the installer's download and start replaced by fakes."""
    root = tmp_path / "ScrappyRecords" / "app"
    root.mkdir(parents=True)
    spawned = Spawned()
    downloads: list[str] = []

    def download(tag: str, name: str, dest: Path) -> None:
        downloads.append(f"{tag}/{name}")
        dest.write_text("# installer\n")

    checker = UpdateChecker(
        url=lambda: "https://example.com/releases/latest",
        fetch=lambda url, timeout, now: parse_feed(release()),
    )
    fake = Updater(
        checker=checker,
        runner=UpdateRunner(spawn=spawned, download=download),
        kind=lambda: "windows",
        installed=lambda: root,
    )
    monkeypatch.setattr(updater, "Updater", lambda: fake)
    with TestClient(create_app(), base_url=BASE) as client:
        checker.check_now()
        yield Rig(client, fake, spawned, root, downloads)
    spawned.process.done.set()


def test_get_update_with_checks_off(client: TestClient) -> None:
    info = client.get("/api/update").json()
    assert info == {
        "current": __version__,
        "latest": None,
        "update_available": False,
        "notes": "",
        "checked_at": None,
        "can_update": False,
        "reason": "checks_off",
        "check_error": None,
        "last_attempt": None,
        "page_waiting": False,
        "log_file": str(config.log_dir() / "update.log"),
    }


def test_get_update_says_a_new_version_is_ready(rig: Rig) -> None:
    info = rig.client.get("/api/update").json()
    assert info["latest"] == NEXT and info["update_available"] is True
    assert info["can_update"] is True and info["reason"] is None
    assert info["notes"].startswith("What's new")
    assert info["checked_at"].endswith("Z")


@pytest.mark.parametrize(
    ("change", "reason"),
    [
        ({"kind": lambda: None}, UpdateReason.unsupported),
        ({"installed": lambda: None}, UpdateReason.not_installed),
    ],
)
def test_reasons_it_cant_update(rig: Rig, change: dict[str, Any], reason: UpdateReason) -> None:
    for name, value in change.items():
        setattr(rig.updater, name, value)
    info = rig.client.get("/api/update").json()
    assert info["update_available"] is True
    assert (info["can_update"], info["reason"]) == (False, reason.value)
    response = rig.client.post("/api/update/start", json={"version": NEXT}, headers=GOOD_HEADERS)
    assert response.status_code == 409
    assert rig.spawned.calls == []


def test_reason_no_download_and_up_to_date(rig: Rig) -> None:
    rig.updater.checker.fetch = lambda url, timeout, now: parse_feed(release(assets=[]))
    rig.updater.checker.check_now()
    assert rig.client.get("/api/update").json()["reason"] == "no_download"
    rig.updater.checker.fetch = lambda url, timeout, now: parse_feed(release(f"v{__version__}"))
    rig.updater.checker.check_now()
    info = rig.client.get("/api/update").json()
    assert (info["update_available"], info["reason"], info["notes"]) == (False, "up_to_date", "")
    rig.updater.checker.fetch = lambda url, timeout, now: parse_feed(release(prerelease=True))
    rig.updater.checker.check_now()
    assert rig.client.get("/api/update").json()["reason"] == "up_to_date"


def test_not_checked_yet_then_check_now(rig: Rig) -> None:
    rig.updater.checker.result = None
    rig.updater.checker.checked_at = None
    assert rig.client.get("/api/update").json()["reason"] == "not_checked_yet"
    offline = FeedResult(ok=False, error=UpdateCheckError.offline)
    rig.updater.checker.fetch = lambda url, timeout, now: offline
    info = rig.client.post("/api/update/check", headers=GOOD_HEADERS).json()
    assert (info["reason"], info["check_error"]) == ("check_failed", "offline")
    rig.updater.checker.fetch = lambda url, timeout, now: parse_feed(release())
    info = rig.client.post("/api/update/check", headers=GOOD_HEADERS).json()
    assert info["can_update"] is True and info["check_error"] is None


# ---- the guards: only the app's own page can start an update ------------------------------------


@pytest.mark.parametrize(
    ("headers", "status"),
    [
        ({"Content-Type": "application/json"}, 403),  # no custom header
        ({"X-Scrappy-Request": "0", "Content-Type": "application/json"}, 403),
        ({"X-Scrappy-Request": "1", "Content-Type": "text/plain"}, 415),  # a form can send this
        ({"X-Scrappy-Request": "1", "Content-Type": "application/x-www-form-urlencoded"}, 415),
        ({"X-Scrappy-Request": "1", "Content-Type": "multipart/form-data; boundary=x"}, 415),
        ({"X-Scrappy-Request": "1"}, 415),
        ({**GOOD_HEADERS, "Origin": "https://evil.example"}, 403),
        ({**GOOD_HEADERS, "Origin": "http://127.0.0.1:9999"}, 403),
        ({**GOOD_HEADERS, "Origin": "null"}, 403),
        ({**GOOD_HEADERS, "Host": "evil.example"}, 403),  # DNS rebinding
        ({**GOOD_HEADERS, "Host": "127.0.0.1:9999"}, 403),
        ({**GOOD_HEADERS, "Sec-Fetch-Site": "cross-site"}, 403),
        ({**GOOD_HEADERS, "Sec-Fetch-Site": "same-site"}, 403),
    ],
)
@pytest.mark.parametrize("path", ["/api/update/start", "/api/update/check"])
def test_guards_refuse_other_websites(
    rig: Rig, path: str, headers: dict[str, str], status: int
) -> None:
    response = rig.client.post(path, content=json.dumps({"version": NEXT}), headers=headers)
    assert response.status_code == status, response.text
    assert isinstance(response.json()["detail"], str)
    assert rig.spawned.calls == [] and rig.downloads == []


@pytest.mark.parametrize(
    "extra",
    [
        {},
        {"Origin": BASE},
        {"Origin": "http://localhost:8765", "Host": "localhost:8765"},
        {"Sec-Fetch-Site": "same-origin", "Origin": BASE},
        {"Content-Type": "application/json; charset=utf-8"},
    ],
)
def test_guards_let_the_app_through(rig: Rig, extra: dict[str, str]) -> None:
    response = rig.client.post("/api/update/check", headers={**GOOD_HEADERS, **extra})
    assert response.status_code == 200, response.text


# ---- starting it ---------------------------------------------------------------------------


def test_start_runs_the_new_releases_installer_detached(rig: Rig) -> None:
    response = rig.client.post("/api/update/start", json={"version": NEXT}, headers=GOOD_HEADERS)
    assert response.status_code == 202, response.text
    info = response.json()
    assert (info["can_update"], info["reason"]) == (False, "updating")
    assert info["last_attempt"]["outcome"] == "running"
    assert info["last_attempt"]["from_version"] == __version__
    assert info["last_attempt"]["to_version"] == NEXT
    # The installer comes from the NEW release's own files.
    assert rig.downloads == [f"v{NEXT}/install.ps1"]
    [(command, env, cwd)] = rig.spawned.calls
    assert command[0].lower().endswith("powershell.exe")
    assert command[1:7] == [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(cwd / "install.ps1"),
    ]
    assert command[7:] == ["-Version", f"v{NEXT}"]
    assert env["SCRAPPY_UPDATE_FROM_APP"] == "1"
    assert env["SCRAPPY_INSTALL_ROOT"] == str(rig.root.parent)
    assert rig.root not in (cwd, *cwd.parents)  # never inside the app folder being replaced
    saved = json.loads((config.log_dir() / "update-attempt.json").read_text())
    assert saved["outcome"] == "running" and saved["tag"] == f"v{NEXT}"
    log = (config.log_dir() / "update.log").read_text()
    assert f"Updating from {__version__} to v{NEXT}" in log


def test_double_click_starts_one_update(rig: Rig) -> None:
    first = rig.client.post("/api/update/start", json={"version": NEXT}, headers=GOOD_HEADERS)
    second = rig.client.post("/api/update/start", json={"version": NEXT}, headers=GOOD_HEADERS)
    assert (first.status_code, second.status_code) == (202, 409)
    assert second.json()["detail"] == "The update has already started."
    assert len(rig.spawned.calls) == 1


def test_many_clicks_at_once_start_one_update(rig: Rig) -> None:
    results: list[int] = []

    def click() -> None:
        r = rig.client.post("/api/update/start", json={"version": NEXT}, headers=GOOD_HEADERS)
        results.append(r.status_code)

    threads = [threading.Thread(target=click) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert sorted(results) == [202] + [409] * 7
    assert len(rig.spawned.calls) == 1


def test_start_only_the_version_the_page_showed(rig: Rig) -> None:
    for version in ("98.0.0", "banana", ""):
        response = rig.client.post(
            "/api/update/start", json={"version": version}, headers=GOOD_HEADERS
        )
        assert response.status_code in (409, 422), version
    response = rig.client.post(
        "/api/update/start", json={"version": "v99.0.0"}, headers=GOOD_HEADERS
    )
    assert response.status_code == 202


def test_start_download_fails_changes_nothing(rig: Rig) -> None:
    def fail(tag: str, name: str, dest: Path) -> None:
        raise UpdateError(424, "Couldn't download the update. Nothing was changed.")

    rig.updater.runner.download = fail
    response = rig.client.post("/api/update/start", json={"version": NEXT}, headers=GOOD_HEADERS)
    assert response.status_code == 424
    assert "Nothing was changed" in response.json()["detail"]
    assert rig.spawned.calls == []
    assert not (config.log_dir() / "update-attempt.json").exists()
    assert rig.client.get("/api/update").json()["can_update"] is True  # can try again


def test_start_spawn_fails_is_recorded(rig: Rig) -> None:
    rig.spawned.error = OSError("no powershell")
    response = rig.client.post("/api/update/start", json={"version": NEXT}, headers=GOOD_HEADERS)
    assert response.status_code == 500
    info = rig.client.get("/api/update").json()
    assert info["last_attempt"]["outcome"] == "failed" and info["can_update"] is True


def test_installer_failing_while_the_app_runs_is_reported(rig: Rig) -> None:
    rig.client.post("/api/update/start", json={"version": NEXT}, headers=GOOD_HEADERS)
    with open(config.log_dir() / "update.log", "a", encoding="utf-8") as f:
        f.write(
            "Sorry, Scrappy Records was NOT installed.\n"
            "Details: The remote name could not be resolved\n"
        )
    rig.spawned.process.code = 1
    rig.spawned.process.done.set()
    for _ in range(100):
        attempt = rig.client.get("/api/update").json()["last_attempt"]
        if attempt["outcome"] != "running":
            break
        time.sleep(0.05)
    assert attempt["outcome"] == "failed"
    # Plain words for the owner; the installer's own line kept apart, for whoever helps.
    assert attempt["detail"] == (
        f"The update to version {NEXT} didn't finish, so you still have version {__version__}. "
        "Your records are as they were."
    )
    assert attempt["technical"] == "Details: The remote name could not be resolved"
    assert attempt["finished_at"] is not None
    # And it can be tried again.
    assert rig.client.get("/api/update").json()["can_update"] is True


def test_installer_env_and_command(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SCRAPPY_NO_LAUNCH", "1")
    monkeypatch.setenv("SCRAPPY_INSTALL_VERSION", "v0.0.1")
    monkeypatch.setenv("SCRAPPY_INSTALL_ZIP", "/somewhere/old.zip")
    monkeypatch.setenv("SCRAPPY_AFTER_UPDATE", "1")
    root = tmp_path / "Root" / "app"
    env = updater.installer_env(root, "v1.2.3")
    assert env["SCRAPPY_UPDATE_FROM_APP"] == "1"
    assert env["SCRAPPY_INSTALL_ROOT"] == str(tmp_path / "Root")
    for gone in (
        "SCRAPPY_NO_LAUNCH",
        "SCRAPPY_INSTALL_VERSION",
        "SCRAPPY_INSTALL_ZIP",
        "SCRAPPY_AFTER_UPDATE",
    ):
        assert gone not in env
    # A local release server (CI) only in test mode.
    monkeypatch.setenv("SCRAPPY_UPDATE_DOWNLOAD_URL", "http://127.0.0.1:5/download/{tag}")
    assert "SCRAPPY_INSTALL_DOWNLOAD_URL" not in updater.installer_env(root, "v1.2.3")
    monkeypatch.setenv("SCRAPPY_TEST_MODE", "1")
    env = updater.installer_env(root, "v1.2.3")
    assert env["SCRAPPY_INSTALL_DOWNLOAD_URL"] == "http://127.0.0.1:5/download/v1.2.3/"
    script = tmp_path / "install.sh"
    assert updater.installer_command("macos", script, "v1.2.3") == [
        "/bin/sh",
        str(script),
        "--version",
        "v1.2.3",
    ]


def test_install_root_is_spelled_as_our_python_was_started(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = tmp_path / "real" / "Root"
    app_dir = real / "app"
    if sys.platform == "win32":
        # Windows: always the resolved folder (the installer compares long names itself).
        assert updater.install_root(app_dir) == real
        return
    python = app_dir / "python/bin/python3"
    python.parent.mkdir(parents=True)
    python.write_text("")
    link = tmp_path / "link"
    try:
        link.symlink_to(tmp_path / "real", target_is_directory=True)
    except OSError:
        pytest.skip("can't make a symlink here")
    started_as = link / "Root" / python.relative_to(real)
    monkeypatch.setattr(sys, "executable", str(started_as))
    # The bundle's own path is resolved (/private/var/...); the processes were started as
    # /var/...: the installer must be given the second.
    assert updater.install_root(app_dir.resolve()) == link / "Root"
    monkeypatch.setattr(sys, "executable", "/usr/bin/python3")  # not ours: the bundle's parent
    assert updater.install_root(app_dir) == real


def test_release_files_url_and_its_test_override(monkeypatch: pytest.MonkeyPatch) -> None:
    real = f"https://github.com/{config.REPO}/releases/download/v1.2.3/"
    assert config.update_download_url("v1.2.3") == real
    monkeypatch.setenv("SCRAPPY_UPDATE_DOWNLOAD_URL", "http://127.0.0.1:5/d/{tag}")
    assert config.update_download_url("v1.2.3") == real  # ignored outside test mode
    monkeypatch.setenv("SCRAPPY_TEST_MODE", "1")
    assert config.update_download_url("v1.2.3") == "http://127.0.0.1:5/d/v1.2.3/"


def test_plain_http_only_in_test_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    assert updater.update_url_ok("https://api.github.com/x")
    assert not updater.update_url_ok("http://127.0.0.1:5/feed")
    checker = UpdateChecker(url=lambda: "http://127.0.0.1:5/feed")
    assert not checker.enabled
    monkeypatch.setenv("SCRAPPY_TEST_MODE", "1")
    assert updater.update_url_ok("http://127.0.0.1:5/feed")
    assert not updater.update_url_ok("http://example.com/feed")
    assert checker.enabled


def test_parse_sums() -> None:
    a, b = "a" * 64, "B" * 64
    text = f"{a}  install.ps1\n{b} *scrappy-records-windows-x64.zip\nnot a line\n{'c' * 63}  x\n"
    assert updater.parse_sums(text) == {
        "install.ps1": a,
        "scrappy-records-windows-x64.zip": b.lower(),
    }


def test_download_installer_checks_it_against_the_release(
    feed: FakeFeed, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = feed.url.rsplit("/releases", 1)[0]
    monkeypatch.setenv("SCRAPPY_TEST_MODE", "1")
    monkeypatch.setenv("SCRAPPY_UPDATE_DOWNLOAD_URL", f"{base}/download/{{tag}}/")
    dest = tmp_path / "install.ps1"
    updater.download_installer("v1.2.3", "install.ps1", dest)
    assert dest.read_bytes() == feed.installer
    assert [r["path"] for r in feed.requests] == [
        "/download/v1.2.3/SHA256SUMS",
        "/download/v1.2.3/install.ps1",
    ]
    dest.unlink()
    for sums in (
        f"{'0' * 64}  install.ps1\n".encode(),  # someone else's file
        f"{hashlib.sha256(feed.installer).hexdigest()}  install.sh\n".encode(),  # no entry
        b"",  # empty
    ):
        feed.sums = sums
        with pytest.raises(UpdateError) as e:
            updater.download_installer("v1.2.3", "install.ps1", dest)
        assert e.value.status == 424
        assert "Nothing was changed" in str(e.value)
        assert not dest.exists()  # never written, so never run
    feed.sums = None
    with pytest.raises(UpdateError):
        updater.download_installer("v1.2.3", "install.sh", dest)  # no such file: 404
    monkeypatch.delenv("SCRAPPY_TEST_MODE")
    with pytest.raises(UpdateError):
        updater.download_installer("v1.2.3", "install.ps1", dest)  # real GitHub, not reachable


def test_spawn_installer_really_detaches(tmp_path: Path) -> None:
    """A real child process, started the way the installer is (on Windows with the detached
    flags, else in its own session), runs and writes into the log it was given."""
    out = tmp_path / "update.log"
    code = (
        "import os; print('hello from the installer'); "
        "print('own session:', os.name == 'nt' or os.getsid(0) == os.getpid())"
    )
    with open(out, "ab") as handle:
        proc = updater.spawn_installer(
            [sys.executable, "-c", code], dict(os.environ), tmp_path, handle
        )
    assert proc.wait(30) == 0
    text = out.read_text()
    assert "hello from the installer" in text and "own session: True" in text


def test_a_running_update_older_than_30_minutes_has_failed(rig: Rig) -> None:
    rig.client.post("/api/update/start", json={"version": NEXT}, headers=GOOD_HEADERS)
    assert rig.client.get("/api/update").json()["reason"] == "updating"
    # The installer vanished (the laptop was switched off, say): 31 minutes later...
    attempt = updater.load_attempt()
    assert attempt is not None
    long_ago = dt.datetime.now(dt.UTC) - dt.timedelta(minutes=31)
    updater.save_attempt(dataclasses.replace(attempt, started_at=long_ago.isoformat()))
    info = rig.client.get("/api/update").json()
    assert info["last_attempt"]["outcome"] == "failed"
    assert info["last_attempt"]["technical"] == "No word from the installer for 30 minutes."
    assert (info["can_update"], info["reason"]) == (True, None)
    # ...and Update now works again.
    again = rig.client.post("/api/update/start", json={"version": NEXT}, headers=GOOD_HEADERS)
    assert again.status_code == 202
    assert again.json()["last_attempt"]["outcome"] == "running"
    assert len(rig.spawned.calls) == 2


def test_a_running_update_under_30_minutes_is_left_alone() -> None:
    config.log_dir().mkdir(parents=True)
    started = dt.datetime.now(dt.UTC) - dt.timedelta(minutes=29)
    updater.save_attempt(dataclasses.replace(_attempt(NEXT), started_at=started.isoformat()))
    settled = updater.settled_attempt()
    assert settled is not None and settled.outcome == "running"


def test_start_asks_github_again_first(rig: Rig) -> None:
    calls: list[float] = []

    def pulled(url: str, timeout: float, now: float) -> FeedResult:
        calls.append(now)
        return parse_feed(release(f"v{__version__}"))  # 99.0.0 was pulled since the banner

    rig.updater.checker.fetch = pulled
    response = rig.client.post("/api/update/start", json={"version": NEXT}, headers=GOOD_HEADERS)
    assert response.status_code == 409
    assert len(calls) == 1 and rig.spawned.calls == []


def test_start_refuses_when_it_cant_check(rig: Rig) -> None:
    offline = FeedResult(ok=False, error=UpdateCheckError.offline)
    rig.updater.checker.fetch = lambda url, timeout, now: offline
    response = rig.client.post("/api/update/start", json={"version": NEXT}, headers=GOOD_HEADERS)
    assert response.status_code == 424
    assert "Nothing was changed" in response.json()["detail"]
    assert rig.spawned.calls == []


def test_a_release_without_its_installer_or_checksums_isnt_offered(rig: Rig) -> None:
    for missing in ("install.ps1", "SHA256SUMS"):
        assets = [
            {"name": n}
            for n in ("scrappy-records-windows-x64.zip", "install.ps1", "SHA256SUMS")
            if n != missing
        ]
        rig.updater.checker.fetch = lambda url, timeout, now, a=assets: parse_feed(
            release(assets=a)
        )
        rig.updater.checker.check_now()
        assert rig.client.get("/api/update").json()["reason"] == "no_download"


@pytest.mark.parametrize(
    "text", ["\u0661.\u0662.\u0663", "1.\u0662.3", "v\uff11.0.0", "1.0.0-\u0661", "\u0967.0.0"]
)
def test_only_ascii_digits_make_a_version(text: str) -> None:
    assert versions.parse(text) is None
    assert parse_feed(release(tag=text)).latest is None


def test_installed_bundle_only_for_an_installed_copy() -> None:
    # The tests run from a checkout: never "installed", so it can never update itself.
    assert updater.installed_bundle() is None


# ---- after the restart ---------------------------------------------------------------------


def _attempt(to: str, outcome: str = "running") -> Attempt:
    return Attempt(
        from_version="0.1.0",
        to_version=to,
        tag=f"v{to}",
        started_at=dt.datetime(2026, 9, 30, 10, tzinfo=dt.UTC).isoformat(),
        outcome=outcome,
    )


def test_restart_on_the_new_version_is_success() -> None:
    config.log_dir().mkdir(parents=True)
    updater.save_attempt(_attempt(__version__))
    settled = updater.reconcile_attempt()
    assert settled and settled.outcome == "succeeded" and settled.finished_at


def test_restart_on_the_old_version_is_failure() -> None:
    config.log_dir().mkdir(parents=True)
    updater.save_attempt(_attempt(NEXT))
    settled = updater.reconcile_attempt()
    assert settled and settled.outcome == "failed"
    assert settled.detail == (
        f"The update to version {NEXT} didn't finish, so you still have version {__version__}. "
        "Your records are as they were."
    )
    assert updater.load_attempt() == settled
    assert updater.reconcile_attempt() == settled  # settled once


def test_reconcile_without_or_with_a_broken_file() -> None:
    assert updater.reconcile_attempt() is None
    config.log_dir().mkdir(parents=True)
    updater.attempt_file().write_text("{broken")
    assert updater.reconcile_attempt() is None
    updater.attempt_file().write_text('{"from_version": "0.1.0"}')
    assert updater.load_attempt() is None


def test_app_startup_settles_the_attempt(client: TestClient) -> None:
    client.close()
    updater.save_attempt(_attempt(NEXT))
    with TestClient(create_app(), base_url="http://127.0.0.1:8765") as again:
        attempt = again.get("/api/update").json()["last_attempt"]
    assert attempt["outcome"] == "failed" and attempt["to_version"] == NEXT


# ---- the page waiting, and the launcher ----------------------------------------------------------


def test_health_notes_a_waiting_page(rig: Rig) -> None:
    assert rig.client.get("/api/update").json()["page_waiting"] is False
    assert rig.client.get("/api/health").status_code == 200
    assert rig.client.get("/api/update").json()["page_waiting"] is False
    health = rig.client.get("/api/health", params={"waiting_for_update": "true"})
    assert health.json() == {"app": "scrappy-records", "version": __version__, "status": "ok"}
    assert rig.client.get("/api/update").json()["page_waiting"] is True
    assert rig.client.get("/api/health", params={"waiting_for_update": "x"}).status_code == 422


def test_launcher_after_update_skips_the_browser_when_the_page_waits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    answers = iter([b'{"page_waiting": false}', b"not json", b'{"page_waiting": true}'])

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            body = next(answers, b'{"page_waiting": true}')
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: object) -> None:
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        port = server.server_address[1]
        assert launcher.page_is_waiting(port, wait=5)
        assert not launcher.page_is_waiting(launcher_free_port(), wait=0.3)
    finally:
        server.shutdown()
        server.server_close()


def launcher_free_port() -> int:
    import socket

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_launcher_main_after_update(monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[str] = []
    monkeypatch.setattr(launcher, "ensure_server", lambda port: None)
    monkeypatch.setattr(launcher.webbrowser, "open", lambda url: opened.append(url) or True)
    monkeypatch.setenv("SCRAPPY_AFTER_UPDATE", "1")
    monkeypatch.setattr(launcher, "page_is_waiting", lambda port: True)
    assert launcher.main() == 0 and opened == []
    monkeypatch.setattr(launcher, "page_is_waiting", lambda port: False)
    assert launcher.main() == 0 and len(opened) == 1  # the page was closed: open one
    monkeypatch.delenv("SCRAPPY_AFTER_UPDATE")
    monkeypatch.setattr(launcher, "page_is_waiting", lambda port: pytest.fail("not asked"))
    assert launcher.main() == 0 and len(opened) == 2


def test_launcher_doesnt_pass_update_flags_to_the_server(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, str] = {}

    class FakePopen:
        def __init__(self, command: list[str], env: dict[str, str], **kwargs: Any) -> None:
            seen.update(env)

    monkeypatch.setenv("SCRAPPY_AFTER_UPDATE", "1")
    monkeypatch.setenv("SCRAPPY_UPDATE_FROM_APP", "1")
    monkeypatch.setattr(subprocess, "Popen", FakePopen)
    launcher.start_server(12345)
    assert "SCRAPPY_AFTER_UPDATE" not in seen and "SCRAPPY_UPDATE_FROM_APP" not in seen
    assert seen["SCRAPPY_PORT"] == "12345"


# ---- no 500s ------------------------------------------------------------------------------------


anything = st.one_of(
    st.none(),
    st.booleans(),
    st.integers(),
    st.floats(),
    st.text(max_size=50),
    st.lists(st.text(max_size=5), max_size=3),
    st.dictionaries(st.text(max_size=8), st.text(max_size=8), max_size=3),
)


@settings(
    max_examples=200,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow],
)
@given(
    body=st.one_of(anything, st.dictionaries(st.sampled_from(["version", "x"]), anything)),
    headers=st.dictionaries(
        st.sampled_from(["X-Scrappy-Request", "Origin", "Sec-Fetch-Site", "Content-Type"]),
        st.text(st.characters(min_codepoint=32, max_codepoint=126), max_size=30),
        max_size=4,
    ),
    path=st.sampled_from(["/api/update/start", "/api/update/check", "/api/update"]),
)
def test_no_500(rig: Rig, body: Any, headers: dict[str, str], path: str) -> None:
    rig.updater.runner.download = lambda tag, name, dest: (_ for _ in ()).throw(
        UpdateError(424, "no")
    )
    merged = {**GOOD_HEADERS, **headers}
    method = "get" if path == "/api/update" else "post"
    response = rig.client.request(method, path, content=json.dumps(body), headers=merged)
    assert response.status_code < 500, (path, body, headers, response.text)


@settings(max_examples=300, deadline=None)
@given(
    payload=st.recursive(
        anything,
        lambda inner: (
            st.dictionaries(st.text(max_size=12), inner, max_size=6) | st.lists(inner, max_size=4)
        ),
        max_leaves=20,
    )
)
def test_parse_feed_never_raises(payload: Any) -> None:
    result = parse_feed(payload)
    assert result.latest is None or versions.parse(result.latest) is not None
    if isinstance(payload, dict):
        plain_notes(payload.get("body"))
