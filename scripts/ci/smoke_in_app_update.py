"""End-to-end check of "Update now" (ADR 0006) on a real install, on Windows or macOS.

    uv run --project backend python scripts/ci/smoke_in_app_update.py dist/scrappy-records-<os>.zip
    uv run --project backend python scripts/ci/smoke_in_app_update.py <zip> --release-tag v0.3.0

**On every PR** (the windows-install and macos-install jobs) it uses the bundle built from this
commit three ways:

- **A**, the same zip with its `VERSION` changed to 0.0.1 (the "old version");
- **B**, the zip as built (the "new version");
- **C**, a broken "9.9.9": B with `app/__init__.py` raising at import (it can't start).

A local web server stands in for GitHub: the "latest release" feed, and each release's files
(`/download/<tag>/`: the zip, this commit's `install.ps1` / `install.sh`, and `SHA256SUMS`). The
app finds them through `SCRAPPY_UPDATE_FEED_URL` and `SCRAPPY_UPDATE_DOWNLOAD_URL`, which only
work with `SCRAPPY_TEST_MODE=1`. Nothing is handed to the installer as a local zip: it downloads
and checks the zip itself, as on a laptop. In a folder whose name has a space, an apostrophe and
non-English letters, with no developer tools on PATH, it checks:

1. install A with the installer, open it, add a student and a payment;
2. A offers B, and `/api/update/start` refuses other websites;
3. the installer can't be downloaded → 424, nothing changed;
4. the installer isn't what the release's SHA256SUMS says → 424, nothing changed;
5. the zip isn't what SHA256SUMS says → the installer stops before closing the app; "didn't
   finish";
6. the installer fails after its backup (a test hook) → the app is closed, then the old version
   opens again and says the update didn't finish;
7. Update now to C, which can't start → the installer puts A back and opens it; "didn't finish";
8. Update now to B for real: a second start is refused, B answers, the data is there and in a
   pre-update backup, the attempt succeeded, nothing is left behind, the launcher saw the
   waiting page (no second tab);
9. the pasted line's path: installing C over B → C doesn't start → B is put back and opened,
   data intact; and a zip that doesn't match its SHA256SUMS changes nothing.

**Before a release is promoted** (`release.yml`, `--release-tag vX`): only steps 1, 2 and 8,
with the release's real files: the app downloads `install.ps1` / `install.sh` and
`SHA256SUMS` from `https://github.com/.../releases/download/vX/`, and the installer downloads
and checks the real zip. Only the feed is local (a prerelease isn't "latest" yet). A is this
release's zip relabelled 0.0.1; after v0.2.0 exists it should be the real v0.2.0 zip
(docs/runbooks/release.md).
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import http.server
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
IS_WINDOWS = sys.platform == "win32"
SCRIPT = "install.ps1" if IS_WINDOWS else "install.sh"
ASSET = "scrappy-records-windows-x64.zip" if IS_WINDOWS else "scrappy-records-macos-arm64.zip"
OLD_VERSION = "0.0.1"
BROKEN_VERSION = "9.9.9"
NAME = "Ishaan Rao (in-app update test)"
APP_HEADERS = {"Content-Type": "application/json", "X-Scrappy-Request": "1"}
UPDATE_TIMEOUT = 300.0


def step(message: str) -> None:
    print(f"\n=== {message}", flush=True)


class Failed(Exception):
    pass


def fail(message: str) -> None:
    raise Failed(f"IN-APP UPDATE TEST FAILED: {message}")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def rezip(source: Path, target: Path, version: str, broken: bool = False) -> str:
    """Copy the bundle with VERSION set to `version` (and, if `broken`, an app that can't even
    be imported). Returns the bundle's real version."""
    with zipfile.ZipFile(source) as src, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as dst:
        real = src.read("VERSION").decode().strip()
        for info in src.infolist():
            name = info.filename
            if broken and name.startswith("app/__pycache__/__init__."):
                continue  # the precompiled copy would be used instead of the source
            data = src.read(info)
            if name == "VERSION":
                data = version.encode() + b"\n"
            elif broken and name == "app/__init__.py":
                data = b'raise RuntimeError("a deliberately broken bundle")\n' + data
            dst.writestr(info, data)
    return real


