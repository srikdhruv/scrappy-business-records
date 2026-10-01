"""In-app feedback: saving, what is attached, and sending it to the relay (ADR 0005).

The relay here is a fake one: a small HTTP server on 127.0.0.1 that answers as scripted and
records what it was sent. Nothing leaves the machine.
"""

from __future__ import annotations

import base64
import http.server
import json
import logging
import shutil
import sqlite3
import threading
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from helpers import make_student, pay
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

import app as app_package
from app import __version__, config, diagnostics, feedback_sender, logs
from app.db import dispose_engines, get_engine, session_factory
from app.feedback_sender import FeedbackSender, SendResult, post_feedback, usable_url
from app.main import create_app
from app.models import Feedback, FeedbackStatus
from app.schemas import SCREENSHOT_MAX_BYTES
from app.services import feedback as service

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "releases"

# A real, tiny JPEG and PNG header followed by filler: enough for the signature checks.
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 200
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 200


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def feedback_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "category": "problem",
        "message": "The total looks wrong\nafter I logged a payment",
        "route": "/payments?month=2026-06",
        "client": {
            "local_time": "2026-06-15T15:45:00+05:30",
            "timezone": "Asia/Kolkata",
            "language": "en-IN",
            "user_agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0",
            "screen": "1440x900",
            "window": "1280x800",
            "ui_build": "abc1234",
            "errors": [{"at": "2026-06-15T10:14:58Z", "kind": "api", "message": "GET x -> 500"}],
        },
        "screenshot": b64(JPEG),
    }
    body.update(overrides)
    return body


# --------------------------------------------------------------------------- fake relay


@dataclass
class FakeRelay:
    """Answers POST /feedback from `answers` (status, body, headers), then 201s; dedupes by id
    like the real one."""

    url: str = ""
    answers: list[tuple[int, dict[str, Any], dict[str, str]]] = field(default_factory=list)
    received: list[dict[str, Any]] = field(default_factory=list)
    filed: dict[str, str] = field(default_factory=dict)
    delay: float = 0.0


@pytest.fixture
def relay() -> Iterator[FakeRelay]:
    fake = FakeRelay()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args: object) -> None:
            pass

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length))
            fake.received.append(payload)
            if fake.delay:
                time.sleep(fake.delay)
            if fake.answers:
                status, body, headers = fake.answers.pop(0)
            else:
                url = fake.filed.setdefault(
                    payload["id"], f"https://github.com/example/feedback/issues/{len(fake.filed)}"
                )
                status, body, headers = 201, {"status": "created", "issue_url": url}, {}
            data = json.dumps(body).encode()
            try:
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except OSError:
                pass  # the client gave up (timeout test)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    fake.url = f"http://127.0.0.1:{server.server_address[1]}/feedback"
    yield fake
    server.shutdown()
    server.server_close()


@pytest.fixture
def server_log() -> Iterator[Path]:
    """Log to this test's server.log, as `python -m app` does; undone afterwards."""
    path = logs.setup(rotate=False)
    yield path
    root = logging.getLogger()
    for handler in list(root.handlers):
        if getattr(handler, "scrappy", False):
            root.removeHandler(handler)
            handler.close()


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def sender_for(url: str, clock: Clock | None = None) -> FeedbackSender:
    return FeedbackSender(url=lambda: url, clock=clock or Clock(), jitter=lambda: 0.5)


def row(feedback_id: str) -> Feedback:
    with session_factory()() as session:
        found = session.get(Feedback, feedback_id)
        assert found is not None
        return found


# --------------------------------------------------------------------------- saving


def test_save_and_read_back(client: TestClient) -> None:
    body = feedback_body()
    response = client.post("/api/feedback", json=body)
    assert response.status_code == 201, response.text
    saved = response.json()
    assert saved["id"] == body["id"]
    assert saved["status"] == "pending"
    assert saved["category"] == "problem"
    assert saved["attempts"] == 0
    assert saved["sending"] is False  # no relay set in tests
    assert saved["created_at"].endswith("Z")
    again = client.get(f"/api/feedback/{body['id']}")
    assert again.status_code == 200
    assert again.json() == saved
    assert (config.feedback_dir() / f"{body['id']}.jpg").read_bytes() == JPEG


def test_same_id_saves_once(client: TestClient) -> None:
    body = feedback_body()
    first = client.post("/api/feedback", json=body).json()
    second = client.post("/api/feedback", json={**body, "message": "a second click"})
    assert second.status_code == 201
    assert second.json() == first
    with session_factory()() as session:
        assert service.waiting_count(session) == 1
        assert session.get(Feedback, body["id"]).message == body["message"]  # type: ignore[union-attr]


def test_id_is_made_when_missing(client: TestClient) -> None:
    body = feedback_body()
    del body["id"]
    saved = client.post("/api/feedback", json=body).json()
    assert uuid.UUID(saved["id"])


