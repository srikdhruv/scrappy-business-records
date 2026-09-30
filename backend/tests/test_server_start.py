"""`python -m app` must start under `pythonw`, where there is no console at all."""

import logging
import sys

import pytest

from app import __main__ as entry


def no_console(monkeypatch: pytest.MonkeyPatch) -> None:
    """Simulate pythonw. Call inside the test body: pytest's output capture re-sets sys.stdout
    and sys.stderr between fixture setup and the test."""
    monkeypatch.setattr(sys, "stdout", None)
    monkeypatch.setattr(sys, "stderr", None)


@pytest.fixture
def restore_root_logger():
    root = logging.getLogger()
    handlers, level = list(root.handlers), root.level
    yield root
    root.handlers[:] = handlers
    root.setLevel(level)


def test_server_config_without_console(monkeypatch: pytest.MonkeyPatch) -> None:
    no_console(monkeypatch)
    monkeypatch.setenv("SCRAPPY_PORT", "9123")
    cfg = entry.server_config()  # uvicorn configures logging here; must not raise
    assert cfg.host == "127.0.0.1"
    assert cfg.port == 9123
    assert cfg.log_config is None
    assert cfg.use_colors is False


def test_console_logging_skipped_without_console(
    monkeypatch: pytest.MonkeyPatch, restore_root_logger
) -> None:
    no_console(monkeypatch)
    before = list(restore_root_logger.handlers)
    entry.configure_console_logging()
    assert restore_root_logger.handlers == before
    logging.getLogger("uvicorn.error").info("no console, no crash")


def test_console_logging_with_console(restore_root_logger) -> None:
    before = len(restore_root_logger.handlers)
    entry.configure_console_logging()
    assert len(restore_root_logger.handlers) == before + 1