# --------------------------------------------------------------------------- the fake GitHub


class FakeGitHub:
    """The latest-release feed, and release files under /download/<tag>/."""

    def __init__(self) -> None:
        self.latest = ""  # the tag the feed offers
        self.files: dict[str, dict[str, bytes]] = {}  # tag -> name -> content
        self.missing: set[str] = set()  # names answered with 404
        self.requests: list[str] = []
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                fake.requests.append(self.path)
                if self.path == "/releases/latest":
                    names = sorted(fake.files.get(fake.latest, {}))
                    body = json.dumps(
                        {
                            "tag_name": fake.latest,
                            "name": fake.latest,
                            "draft": False,
                            "prerelease": False,
                            "body": "## What's new\n* The in-app update test",
                            "assets": [{"name": n, "state": "uploaded"} for n in names],
                        }
                    ).encode()
                    return self._send(200, body)
                parts = self.path.split("/")
                if len(parts) == 4 and parts[1] == "download":
                    tag, name = parts[2], parts[3]
                    content = fake.files.get(tag, {}).get(name)
                    if content is not None and name not in fake.missing:
                        return self._send(200, content)
                self._send(404, b"Not Found")

            def _send(self, status: int, body: bytes) -> None:
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args: object) -> None:
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def release(self, tag: str, zip_path: Path) -> None:
        files = {ASSET: zip_path.read_bytes(), SCRIPT: (REPO / "scripts" / SCRIPT).read_bytes()}
        files["SHA256SUMS"] = "".join(
            f"{sha256(v)}  {k}\n" for k, v in sorted(files.items())
        ).encode()
        self.files[tag] = files


# --------------------------------------------------------------------------- talking to the app

_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(
    port: int, method: str, path: str, body: Any = None, headers: dict[str, str] | None = None
) -> tuple[int, Any]:
    data = (
        None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    )
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, method=method, headers=headers or {}
    )
    try:
        with _opener.open(request, timeout=60) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as e:
        raw, status = e.read(), e.code
    try:
        return status, json.loads(raw) if raw else None
    except ValueError:
        return status, raw.decode("utf-8", "replace")


def health(port: int) -> str | None:
    """The running version, asking as the waiting page does; None if nothing answers."""
    try:
        with _opener.open(
            f"http://127.0.0.1:{port}/api/health?waiting_for_update=true", timeout=3
        ) as response:
            body = json.loads(response.read())
    except (OSError, ValueError):
        return None
    return body.get("version") if body.get("app") == "scrappy-records" else None


def wait_for(what: str, check: Any, timeout: float, logs: list[Path]) -> Any:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(1)
    for log in logs:
        if log.is_file():
            print(f"--- last lines of {log.name}:")
            print("\n".join(log.read_text("utf-8", "replace").splitlines()[-60:]))
    fail(f"timed out waiting for {what}")


def run(
    command: list[str], env: dict[str, str], cwd: Path | None = None, expect_ok: bool = True
) -> str:
    print("$", " ".join(command), flush=True)
    result = subprocess.run(
        command,
        env=env,
        cwd=cwd,
        capture_output=True,
        text=True,
        errors="replace",
        timeout=600,
        check=False,
    )
    output = result.stdout + result.stderr
    print(output, flush=True)
    if expect_ok and result.returncode != 0:
        fail(f"{command[0]} exited with {result.returncode}")
    if not expect_ok and result.returncode == 0:
        fail(f"{command[0]} should have failed")
    return output


def installer(zip_path: Path, root: Path, *, no_launch: bool) -> list[str]:
    """The installer run directly (the pasted line's path), from a local zip."""
    if IS_WINDOWS:
        command = [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(REPO / "scripts" / "install.ps1"),
            "-ZipPath",
            str(zip_path),
            "-InstallRoot",
            str(root),
        ]
        return [*command, "-NoLaunch"] if no_launch else command
    command = ["/bin/sh", str(REPO / "scripts" / "install.sh"), "--zip", str(zip_path)]
    command += ["--install-root", str(root)]
    return [*command, "--no-launch"] if no_launch else command