def test_png_and_data_url_and_no_picture(client: TestClient) -> None:
    png = feedback_body(screenshot="data:image/png;base64," + b64(PNG))
    assert client.post("/api/feedback", json=png).status_code == 201
    assert (config.feedback_dir() / f"{png['id']}.png").is_file()
    none = feedback_body(screenshot=None)
    assert client.post("/api/feedback", json=none).status_code == 201
    assert row(none["id"]).screenshot_file is None


def test_unknown_feedback_is_404(client: TestClient) -> None:
    response = client.get(f"/api/feedback/{uuid.uuid4()}")
    assert response.status_code == 404
    assert response.json()["detail"].startswith("No feedback with id")
    assert client.get("/api/feedback/not-a-uuid").status_code == 422


@pytest.mark.parametrize(
    ("overrides", "loc", "msg"),
    [
        ({"message": "   "}, "message", "Please write a message"),
        ({"message": "x" * 5001}, "message", None),
        ({"category": "complaint"}, "category", None),
        ({"screenshot": "not base64!"}, "screenshot", "The picture of the screen couldn't be read"),
        ({"screenshot": b64(b"GIF89a" + b"\0" * 20)}, "screenshot", None),
        (
            {"screenshot": b64(b"\xff\xd8\xff" + b"\0" * SCREENSHOT_MAX_BYTES)},
            "screenshot",
            "The picture of the screen is too big to send",
        ),
        ({"id": "123"}, "id", None),
        ({"surprise": 1}, "surprise", None),
    ],
)
def test_bad_feedback_is_422(
    client: TestClient, overrides: dict[str, Any], loc: str, msg: str | None
) -> None:
    response = client.post("/api/feedback", json=feedback_body(**overrides))
    assert response.status_code == 422
    [item] = response.json()["detail"]
    assert item["loc"][:2] == ["body", loc]
    if msg:
        assert item["msg"] == msg


def test_screenshot_at_the_cap_is_fine(client: TestClient) -> None:
    exact = b"\xff\xd8\xff" + b"\0" * (SCREENSHOT_MAX_BYTES - 3)
    assert (
        client.post("/api/feedback", json=feedback_body(screenshot=b64(exact))).status_code == 201
    )


def test_diagnostics_are_clipped_not_refused(client: TestClient) -> None:
    errors = [{"at": "t", "kind": "error", "message": f"error {i}"} for i in range(30)]
    body = feedback_body(
        client={
            "user_agent": "U" * 900,
            "language": "en\x00IN",
            "errors": errors,
        }
    )
    assert client.post("/api/feedback", json=body).status_code == 201
    diag = json.loads(row(body["id"]).diagnostics)
    assert len(diag["client"]["user_agent"]) == 500
    assert diag["client"]["language"] == "en?IN"
    assert [e["message"] for e in diag["client"]["errors"]] == [f"error {i}" for i in range(10, 30)]


# --------------------------------------------------------------------------- what's attached


def test_diagnostics_have_version_build_install_and_log(
    client: TestClient, server_log: Path
) -> None:
    logging.getLogger("scrappy").warning("a line only the log has")
    body = feedback_body()
    client.post("/api/feedback", json=body)
    diag = json.loads(row(body["id"]).diagnostics)
    assert diag["server"]["app_version"] == __version__
    assert diag["server"]["build_id"] == app_package.build_id()
    assert diag["server"]["db_revision"] == "0005"
    assert diag["install_id"] == config.install_id_file().read_text().strip()
    assert "a line only the log has" in diag["log_tail"]
    payload = service.relay_payload(row(body["id"]))
    assert payload["app_version"] == __version__
    assert payload["build_id"] == app_package.build_id()
    assert payload["install_id"] == diag["install_id"]
    assert payload["route"] == "/payments"  # the path only: a query could hold a name
    assert payload["local_time"] == "2026-06-15T15:45:00+05:30"
    assert payload["environment"]["browser"].startswith("Mozilla")
    assert payload["environment"]["screen"] == "1440x900"
    assert payload["errors"][0]["message"] == "GET x -> 500"
    assert payload["screenshot"] == {"content_type": "image/jpeg", "data_base64": b64(JPEG)}


def test_install_id_is_made_once(client: TestClient) -> None:
    first = diagnostics.install_id()
    assert uuid.UUID(first)
    assert diagnostics.install_id() == first
    config.install_id_file().write_text("garbage")
    replaced = diagnostics.install_id()
    assert replaced != first and uuid.UUID(replaced)
    assert diagnostics.install_id() == replaced


def _record(level: str, name: str, message: str, n: int = 0) -> str:
    return f"2026-06-15 10:{n // 60:02d}:{n % 60:02d},000 {level:<7} [4242] {name}: {message}"


