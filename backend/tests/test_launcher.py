"""The Desktop-shortcut launcher, including a real start of the server in a subprocess."""

from __future__ import annotations

import contextlib
import http.server
import json
import logging
import socket
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest

from app import launcher, logs


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextlib.contextmanager
def _fake_server(body: bytes, status: int = 200) -> Iterator[int]:
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: object) -> None:
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture(autouse=True)
def headless(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SCRAPPY_NO_BROWSER", "1")
    monkeypatch.setenv("SCRAPPY_NO_DIALOG", "1")


@pytest.fixture(autouse=True)
def _restore_logging() -> Iterator[None]:
    root = logging.getLogger()
    before = list(root.handlers), root.level
    yield
    for h in list(root.handlers):
        if h not in before[0]:
            root.removeHandler(h)
            h.close()
    root.setLevel(before[1])


def test_health_down_when_nothing_listens() -> None:
    port = _free_port()
    assert launcher.port_is_free(port)
    assert launcher.check_health(port) is launcher.Status.DOWN


def test_health_recognises_our_app() -> None:
    body = json.dumps({"app": "scrappy-records", "version": "0.1.0", "status": "ok"}).encode()
    with _fake_server(body) as port:
        assert not launcher.port_is_free(port)
        assert launcher.check_health(port) is launcher.Status.OURS


@pytest.mark.parametrize(
    ("body", "status"),
    [(b'{"app": "something-else"}', 200), (b"<html>hello</html>", 200), (b"nope", 404)],
)
def test_health_other_program(body: bytes, status: int) -> None:
    with _fake_server(body, status) as port:
        assert launcher.check_health(port) is launcher.Status.OTHER


def test_port_taken_by_another_program_shows_a_message(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    with _fake_server(b"<html>someone else</html>") as port:
        monkeypatch.setenv("SCRAPPY_PORT", str(port))
        assert launcher.main() == 1
    err = capsys.readouterr().err
    assert f"port {port}" in err
    assert str(logs.log_file()) in err


def test_bad_port_setting_shows_a_message(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("SCRAPPY_PORT", "eighty")
    assert launcher.main() == 1
    assert "SCRAPPY_PORT" in capsys.readouterr().err


def test_single_instance_lock_blocks_a_second_holder() -> None:
    with launcher.single_instance():
        started = threading.Event()
        got_it = threading.Event()

        def second() -> None:
            started.set()
            with launcher.single_instance(timeout=5):
                got_it.set()

        # fcntl/msvcrt locks are per open file, so a second handle in another thread
        # contends just like another process would.
        t = threading.Thread(target=second)
        t.start()
        started.wait()
        assert not got_it.wait(0.5)
    t.join(5)
    assert got_it.is_set()


def test_launcher_starts_the_server_and_reuses_it(
    monkeypatch: pytest.MonkeyPatch, scrappy_home: Path
) -> None:
    port = _free_port()
    monkeypatch.setenv("SCRAPPY_PORT", str(port))
    proc = launcher.ensure_server(port)
    try:
        assert proc is not None, "nothing was running, so the launcher should start the server"
        assert launcher.check_health(port) is launcher.Status.OURS
        # A second launch finds it and starts nothing.
        assert launcher.ensure_server(port) is None
        assert launcher.main() == 0
        assert (scrappy_home / "data" / "records.db").is_file()
        log_text = logs.log_file().read_text(encoding="utf-8")
        assert "Starting Scrappy Records" in log_text
        assert "Application startup complete" in log_text
    finally:
        if proc is not None:
            proc.terminate()
            proc.wait(10)


def test_logs_setup_is_idempotent(scrappy_home: Path) -> None:
    logs.setup(rotate=True)
    logs.setup(rotate=True)
    ours = [h for h in logging.getLogger().handlers if getattr(h, "scrappy", False)]
    assert len(ours) == 1
    logging.getLogger("scrappy.test").info("hello from the test")
    assert "hello from the test" in logs.log_file().read_text(encoding="utf-8")
    assert logs.log_file().parent == scrappy_home / "logs"