def clean_env(extra: dict[str, str]) -> dict[str, str]:
    """No developer tools: only the system's own folders on PATH, no virtualenv."""
    if IS_WINDOWS:
        env = {
            k: v
            for k, v in os.environ.items()
            if not k.upper().startswith(("VIRTUAL_ENV", "PYTHON", "UV_", "SCRAPPY_"))
        }
        root = os.environ.get("SYSTEMROOT", r"C:\Windows")
        env["PATH"] = ";".join(
            [rf"{root}\System32", root, rf"{root}\System32\WindowsPowerShell\v1.0"]
        )
    else:
        env = {
            "HOME": os.environ["HOME"],
            "USER": os.environ.get("USER", ""),
            "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "LANG": "en_US.UTF-8",
        }
    env.update(extra)
    return env


def stop_everything(root: Path, port: int) -> None:
    """Stop whatever runs from the test's install: politely, then by force."""
    with contextlib.suppress(OSError):
        (root / "stop-server.request").write_text("stop\n")
    deadline = time.monotonic() + 20
    while health(port) and time.monotonic() < deadline:
        time.sleep(0.5)
    if IS_WINDOWS:
        quoted = str(root).replace("'", "''")
        script = (
            "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and "
            + "$_.ExecutablePath.StartsWith('"
            + quoted
            + "', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { "
            + "Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
        )
        subprocess.run(["powershell", "-NoProfile", "-Command", script], check=False, timeout=60)
    else:
        subprocess.run(["pkill", "-f", str(root / "app" / "python")], check=False)


def update_checked(port: int) -> dict[str, Any] | None:
    status, info = call(port, "POST", "/api/update/check", headers=APP_HEADERS)
    return info if status == 200 and info.get("checked_at") else None


def attempt(port: int) -> dict[str, Any]:
    _, info = call(port, "GET", "/api/update")
    return info.get("last_attempt") or {}


# --------------------------------------------------------------------------- the test