def test_log_tail_keeps_the_last_200_lines_worth_sending(client: TestClient) -> None:
    home = str(Path.home())
    log_file = logs.log_file()
    old = [_record("WARNING", "scrappy", f"old warning {i}", i) for i in range(50)]
    log_file.with_name("server.log.1").write_text("\n".join(old) + "\n", encoding="utf-8")
    lines = []
    for i in range(180):
        lines.append(_record("INFO", "scrappy", f"note {i} in {home}/Documents", i))
        lines.append(_record("INFO", "alembic.runtime.migration", f"chatter {i}", i))
    lines.append(_record("ERROR", "scrappy", "x" * 2000))
    lines.append(_record("ERROR", "uvicorn.error", "Exception in ASGI application"))
    lines.append("Traceback (most recent call last):")
    lines.append(f'  File "{home}/app/x.py", line 3, in f')
    lines.append("sqlite3.IntegrityError [parameters: ('Ananya Rao', '98765 43210')]")
    lines.append("ValueError: invalid literal for int() with base 10: 'Kabir Mehta'")
    log_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tail = diagnostics.log_tail().split("\n")
    assert len(tail) == 200
    joined = "\n".join(tail)
    assert "chatter" not in joined  # other libraries' INFO lines are left out
    assert tail[0].endswith("old warning 36")  # 14 from the rotated file, then 186 current
    assert tail[14].endswith("scrappy: note 0 in ~/Documents")
    assert home not in joined
    assert len(tail[-6]) == 501  # 500 characters and "…"
    assert tail[-3] == '  File "~/app/x.py", line 3, in f'  # paths in tracebacks stay
    assert tail[-2] == "sqlite3.IntegrityError [parameters: hidden]"
    # Raised in the app's own code (the File line above): its message is left out.
    assert tail[-1] == "ValueError: [message left out: raised by the app]"
    assert "Ananya" not in joined and "Kabir" not in joined


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (r"C:\Users\Ananya Rao\AppData\Local", r"~\AppData\Local"),
        (r"C:\\Users\\Ananya Rao\\AppData", r"~\\AppData"),  # escaped, as in a repr
        ("C:/Users/Ananya Rao/AppData", "~/AppData"),
        ("c:\\users\\ANANYA RAO\\x", "~\\x"),  # any letter case
        ("file:///C:/Users/Ananya%20Rao/Documents", "file:///~/Documents"),
        ("C%3A%5CUsers%5CAnanya%20Rao%5CDocuments", "~\\Documents"),
        (r"C:\Users\ANANYA~1\AppData", r"C:\Users\<user>\AppData"),  # 8.3 short name
        (r"D:\Users\Kabir Mehta\x", r"D:\Users\<user>\x"),  # someone else's folder
        ("/Users/kabir/Library", "/Users/<user>/Library"),
        ("/home/kabir/.cache", "/home/<user>/.cache"),
        ("%2FUsers%2Fkabir%2Fx", "/Users/<user>/x"),
        ("Signed in as Ananya Rao today", "Signed in as <user> today"),
        ("Users and home stay as words", "Users and home stay as words"),
        # Escaped or URL-encoded, the name is decoded first.
        (r'"C:\\Users\\Ananya Rao\u0301\\x"', r'"C:\\Users\\<user>\\x"'),
        ("C%3A%5CUsers%5CAnanya%20Rao%5Cx", "~\\x"),
        ("Signed in as Ananya\\u0020Rao", "Signed in as <user>"),
    ],
)
def test_redact_hides_the_user_in_every_form(
    text: str, expected: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from pathlib import PureWindowsPath

    monkeypatch.setattr(diagnostics.Path, "home", lambda: PureWindowsPath(r"C:\Users\Ananya Rao"))
    monkeypatch.setenv("USERNAME", "Ananya Rao")
    monkeypatch.setenv("USER", "")
    monkeypatch.setenv("LOGNAME", "")
    assert diagnostics.redact(text) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # JSON and Python escapes, bytes as UTF-8, and URL-encoding of a non-English name.
        (r"C:\\Users\\Anany\u0101\\AppData", r"~\\AppData"),
        (r"b'C:\\Users\\Anany\xc4\x81\\AppData'", r"b'~\\AppData'"),
        ("C:%5CUsers%5CAnany%C4%81%5CAppData", r"~\AppData"),
        ("file:///C:/Users/Anany%C4%81/Documents", "file:///~/Documents"),
        ("hello Anany\u0101", "hello <user>"),
        # The home folder only as a whole folder name: not inside a longer one.
        (r"C:\Users\Ananyāsri\x", r"C:\Users\<user>\x"),
        # The bare name only as a whole word.
        ("Ananyāsri and Ananyā", "Ananyāsri and <user>"),
    ],
)
def test_redact_decodes_non_ascii_names(
    text: str, expected: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from pathlib import PureWindowsPath

    monkeypatch.setattr(diagnostics.Path, "home", lambda: PureWindowsPath(r"C:\Users\Ananyā"))
    monkeypatch.setenv("USERNAME", "Ananyā")
    monkeypatch.setenv("USER", "")
    monkeypatch.setenv("LOGNAME", "")
    assert diagnostics.redact(text) == expected


def test_short_names_are_not_hidden_as_words(monkeypatch: pytest.MonkeyPatch) -> None:
    from pathlib import PurePosixPath

    monkeypatch.setattr(diagnostics.Path, "home", lambda: PurePosixPath("/Users/raj"))
    monkeypatch.setenv("USER", "raj")
    monkeypatch.setenv("USERNAME", "")
    monkeypatch.setenv("LOGNAME", "")
    # "raj" is too short to hide as a word (Rajasthan, Raja…), but the folder still goes.
    assert diagnostics.redact("Raja paid; see /Users/raj/x") == "Raja paid; see ~/x"
    monkeypatch.setenv("USER", "ravi")
    assert diagnostics.redact("ravishankar and ravi") == "ravishankar and <user>"


def test_redact_this_laptops_home() -> None:
    home = str(Path.home())
    for form in (home, home.replace("/", "\\"), home.upper(), home.replace("/", "%2F")):
        assert diagnostics.redact(f"at {form}/x").startswith("at ~"), form


def test_app_exception_messages_are_left_out_library_ones_kept(client: TestClient) -> None:
    lines = [
        _record("ERROR", "uvicorn.error", "Exception in ASGI application"),
        "Traceback (most recent call last):",
        '  File "/srv/app/.venv/lib/python3.12/site-packages/starlette/routing.py", line 1',
        '  File "C:\\ScrappyRecords\\app\\app\\services\\students.py", line 42, in save',
        "ValueError: Kabir Mehta owes 1500 for 2026-05",
        _record("ERROR", "scrappy", "Backup failed"),
        "Traceback (most recent call last):",
        '  File "C:\\ScrappyRecords\\app\\app\\backup.py", line 9, in backup',
        '  File "C:\\ScrappyRecords\\app\\python\\Lib\\sqlite3\\dbapi2.py", line 3',
        "sqlite3.OperationalError: unable to open database file",
        "KeyError",
    ]
    logs.log_file().write_text("\n".join(lines) + "\n", encoding="utf-8")
    tail = diagnostics.log_tail().split("\n")
    assert "ValueError: [message left out: raised by the app]" in tail
    assert "Kabir" not in "\n".join(tail)
    # The last frame is Python's own sqlite3: a library/system message, kept.
    assert "sqlite3.OperationalError: unable to open database file" in tail
    assert tail[-1] == "KeyError"


def test_log_tail_without_a_log(client: TestClient) -> None:
    logs.log_file().unlink(missing_ok=True)
    assert diagnostics.log_tail() == ""


def test_no_records_leak_into_what_is_sent(api: TestClient, server_log: Path) -> None:
    """Names, phones, notes and amounts the owner stored never appear in diagnostics, even when
    a database error was logged with its values."""
    secrets = {
        "name": "Zaraquel Vantorn",
        "phone": "91234 56780",
        "guardian_name": "Oswin Pellacourt",
        "batch_label": "Quixbatch Seven",
        "notes": "private note mauve-otter",
    }
    student = make_student(api, **secrets, monthly_fee_paise=1234567)
    pay(api, student["id"], "2026-05", amount=7654321, note="payment note teal-heron")
    # A database error, logged with its values, as SQLAlchemy does.
    with get_engine().connect() as conn:
        try:
            conn.execute(
                text("INSERT INTO students (id, name, joined_month) VALUES (:id, :n, :m)"),
                {"id": student["id"], "n": secrets["name"], "m": "2026-01-01"},
            )
        except IntegrityError:
            logging.getLogger("scrappy").exception("Saving failed")
    body = feedback_body(message="Something is off", route="/", client={}, screenshot=None)
    assert api.post("/api/feedback", json=body).status_code == 201
    saved = row(body["id"])
    sent = json.dumps(service.relay_payload(saved), ensure_ascii=False)
    stored = saved.diagnostics
    assert "Zaraquel" in (logs.log_file().read_text(encoding="utf-8"))  # it was logged…
    for text_ in (sent, stored):
        for value in [*secrets.values(), "1234567", "7654321", "teal-heron"]:
            assert value not in text_, value  # …but never sent
        assert "SQLite format 3" not in text_
        assert "records.db" not in text_
    assert set(json.loads(sent)) == {
        "schema",
        "id",
        "install_id",
        "category",
        "message",
        "created_at",
        "local_time",
        "app_version",
        "build_id",
        "route",
        "environment",
        "errors",
        "log_tail",
        "screenshot",
    }


def test_biggest_payload_fits_the_relay_limit(client: TestClient) -> None:
    """The relay takes 2 MiB in all: the biggest picture, message, log and errors fit."""
    body = feedback_body(
        message="é" * 5000,
        route="/" + "r" * 600,
        screenshot=b64(b"\xff\xd8\xff" + b"\0" * (SCREENSHOT_MAX_BYTES - 3)),
        client={
            "user_agent": "u" * 600,
            "errors": [{"at": "a" * 50, "kind": "k" * 30, "message": "m" * 2000}] * 25,
        },
    )
    logs.log_file().write_text(("L" * 600 + "\n") * 400, encoding="utf-8")
    assert client.post("/api/feedback", json=body).status_code == 201
    payload = service.relay_payload(row(body["id"]))
    size = len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    assert size <= service.PAYLOAD_MAX_BYTES < 2 * 1024 * 1024, size
    assert payload["screenshot"] is not None  # the picture and message still go


def test_payload_is_trimmed_to_fit_log_first(client: TestClient, server_log: Path) -> None:
    body = feedback_body(client={"errors": [{"message": "m" * 900}] * 20})
    for i in range(300):
        logging.getLogger("scrappy").warning("line %d %s", i, "w" * 400)
    client.post("/api/feedback", json=body)
    saved = row(body["id"])
    full = service.relay_payload(saved)
    assert full["log_tail"].count("\n") > 100
    small = service.relay_payload(saved, max_bytes=30_000)
    assert len(json.dumps(small).encode()) <= 30_000
    assert small["screenshot"] is not None and small["errors"]  # the log went first
    assert small["log_tail"] == "" or full["log_tail"].endswith(small["log_tail"])
    tiny = service.relay_payload(saved, max_bytes=5_000)
    assert tiny["errors"] == [] and tiny["log_tail"] == ""
    assert tiny["message"] == body["message"]
    slim = service.relay_payload(saved, slim=True)
    assert slim["screenshot"] is None
    assert slim["log_tail"].count("\n") < service.SLIM_LOG_LINES


# --------------------------------------------------------------------------- sending


def test_post_feedback_outcomes(relay: FakeRelay) -> None:
    payload = {"id": "x"}
    relay.answers = [
        (201, {"status": "created", "issue_url": "https://github.com/e/f/issues/1"}, {}),
        (500, {"status": "error"}, {}),
        (429, {"status": "rate_limited"}, {"Retry-After": "120"}),
        (400, {"status": "invalid", "error": "message must be 1-5000 characters"}, {}),
        (403, {"status": "blocked"}, {}),
        (200, {"status": "created"}, {}),  # no issue_url: odd, try again later
        (413, {"status": "too_large"}, {}),
        (404, {"error": "not found"}, {}),  # a wrong address, or a proxy: not the relay's no
        (403, {"message": "Forbidden"}, {}),  # a firewall's page
        (409, {"status": "in_progress"}, {"Retry-After": "60"}),
        (503, {"status": "misconfigured"}, {}),
    ]
    assert post_feedback(relay.url, payload, 5) == SendResult(
        "sent", issue_url="https://github.com/e/f/issues/1"
    )
    assert post_feedback(relay.url, payload, 5).outcome == "retry"
    limited = post_feedback(relay.url, payload, 5)
    assert (limited.outcome, limited.retry_after) == ("retry", 120.0)
    invalid = post_feedback(relay.url, payload, 5)
    assert invalid.outcome == "final"
    assert "message must be 1-5000 characters" in invalid.error
    assert post_feedback(relay.url, payload, 5).outcome == "final"
    assert post_feedback(relay.url, payload, 5).outcome == "retry"
    assert post_feedback(relay.url, payload, 5).outcome == "too_large"
    assert post_feedback(relay.url, payload, 5).outcome == "retry"
    assert post_feedback(relay.url, payload, 5).outcome == "retry"
    busy = post_feedback(relay.url, payload, 5)
    assert (busy.outcome, busy.retry_after) == ("retry", 60.0)
    assert post_feedback(relay.url, payload, 5).outcome == "retry"


def test_post_feedback_offline_and_timeout(relay: FakeRelay) -> None:
    closed = relay.url.rsplit(":", 1)[0] + ":9/feedback"  # nothing listens on port 9
    offline = post_feedback(closed, {}, 2)
    assert offline.outcome == "retry"
    assert offline.error.startswith("Couldn't reach the feedback inbox")
    assert offline.reached is False
    relay.delay = 1.5
    assert post_feedback(relay.url, {}, 0.3).outcome == "retry"


def test_usable_url() -> None:
    assert usable_url("https://scrappy-feedback.example.workers.dev/feedback")
    assert usable_url("http://127.0.0.1:9999/feedback")
    assert usable_url("http://localhost:9999/feedback")
    assert not usable_url("http://example.com/feedback")
    assert not usable_url("ftp://example.com/x")
    assert not usable_url("")
    assert not usable_url("https://")


def test_sender_sends_and_forgets_the_picture(client: TestClient, relay: FakeRelay) -> None:
    body = feedback_body()
    client.post("/api/feedback", json=body)
    sender = sender_for(relay.url)
    assert sender.run_once() == 1
    [received] = relay.received
    assert received["id"] == body["id"]
    assert received["app_version"] == __version__
    assert received["build_id"] == app_package.build_id()
    assert base64.b64decode(received["screenshot"]["data_base64"]) == JPEG
    saved = row(body["id"])
    assert saved.status == FeedbackStatus.sent
    assert saved.remote_ref == relay.filed[body["id"]]
    assert saved.sent_at is not None and saved.attempts == 1
    assert not (config.feedback_dir() / f"{body['id']}.jpg").exists()
    # Nothing is sent twice.
    assert sender.run_once() == 0
    assert len(relay.received) == 1
    assert client.get(f"/api/feedback/{body['id']}").json()["status"] == "sent"


def test_sender_backs_off_exponentially(client: TestClient, relay: FakeRelay) -> None:
    body = feedback_body()
    client.post("/api/feedback", json=body)
    clock = Clock()
    sender = sender_for(relay.url, clock)
    relay.answers = [(503, {"status": "upstream_error"}, {})] * 4
    waits = []
    for _ in range(4):
        assert sender.run_once() == 0
        waits.append(sender.paused_until - clock.now)
        assert sender.run_once() == 0  # paused: no request
        clock.now = sender.paused_until
    assert waits == [30.0, 60.0, 120.0, 240.0]  # jitter fixed at the middle
    assert len(relay.received) == 4
    saved = row(body["id"])
    assert saved.status == FeedbackStatus.pending
    assert saved.attempts == 4
    assert "503" in (saved.last_error or "")
    assert sender.run_once() == 1  # the relay is back
    assert row(body["id"]).status == FeedbackStatus.sent
    assert sender.failures == 0


def test_backoff_is_capped_and_honours_retry_after() -> None:
    sender = sender_for("http://127.0.0.1:1/feedback")
    assert sender.delay(30) == feedback_sender.MAX_DELAY
    assert sender.delay(300, feedback_sender.MAX_DELAY_ERROR) == feedback_sender.MAX_DELAY_ERROR
    sender.jitter = lambda: 0.0
    assert sender.delay(1) == pytest.approx(24.0)
    sender.jitter = lambda: 1.0
    assert sender.delay(1) == pytest.approx(36.0)


def test_retry_after_is_respected(client: TestClient, relay: FakeRelay) -> None:
    client.post("/api/feedback", json=feedback_body())
    clock = Clock()
    sender = sender_for(relay.url, clock)
    relay.answers = [(429, {"status": "rate_limited"}, {"Retry-After": "900"})]
    sender.run_once()
    assert sender.paused_until - clock.now == 900.0


def test_new_feedback_tries_again_at_once(client: TestClient, relay: FakeRelay) -> None:
    client.post("/api/feedback", json=feedback_body())
    clock = Clock()
    sender = sender_for(relay.url, clock)
    relay.answers = [(502, {}, {})]
    sender.run_once()
    assert sender.run_once() == 0
    sender.wake()
    assert sender.run_once() == 1


def test_errors_back_off_to_a_day_offline_to_an_hour(client: TestClient, relay: FakeRelay) -> None:
    client.post("/api/feedback", json=feedback_body())
    clock = Clock()
    sender = sender_for(relay.url, clock)
    relay.answers = [(404, {"error": "not found"}, {})] * 20
    for _ in range(20):
        sender.run_once()
        clock.now = sender.paused_until
    assert sender.delay(sender.failures, feedback_sender.MAX_DELAY_ERROR) == 86_400.0
    assert row(relay.received[0]["id"]).status == FeedbackStatus.pending  # never final
    offline = sender_for(relay.url.rsplit(":", 1)[0] + ":9/feedback", Clock())
    offline.failures = 19
    offline.run_once()
    assert offline.paused_until - offline.clock() == feedback_sender.MAX_DELAY


def test_offline_keeps_it_waiting(client: TestClient, relay: FakeRelay) -> None:
    body = feedback_body()
    client.post("/api/feedback", json=body)
    offline = relay.url.rsplit(":", 1)[0] + ":9/feedback"
    sender = sender_for(offline)
    assert sender.run_once() == 0
    saved = row(body["id"])
    assert saved.status == FeedbackStatus.pending
    assert saved.attempts == 1
    assert (saved.last_error or "").startswith("Couldn't reach the feedback inbox")
    assert (config.feedback_dir() / f"{body['id']}.jpg").is_file()  # kept until sent


def test_turned_down_is_failed_and_not_retried(client: TestClient, relay: FakeRelay) -> None:
    first, second = feedback_body(), feedback_body()
    client.post("/api/feedback", json=first)
    client.post("/api/feedback", json=second)
    relay.answers = [(400, {"status": "invalid", "error": "bad"}, {})]
    sender = sender_for(relay.url)
    assert sender.run_once() == 1  # the other one still goes
    statuses = {row(first["id"]).status, row(second["id"]).status}
    assert statuses == {FeedbackStatus.failed, FeedbackStatus.sent}
    assert sender.run_once() == 0
    assert len(relay.received) == 2
    # Neither picture is kept: one was sent, the other can never be.
    assert list(config.feedback_dir().glob("*.jpg")) == []


def test_too_large_tries_once_slim_then_gives_up(client: TestClient, relay: FakeRelay) -> None:
    body = feedback_body()
    client.post("/api/feedback", json=body)
    relay.answers = [(413, {"status": "too_large"}, {})]
    assert sender_for(relay.url).run_once() == 1
    first, second = relay.received
    assert first["screenshot"] is not None and second["screenshot"] is None
    assert row(body["id"]).status == FeedbackStatus.sent

    other = feedback_body()
    client.post("/api/feedback", json=other)
    relay.answers = [(413, {"status": "too_large"}, {})] * 2
    assert sender_for(relay.url).run_once() == 0
    saved = row(other["id"])
    assert saved.status == FeedbackStatus.failed
    assert not (config.feedback_dir() / f"{other['id']}.jpg").exists()


def test_the_least_tried_goes_first(client: TestClient, relay: FakeRelay) -> None:
    stuck, fresh = feedback_body(), feedback_body()
    client.post("/api/feedback", json=stuck)
    clock = Clock()
    sender = sender_for(relay.url, clock)
    relay.answers = [(500, {}, {})]
    sender.run_once()
    client.post("/api/feedback", json=fresh)
    sender.wake()
    relay.answers = [(500, {}, {})]
    sender.run_once()
    assert relay.received[-1]["id"] == fresh["id"]


def test_a_lost_answer_is_filed_once(client: TestClient, relay: FakeRelay) -> None:
    """The relay filed it but the answer was lost: the retry gets the same issue."""
    body = feedback_body()
    client.post("/api/feedback", json=body)
    url = "https://github.com/example/feedback/issues/7"
    relay.filed[body["id"]] = url
    relay.answers = [(504, {}, {})]  # filed, but the answer never arrived
    clock = Clock()
    sender = sender_for(relay.url, clock)
    sender.run_once()
    clock.now = sender.paused_until
    sender.run_once()
    assert row(body["id"]).remote_ref == url
    assert [r["id"] for r in relay.received] == [body["id"], body["id"]]


def test_disabled_sends_nothing(client: TestClient) -> None:
    client.post("/api/feedback", json=feedback_body())
    assert sender_for("").run_once() == 0
    assert sender_for("http://example.com/feedback").run_once() == 0
    assert feedback_sender.start_if_enabled() is None


def test_a_missing_picture_still_sends(client: TestClient, relay: FakeRelay) -> None:
    body = feedback_body()
    client.post("/api/feedback", json=body)
    (config.feedback_dir() / f"{body['id']}.jpg").unlink()
    assert sender_for(relay.url).run_once() == 1
    assert relay.received[0]["screenshot"] is None


def test_browser_errors_are_redacted(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from pathlib import PureWindowsPath

    monkeypatch.setattr(diagnostics.Path, "home", lambda: PureWindowsPath(r"C:\Users\Kabir Mehta"))
    monkeypatch.setenv("USERNAME", "Kabir Mehta")
    body = feedback_body(
        client={"errors": [{"kind": "error", "message": r"at file:///C:/Users/Kabir%20Mehta/x.js"}]}
    )
    client.post("/api/feedback", json=body)
    diag = json.loads(row(body["id"]).diagnostics)
    assert diag["client"]["errors"][0]["message"] == "at file:///~/x.js"


def test_picture_is_dropped_after_three_failed_tries(client: TestClient, relay: FakeRelay) -> None:
    body = feedback_body()
    client.post("/api/feedback", json=body)
    clock = Clock()
    sender = sender_for(relay.url, clock)
    relay.answers = [(503, {"status": "upstream_error"}, {})] * 3
    for _ in range(4):
        sender.run_once()
        clock.now = sender.paused_until
    pictures = [r["screenshot"] is not None for r in relay.received]
    assert pictures == [True, True, True, False]
    assert row(body["id"]).status == FeedbackStatus.sent


def test_being_offline_doesnt_cost_the_picture(client: TestClient, relay: FakeRelay) -> None:
    client.post("/api/feedback", json=feedback_body())
    clock = Clock()
    offline = sender_for(relay.url.rsplit(":", 1)[0] + ":9/feedback", clock)
    for _ in range(5):
        offline.run_once()
        clock.now = offline.paused_until
    assert offline.item_failures == {}
    offline.url = lambda: relay.url
    offline.run_once()
    assert relay.received[0]["screenshot"] is not None


def test_route_is_the_path_only(client: TestClient) -> None:
    body = feedback_body(route="/students?q=Ananya%20Rao#top")
    client.post("/api/feedback", json=body)
    assert row(body["id"]).route == "/students"


def test_running_app_sends_in_the_background(
    relay: FakeRelay, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The real thing: startup starts the sender, saving wakes it, the dialog sees 'sent'."""
    monkeypatch.setenv("SCRAPPY_FEEDBACK_URL", relay.url)
    with TestClient(create_app(), base_url="http://127.0.0.1:8765") as c:
        body = feedback_body()
        saved = c.post("/api/feedback", json=body).json()
        assert saved["sending"] is True
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            status = c.get(f"/api/feedback/{body['id']}").json()
            if status["status"] == "sent":
                break
            time.sleep(0.05)
        assert status["status"] == "sent"
        assert status["sending"] is False
        assert c.get("/api/about").json()["feedback_waiting"] == 0


def test_waiting_feedback_is_sent_at_startup(
    client: TestClient, relay: FakeRelay, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = feedback_body()
    client.post("/api/feedback", json=body)  # saved while sending was off
    dispose_engines()
    monkeypatch.setenv("SCRAPPY_FEEDBACK_URL", relay.url)
    with TestClient(create_app(), base_url="http://127.0.0.1:8765") as c:
        deadline = time.monotonic() + 10
        while c.get(f"/api/feedback/{body['id']}").json()["status"] != "sent":
            assert time.monotonic() < deadline
            time.sleep(0.05)


# --------------------------------------------------------------------------- about, build ID


def test_about(client: TestClient) -> None:
    client.post("/api/feedback", json=feedback_body())
    about = client.get("/api/about").json()
    assert about["version"] == __version__
    assert about["build_id"] == app_package.build_id()
    assert about["data_dir"] == str(config.data_dir())
    assert about["backup_dir"] == str(config.backup_dir())
    assert about["log_dir"] == str(config.log_dir())
    assert about["feedback_sending"] is False
    assert about["feedback_waiting"] == 1


def test_build_id_sources(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    build_file = Path(app_package.__file__).resolve().parent.parent / "BUILD_ID"
    assert not build_file.exists()  # only the bundle has one
    app_package.build_id.cache_clear()
    try:
        monkeypatch.setenv("SCRAPPY_BUILD_ID", "0123456789abcdef0123456789abcdef01234567")
        assert app_package.build_id() == "0123456789abcdef0123456789abcdef01234567"
        app_package.build_id.cache_clear()
        monkeypatch.setenv("SCRAPPY_BUILD_ID", "not valid!")
        assert app_package.build_id() != "not valid!"
        app_package.build_id.cache_clear()
        build_file.write_text("feedc0de" * 5 + "\n", encoding="utf-8")
        assert app_package.build_id() == "feedc0de" * 5
    finally:
        build_file.unlink(missing_ok=True)
        app_package.build_id.cache_clear()


# --------------------------------------------------------------------------- v0.1.0 data


def test_feedback_on_upgraded_v0_1_0_data() -> None:
    """A laptop with v0.1.0's data upgrades (adding only the feedback table), keeps every
    record, and can then save feedback."""
    source = FIXTURES / "v0.1.0.db"
    config.data_dir().mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, config.db_path())

    def records(db: Path) -> list[tuple[Any, ...]]:
        """Every value v0.1.0 stored (later columns, like students.uid, aren't compared)."""
        rows: list[tuple[Any, ...]] = []
        with sqlite3.connect(source) as old, sqlite3.connect(db) as conn:
            for table in ("students", "fee_changes", "payments"):
                columns = ", ".join(r[1] for r in old.execute(f"PRAGMA table_info({table})"))
                rows += conn.execute(f"SELECT {columns} FROM {table} ORDER BY id").fetchall()
        return rows

    before = records(source)
    with TestClient(create_app(), base_url="http://127.0.0.1:8765") as c:
        assert c.post("/api/feedback", json=feedback_body()).status_code == 201
        assert c.get("/api/about").json()["feedback_waiting"] == 1
    dispose_engines()
    assert records(config.db_path()) == before
    with sqlite3.connect(config.db_path()) as conn:
        assert conn.execute("SELECT version_num FROM alembic_version").fetchone() == ("0005",)
        assert conn.execute("SELECT count(*) FROM feedback").fetchone() == (1,)


# --------------------------------------------------------------------------- fuzz

_any_text = st.one_of(
    st.text(max_size=30),
    st.text(st.characters(codec=None, exclude_categories=()), max_size=10),
    st.sampled_from(["\x00", "\ud800", "", "   "]),
)
_anything = st.one_of(
    st.none(),
    st.booleans(),
    st.integers(-(2**70), 2**70),
    st.floats(),
    _any_text,
    st.lists(_any_text, max_size=2),
    st.dictionaries(_any_text, _any_text, max_size=2),
)


@settings(
    max_examples=200,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow],
)
@given(
    fields=st.dictionaries(
        st.sampled_from(["id", "message", "route", "client", "screenshot", "category"]),
        _anything,
        max_size=4,
    ),
    client_fields=st.dictionaries(
        st.sampled_from(["local_time", "user_agent", "errors", "screen", "odd"]),
        st.one_of(_anything, st.lists(st.dictionaries(_any_text, _anything, max_size=3))),
        max_size=3,
    ),
    picture=st.one_of(st.binary(max_size=40), st.just(JPEG), st.just(PNG)),
)
def test_feedback_fuzz_never_500(
    client: TestClient, fields: dict[str, Any], client_fields: dict[str, Any], picture: bytes
) -> None:
    body = {
        "category": "idea",
        "message": "hi",
        "client": client_fields,
        "screenshot": b64(picture),
    }
    body.update(fields)
    response = client.post(
        "/api/feedback",
        content=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )
    assert response.status_code < 500, (body, response.text)
