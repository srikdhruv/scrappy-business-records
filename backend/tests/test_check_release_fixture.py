"""The release gate: the release before this one must have its saved-data sample (ADR 0004)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "ci" / "check_release_fixture.py"
_spec = importlib.util.spec_from_file_location("check_release_fixture", SCRIPT)
assert _spec and _spec.loader
gate = sys.modules[_spec.name] = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)

TAGS = ["v0.1.0", "v0.2.0", "v0.10.0", "v0.9.1", "backup/main", "v1.0.0-rc1"]


@pytest.mark.parametrize(
    ("tag", "previous"),
    [
        ("v0.1.0", None),
        ("v0.1.1", "v0.1.0"),
        ("v0.2.0", "v0.1.0"),
        ("v0.10.0", "v0.9.1"),  # by version, not alphabetically
        ("v0.11.0", "v0.10.0"),
    ],
)
def test_previous_release(tag: str, previous: str | None) -> None:
    assert gate.previous_release(tag, TAGS) == previous


def test_latest_release() -> None:
    assert gate.latest_release(TAGS) == "v0.10.0"
    assert gate.latest_release(["backup/main"]) is None


def test_the_first_release_needs_no_sample() -> None:
    assert gate.main(["--tag", "v0.1.0"], tags=["v0.1.0"]) == 0


def test_the_next_release_needs_the_previous_sample(capsys: pytest.CaptureFixture[str]) -> None:
    # v0.1.0's sample is committed, so v0.1.1 may be released.
    assert gate.main(["--tag", "v0.1.1"], tags=["v0.1.0", "v0.1.1"]) == 0
    # v0.1.1's isn't (yet), so v0.1.2 may not.
    assert gate.main(["--tag", "v0.1.2"], tags=["v0.1.0", "v0.1.1", "v0.1.2"]) == 1
    out = capsys.readouterr().out
    assert "::error::v0.1.1 has no saved-data sample" in out
    assert "make_release_fixture.py v0.1.1" in out


def test_warn_mode_never_fails(capsys: pytest.CaptureFixture[str]) -> None:
    assert gate.main(["--latest", "--warn"], tags=["v0.1.0", "v0.1.1"]) == 0
    assert "::warning::v0.1.1" in capsys.readouterr().out


def test_every_committed_sample_is_complete() -> None:
    for db in gate.FIXTURES.glob("v*.db"):
        assert gate.missing(db.stem) == []