def main() -> int:
    # The folder names have letters a Windows console's code page may not have.
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(errors="backslashreplace")  # type: ignore[union-attr]
    parser = argparse.ArgumentParser()
    parser.add_argument("zip", type=Path, help="the bundle built from this commit")
    parser.add_argument(
        "--release-tag",
        help="check a published (pre)release: the app downloads its real files from GitHub",
    )
    args = parser.parse_args()
    new_zip = args.zip.resolve()
    release_tag: str | None = args.release_tag
    top = Path(tempfile.mkdtemp(prefix="scrappy-inapp-"))
    work = top / f"Scrappy Elève's रिकॉर्ड {uuid.uuid4().hex[:6]}"
    root = work / "ScrappyRecords"
    backups = work / "backups"
    port = free_port()
    marker = work / "fail-after-backup.flag"
    server_log = root / "logs" / "server.log"
    update_log = root / "logs" / "update.log"
    logs = [update_log, server_log]
    work.mkdir(parents=True)
    try:
        step("Make the old version (A): the same bundle, with VERSION 0.0.1")
        old_zip = work / f"old-{ASSET}"
        new_version = rezip(new_zip, old_zip, OLD_VERSION)
        tag = release_tag or f"v{new_version}"
        print(f"new version (B): {new_version} ({tag}); old version (A): {OLD_VERSION}")
        github = FakeGitHub()
        github.latest = tag
        if release_tag:
            # The feed is ours (a prerelease isn't "latest" yet); the files are the real ones.
            github.files[tag] = {ASSET: b"", SCRIPT: b"", "SHA256SUMS": b""}
        else:
            github.release(tag, new_zip)
            broken_zip = work / f"broken-{ASSET}"
            rezip(new_zip, broken_zip, BROKEN_VERSION, broken=True)
            github.release(f"v{BROKEN_VERSION}", broken_zip)

        extra = {
            "SCRAPPY_HOME": str(root),
            "SCRAPPY_BACKUP_DIR": str(backups),
            "SCRAPPY_PORT": str(port),
            "SCRAPPY_NO_BROWSER": "1",
            "SCRAPPY_NO_DIALOG": "1",
            "SCRAPPY_TEST_MODE": "1",
            "SCRAPPY_UPDATE_FEED_URL": f"{github.base}/releases/latest",
            "SCRAPPY_TEST_FAIL_AFTER_BACKUP": str(marker),
            ("SCRAPPY_SHORTCUT_DIR" if IS_WINDOWS else "SCRAPPY_APPS_DIR"): str(
                work / ("Desktop" if IS_WINDOWS else "Applications")
            ),
        }
        if not release_tag:
            extra["SCRAPPY_UPDATE_DOWNLOAD_URL"] = f"{github.base}/download/{{tag}}/"
        env = clean_env(extra)

        step(f"Install A with the real installer into {root}")
        run(installer(old_zip, root, no_launch=True), env)
        app_dir = root / "app"
        python = app_dir / ("python/pythonw.exe" if IS_WINDOWS else "python/bin/python3")

        step("Open A with the launcher; add a student and a payment")
        run([str(python), "-m", "app.launcher"], env, cwd=app_dir)
        if health(port) != OLD_VERSION:
            fail(f"the old version isn't answering (health: {health(port)})")
        _, dashboard = call(port, "GET", "/api/dashboard")
        month = dashboard["current_month"]
        status, student = call(
            port,
            "POST",
            "/api/students",
            {"name": NAME, "monthly_fee_paise": 150000, "joined_month": month},
            {"Content-Type": "application/json"},
        )
        if status != 201:
            fail(f"couldn't add the student: {status} {student}")
        status, payment = call(
            port,
            "POST",
            "/api/payments",
            {
                "student_id": student["id"],
                "amount_paise": 150000,
                "for_month": month,
                "paid_on": dt.datetime.now(dt.UTC).date().isoformat(),
                "method": "upi",
            },
            {"Content-Type": "application/json"},
        )
        if status != 201:
            fail(f"couldn't add the payment: {status} {payment}")

        def data_intact() -> None:
            _, students = call(port, "GET", "/api/students?status=all")
            if NAME not in [s["name"] for s in students]:
                fail("the student is gone")
            _, payments = call(port, "GET", f"/api/payments?student_id={student['id']}")
            if [p["amount_paise"] for p in payments] != [150000]:
                fail(f"the payment isn't as it was: {payments}")

        def servers_started() -> int:
            return server_log.read_text("utf-8", "replace").count("Started server process")

        def offer(version: str) -> dict[str, Any]:
            info = wait_for("the update check", lambda: update_checked(port), 60, logs)
            expected = {
                "current": OLD_VERSION,
                "latest": version,
                "update_available": True,
                "can_update": True,
                "reason": None,
            }
            if any(info.get(k) != v for k, v in expected.items()):
                fail(f"/api/update isn't what it should be: {json.dumps(info, indent=2)}")
            return info

        def start(version: str) -> tuple[int, Any]:
            body = json.dumps({"version": version}).encode()
            return call(port, "POST", "/api/update/start", body, APP_HEADERS)

        def old_back_and_failed(before: int, why: str) -> dict[str, Any]:
            """The app was stopped and started again (a new server), it's A, and it says the
            update didn't finish."""

            def check() -> bool:
                version = health(port)
                if version is None:
                    return False
                if version != OLD_VERSION:
                    fail(f"version {version} came up, expected the old one")
                return attempt(port).get("outcome") == "failed" and servers_started() > before

            wait_for(f"the old version to come back ({why})", check, UPDATE_TIMEOUT, logs)
            last = attempt(port)
            print(json.dumps(last, indent=2))
            if "didn't finish" not in last["detail"]:
                fail(f"the failure isn't in plain words: {last}")
            _, info = call(port, "GET", "/api/update")
            if not info["can_update"]:
                fail("Update now isn't offered again after a failure")
            data_intact()
            return last

        step("A sees B on the (fake) feed and can update itself")
        offer(new_version)

        step("Only the app itself can start an update")
        body = json.dumps({"version": new_version}).encode()
        for headers, expected_status in (
            ({"Content-Type": "application/json"}, 403),
            ({**APP_HEADERS, "Content-Type": "text/plain"}, 415),
            ({**APP_HEADERS, "Origin": "https://evil.example"}, 403),
            ({**APP_HEADERS, "Host": "evil.example:" + str(port)}, 403),
        ):
            status, answer = call(port, "POST", "/api/update/start", body, headers)
            if status != expected_status:
                fail(f"start with {headers} answered {status}, expected {expected_status}")
        if health(port) != OLD_VERSION:
            fail("a refused request changed something")

        if not release_tag:
            step("The installer can't be downloaded: a plain message, nothing changed")
            github.missing = {SCRIPT}
            status, answer = start(new_version)
            print(status, answer)
            if status != 424 or "Nothing was changed" not in str(answer):
                fail(f"expected 424 with a plain message, got {status} {answer}")
            github.missing = set()
            if health(port) != OLD_VERSION or (root / "logs" / "update-attempt.json").exists():
                fail("a failed download changed something")

            step("The installer isn't what SHA256SUMS says: refused, nothing changed")
            real_script = github.files[tag][SCRIPT]
            github.files[tag][SCRIPT] = real_script + b"\n# changed by someone\n"
            status, answer = start(new_version)
            print(status, answer)
            github.files[tag][SCRIPT] = real_script
            if status != 424 or "isn't exactly what was published" not in str(answer):
                fail(f"a tampered installer wasn't refused: {status} {answer}")
            if health(port) != OLD_VERSION or (root / "logs" / "update-attempt.json").exists():
                fail("a tampered installer changed something")

            step("The zip isn't what SHA256SUMS says: stopped before closing the app")
            real_zip = github.files[tag][ASSET]
            github.files[tag][ASSET] = real_zip[:-100] + b"\0" * 100
            before = servers_started()
            status, answer = start(new_version)
            if status != 202:
                fail(f"start answered {status} {answer}")
            wait_for(
                "the installer to refuse the zip",
                lambda: attempt(port).get("outcome") == "failed",
                UPDATE_TIMEOUT,
                logs,
            )
            github.files[tag][ASSET] = real_zip
            last = attempt(port)
            print(json.dumps(last, indent=2))
            if "checksum" not in last.get("technical", ""):
                fail(f"the checksum mismatch isn't in the details: {last}")
            if servers_started() != before or health(port) != OLD_VERSION:
                fail("the app was closed for a zip that doesn't match")
            data_intact()

            step("The installer fails after its backup: the old version opens again")
            marker.write_text("fail once\n")
            before = servers_started()
            status, answer = start(new_version)
            if status != 202:
                fail(f"start answered {status} {answer}")
            old_back_and_failed(before, "failure after the backup")
            if marker.exists():
                fail("the installer didn't use the test hook")
            log_text = update_log.read_text("utf-8", "replace")
            if "Test hook: failing after the backup" not in log_text:
                fail("update.log doesn't have the installer's failure")
            if "Closed the running copy" not in log_text:
                fail("the installer didn't stop the running app")

            step(f"Update now to {BROKEN_VERSION}, which can't start: A is put back and opened")
            github.latest = f"v{BROKEN_VERSION}"
            offer(BROKEN_VERSION)
            before = servers_started()
            status, answer = start(BROKEN_VERSION)
            if status != 202:
                fail(f"start answered {status} {answer}")
            old_back_and_failed(before, "the new version didn't start")
            # The installer says why just after reopening A; the app picks it up from its log.
            wait_for(
                "the details to say the new version didn't start",
                lambda: "didn't start" in attempt(port).get("technical", ""),
                60,
                logs,
            )
            if (app_dir / "VERSION").read_text().strip() != OLD_VERSION:
                fail("the app folder isn't A after the rollback")
            github.latest = tag
            offer(new_version)

        step("Update now, for real: A to B, polling as the page does")
        started = time.monotonic()
        status, answer = start(new_version)
        if status != 202 or answer["last_attempt"]["outcome"] != "running":
            fail(f"start answered {status} {answer}")
        status, _ = start(new_version)
        if status != 409:
            fail(f"a second start answered {status}, expected 409 (already started)")
        wait_for(
            f"version {new_version}", lambda: health(port) == new_version, UPDATE_TIMEOUT, logs
        )
        print(f"updated in {time.monotonic() - started:.0f} s")
        if not release_tag and f"/download/{tag}/{SCRIPT}" not in github.requests:
            fail(f"the installer wasn't taken from the release's files: {github.requests}")

        step("Everything is still there, backed up first, and nothing is left behind")
        # The installer is done once it has seen the new version answer.
        wait_for(
            "the installer to say it's done",
            lambda: "Scrappy Records is installed" in update_log.read_text("utf-8", "replace"),
            60,
            logs,
        )
        _, info = call(port, "GET", "/api/update")
        print(json.dumps(info, indent=2))
        last = info["last_attempt"]
        if last["outcome"] != "succeeded" or last["to_version"] != new_version:
            fail(f"the update isn't recorded as done: {last}")
        if info["update_available"] or info["current"] != new_version:
            fail("B still offers an update")
        data_intact()
        pre_update = sorted(backups.glob("records-pre-update-*.db"))
        if not pre_update:
            fail("no pre-update backup")
        with sqlite3.connect(pre_update[-1]) as conn:
            names = [r[0] for r in conn.execute("SELECT name FROM students")]
        if NAME not in names:
            fail(f"the newest pre-update backup doesn't have the student: {names}")
        if (app_dir / "VERSION").read_text().strip() != new_version:
            fail("the app folder isn't B")
        leftovers = [p.name for p in root.iterdir() if p.name.startswith("app.")]
        if leftovers:
            fail(f"left behind: {leftovers}")
        log_text = update_log.read_text("utf-8", "replace")
        if "The download matches its checksum" not in log_text:
            fail("the installer didn't check the zip against SHA256SUMS")
        if "no new browser tab" not in server_log.read_text("utf-8", "replace"):
            fail("the launcher didn't notice the waiting page (it would open a second tab)")

        if not release_tag:
            step("The pasted line's path: C over B doesn't start, so B is put back")
            pasted = work / "pasted"
            pasted.mkdir()
            shutil.copy(broken_zip, pasted / ASSET)
            (pasted / "SHA256SUMS").write_text(
                f"{sha256((pasted / ASSET).read_bytes())}  {ASSET}\n"
            )
            output = run(installer(pasted / ASSET, root, no_launch=False), env, expect_ok=False)
            for words in ("matches its checksum", "didn't start", "was put back"):
                if words not in output:
                    fail(f"the installer didn't say '{words}'")
            wait_for(f"version {new_version} back", lambda: health(port) == new_version, 120, logs)
            if (app_dir / "VERSION").read_text().strip() != new_version:
                fail("the app folder isn't B after the rollback")
            data_intact()
            if "didn't start, so version" not in update_log.read_text("utf-8", "replace"):
                fail("update.log doesn't record the rollback")

            step("A zip that doesn't match its SHA256SUMS changes nothing")
            (pasted / "SHA256SUMS").write_text(f"{'0' * 64}  {ASSET}\n")
            before = servers_started()
            output = run(installer(pasted / ASSET, root, no_launch=False), env, expect_ok=False)
            if "doesn't match its checksum" not in output or "NOT installed" not in output:
                fail("the mismatch wasn't reported plainly")
            if servers_started() != before or health(port) != new_version:
                fail("a zip that doesn't match changed something")
            data_intact()

        print("\nIN-APP UPDATE TEST PASSED")
        return 0
    except Failed as e:
        print(f"\n{e}", flush=True)
        for log in logs:
            if log.is_file():
                print(f"--- {log}:")
                print(log.read_text("utf-8", "replace")[-8000:])
        return 1
    finally:
        stop_everything(root, port)
        shutil.rmtree(top, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
