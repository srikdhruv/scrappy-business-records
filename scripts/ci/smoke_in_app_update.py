"""End-to-end check of "Update now" (ADR 0006) on a real install, on Windows or macOS.

    uv run --project backend python scripts/ci/smoke_in_app_update.py dist/scrappy-records-<os>.zip

CI runs it in the windows-install and macos-install jobs, after the install smoke test. It
uses the bundle built from this commit twice:

- **A**, the same zip with its `VERSION` changed to 0.0.1 (the "old version");
- **B**, the zip as built (the "new version").

Then, in a temporary folder whose name has a space, an apostrophe and non-English letters:

1. install A with the real installer, open it with the real launcher, with no developer tools
   on PATH, and add a student and a payment through the API;
2. serve a fake release feed (GitHub's "latest release", saying B's version is out) and the
   installer (this commit's `scripts/install.*`, at `/<tag>/<script>`) from a local HTTP server;
   the app is pointed at them with `SCRAPPY_UPDATE_FEED_URL`, `SCRAPPY_UPDATE_INSTALLER_URL`, and
   `SCRAPPY_UPDATE_ZIP` (B, passed on to the installer as its zip);
3. check the app sees the update, and that `/api/update/start` refuses other websites;
4. the installer can't be downloaded → a plain error, nothing changed;
5. the installer fails after its backup (a test hook) → the old version is opened again, and
   the app says the update didn't finish;
6. `/api/update/start` for real → the installer (detached, from the app) stops the app, backs
   up, installs B and opens it; wait for `/api/health` to report B's version, polling as the
   page does (so the launcher opens no second tab);
7. the student and payment are still there, a pre-update backup holds them, the app says the
   update succeeded, and nothing is left behind.
"""

from __future__ import annotations

import contextlib
import datetime as dt
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


def make_old_zip(new_zip: Path, old_zip: Path) -> str:
    """Copy the bundle with VERSION set to OLD_VERSION. Returns the bundle's real version."""
    with (
        zipfile.ZipFile(new_zip) as src,
        zipfile.ZipFile(old_zip, "w", zipfile.ZIP_DEFLATED) as dst,
    ):
        version = src.read("VERSION").decode().strip()
        for info in src.infolist():
            data = OLD_VERSION.encode() + b"\n" if info.filename == "VERSION" else src.read(info)
            dst.writestr(info, data)
    return version


# --------------------------------------------------------------------------- the fake GitHub


class FakeGitHub:
    def __init__(self, new_version: str) -> None:
        self.tag = f"v{new_version}"
        self.installer_missing = False
        self.requests: list[str] = []
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                fake.requests.append(self.path)
                if self.path == "/releases/latest":
                    body = json.dumps(
                        {
                            "tag_name": fake.tag,
                            "name": fake.tag,
                            "draft": False,
                            "prerelease": False,
                            "body": "## What's new\n* The in-app update test",
                            "assets": [{"name": ASSET, "state": "uploaded"}],
                        }
                    ).encode()
                    self._send(200, body)
                elif self.path == f"/{fake.tag}/{SCRIPT}" and not fake.installer_missing:
                    self._send(200, (REPO / "scripts" / SCRIPT).read_bytes())
                else:
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


# --------------------------------------------------------------------------- talking to the app

_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(
    port: int,
    method: str,
    path: str,
    body: Any = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, Any]:
    data = (
        None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    )
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=data,
        method=method,
        headers=headers or {},
    )
    try:
        with _opener.open(request, timeout=30) as response:
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


def run(command: list[str], env: dict[str, str], cwd: Path | None = None) -> str:
    print("$", " ".join(command), flush=True)
    result = subprocess.run(
        command,
        env=env,
        cwd=cwd,
        capture_output=True,
        text=True,
        errors="replace",
        timeout=600,
    )
    print(result.stdout + result.stderr, flush=True)
    if result.returncode != 0:
        fail(f"{command[0]} exited with {result.returncode}")
    return result.stdout + result.stderr


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
    status, info = call(port, "GET", "/api/update")
    return info if status == 200 and info.get("checked_at") else None


# --------------------------------------------------------------------------- the test


def main() -> int:
    # The folder names have letters a Windows console's code page may not have.
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(errors="backslashreplace")  # type: ignore[union-attr]
    new_zip = Path(sys.argv[1]).resolve()
    top = Path(tempfile.mkdtemp(prefix="scrappy-inapp-"))
    work = top / f"Scrappy Elève's रिकॉर्ड {uuid.uuid4().hex[:6]}"
    root = work / "ScrappyRecords"
    backups = work / "backups"
    port = free_port()
    marker = work / "fail-after-backup.flag"
    logs = [root / "logs" / "update.log", root / "logs" / "server.log"]
    work.mkdir(parents=True)
    try:
        step("Make the old version (A): the same bundle, with VERSION 0.0.1")
        old_zip = work / f"old-{ASSET}"
        new_version = make_old_zip(new_zip, old_zip)
        print(f"new version (B): {new_version}; old version (A): {OLD_VERSION}")
        github = FakeGitHub(new_version)

        env = clean_env(
            {
                "SCRAPPY_HOME": str(root),
                "SCRAPPY_BACKUP_DIR": str(backups),
                "SCRAPPY_PORT": str(port),
                "SCRAPPY_NO_BROWSER": "1",
                "SCRAPPY_NO_DIALOG": "1",
                "SCRAPPY_UPDATE_FEED_URL": f"{github.base}/releases/latest",
                "SCRAPPY_UPDATE_INSTALLER_URL": f"{github.base}/{{tag}}/{{script}}",
                "SCRAPPY_UPDATE_ZIP": str(new_zip),
                "SCRAPPY_TEST_FAIL_AFTER_BACKUP": str(marker),
                ("SCRAPPY_SHORTCUT_DIR" if IS_WINDOWS else "SCRAPPY_APPS_DIR"): str(
                    work / ("Desktop" if IS_WINDOWS else "Applications")
                ),
            }
        )

        step(f"Install A with the real installer into {root}")
        if IS_WINDOWS:
            run(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(REPO / "scripts" / "install.ps1"),
                    "-ZipPath",
                    str(old_zip),
                    "-InstallRoot",
                    str(root),
                    "-NoLaunch",
                ],
                env,
            )
        else:
            run(
                [
                    "/bin/sh",
                    str(REPO / "scripts" / "install.sh"),
                    "--zip",
                    str(old_zip),
                    "--no-launch",
                    "--install-root",
                    str(root),
                ],
                env,
            )
        app_dir = root / "app"
        python = app_dir / ("python/pythonw.exe" if IS_WINDOWS else "python/bin/python3")

        step("Open A with the launcher; add a student and a payment")
        run([str(python), "-m", "app.launcher"], env, cwd=app_dir)
        if health(port) != OLD_VERSION:
            fail(f"the old version isn't answering (health: {health(port)})")
        status, dashboard = call(port, "GET", "/api/dashboard")
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
        today = dt.date.today().isoformat()
        status, payment = call(
            port,
            "POST",
            "/api/payments",
            {
                "student_id": student["id"],
                "amount_paise": 150000,
                "for_month": month,
                "paid_on": today,
                "method": "upi",
            },
            {"Content-Type": "application/json"},
        )
        if status != 201:
            fail(f"couldn't add the payment: {status} {payment}")

        step("The app sees B on the (fake) feed and can update itself")
        info = wait_for("the update check", lambda: update_checked(port), 60, logs)
        print(json.dumps(info, indent=2))
        expected = {
            "current": OLD_VERSION,
            "latest": new_version,
            "update_available": True,
            "can_update": True,
            "reason": None,
        }
        if any(info.get(k) != v for k, v in expected.items()):
            fail(f"/api/update isn't what it should be: {info}")

        step("Only the app itself can start an update")
        body = json.dumps({"version": new_version}).encode()
        for headers, expected_status in (
            ({"Content-Type": "application/json"}, 403),
            ({**APP_HEADERS, "Content-Type": "text/plain"}, 415),
            ({**APP_HEADERS, "Origin": "https://evil.example"}, 403),
        ):
            status, answer = call(port, "POST", "/api/update/start", body, headers)
            if status != expected_status:
                fail(f"start with {headers} answered {status}, expected {expected_status}")
        if health(port) != OLD_VERSION:
            fail("a refused request changed something")

        step("The installer can't be downloaded: a plain message, nothing changed")
        github.installer_missing = True
        status, answer = call(port, "POST", "/api/update/start", body, APP_HEADERS)
        print(status, answer)
        if status != 424 or "Nothing was changed" not in str(answer):
            fail(f"expected 424 with a plain message, got {status} {answer}")
        github.installer_missing = False
        if health(port) != OLD_VERSION or (root / "logs" / "update-attempt.json").exists():
            fail("a failed download changed something")

        step("The installer fails after its backup: the old version opens again and says so")
        marker.write_text("fail once\n")
        status, answer = call(port, "POST", "/api/update/start", body, APP_HEADERS)
        if status != 202:
            fail(f"start answered {status} {answer}")
        seen_down = {"down": False}

        def old_version_back() -> bool:
            version = health(port)
            if version is None:
                seen_down["down"] = True
                return False
            if version != OLD_VERSION:
                fail(f"version {version} came up, expected the old one")
            _, now = call(port, "GET", "/api/update")
            failed = (now.get("last_attempt") or {}).get("outcome") == "failed"
            if failed and not seen_down["down"]:
                fail("the installer ended without ever stopping the app")
            return seen_down["down"] and failed

        wait_for(
            "the old version to come back, saying it failed",
            old_version_back,
            UPDATE_TIMEOUT,
            logs,
        )
        if marker.exists():
            fail("the installer didn't use the test hook")
        _, info = call(port, "GET", "/api/update")
        print(json.dumps(info["last_attempt"], indent=2))
        if "didn't finish" not in info["last_attempt"]["detail"] or not info["can_update"]:
            fail(f"the failure isn't reported as it should be: {info}")
        update_log = (root / "logs" / "update.log").read_text("utf-8", "replace")
        if "Test hook: failing after the backup" not in update_log:
            fail("update.log doesn't have the installer's failure")
        if "Closed the running copy" not in update_log:
            fail("the installer didn't stop the running app")

        step("Update for real: A → B, polling as the page does")
        started = time.monotonic()
        status, answer = call(port, "POST", "/api/update/start", body, APP_HEADERS)
        if status != 202 or answer["last_attempt"]["outcome"] != "running":
            fail(f"start answered {status} {answer}")
        status, _ = call(port, "POST", "/api/update/start", body, APP_HEADERS)
        if status != 409:
            fail(f"a second start answered {status}, expected 409 (already started)")
        wait_for(
            f"version {new_version}",
            lambda: health(port) == new_version,
            UPDATE_TIMEOUT,
            logs,
        )
        print(f"updated in {time.monotonic() - started:.0f} s")
        if f"/v{new_version}/{SCRIPT}" not in github.requests:
            fail(f"the installer wasn't taken from the new release's tag: {github.requests}")

        step("Everything is still there, backed up first, and nothing is left behind")
        _, info = call(port, "GET", "/api/update")
        print(json.dumps(info, indent=2))
        attempt = info["last_attempt"]
        if attempt["outcome"] != "succeeded" or attempt["to_version"] != new_version:
            fail(f"the update isn't recorded as done: {attempt}")
        if info["update_available"] or info["current"] != new_version:
            fail("B still offers an update")
        _, students = call(port, "GET", "/api/students?status=all")
        if NAME not in [s["name"] for s in students]:
            fail("the student is gone")
        _, payments = call(port, "GET", f"/api/payments?student_id={student['id']}")
        if [p["amount_paise"] for p in payments] != [150000]:
            fail(f"the payment isn't as it was: {payments}")
        pre_update = sorted(backups.glob("records-pre-update-*.db"))
        if len(pre_update) < 2:
            fail(f"expected a pre-update backup per attempt, found {pre_update}")
        with sqlite3.connect(pre_update[-1]) as conn:
            names = [r[0] for r in conn.execute("SELECT name FROM students")]
        if NAME not in names:
            fail(f"the newest pre-update backup doesn't have the student: {names}")
        if (app_dir / "VERSION").read_text().strip() != new_version:
            fail("the app folder isn't B")
        for leftover in ("app.new", "app.old"):
            if (root / leftover).exists():
                fail(f"{leftover} was left behind")
        # The installer may still be finishing (the launcher it ran waits for the page).
        wait_for(
            "the installer to say it's done",
            lambda: (
                "Scrappy Records is installed"
                in (root / "logs" / "update.log").read_text("utf-8", "replace")
            ),
            60,
            logs,
        )
        update_log = (root / "logs" / "update.log").read_text("utf-8", "replace")
        if update_log.count("Closed the running copy") < 2:
            fail("the installer didn't stop the running app")
        server_log = (root / "logs" / "server.log").read_text("utf-8", "replace")
        if "no new browser tab" not in server_log:
            fail("the launcher didn't notice the waiting page (it would open a second tab)")
        print("\nIN-APP UPDATE TEST PASSED")
        return 0
    except Failed as e:
        print(f"\n{e}", flush=True)
        for log in logs:
            if log.is_file():
                print(f"--- {log}:")
                print(log.read_text("utf-8", "replace")[-6000:])
        return 1
    finally:
        stop_everything(root, port)
        shutil.rmtree(top, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
