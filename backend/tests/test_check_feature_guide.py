"""The CI check that a PR changing what the user sees also updates docs/feature-guide.md."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "ci" / "check_feature_guide.py"
_spec = importlib.util.spec_from_file_location("check_feature_guide", SCRIPT)
assert _spec and _spec.loader
guide = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guide)


@pytest.mark.parametrize(
    "path",
    [
        "frontend/src/pages/dashboard-page.tsx",
        "frontend/src/components/log-payment.tsx",
        "frontend/src/lib/format.ts",
        "frontend/src/index.css",
        "backend/app/routers/payments.py",
        "backend/app/services/ledger.py",
        "backend/app/schemas.py",
    ],
)
def test_user_facing(path: str) -> None:
    assert guide.user_facing(path)


@pytest.mark.parametrize(
    "path",
    [
        "frontend/src/pages/dashboard-page.test.tsx",
        "frontend/src/lib/format.test.ts",
        "frontend/src/mocks/ledger.ts",
        "frontend/src/test/render.tsx",
        "frontend/e2e/records.spec.ts",
        "backend/app/models.py",
        "backend/tests/test_ledger.py",
        "docs/runbooks/daily-use.md",
        "scripts/install.ps1",
    ],
)
def test_not_user_facing(path: str) -> None:
    assert not guide.user_facing(path)


def test_fails_when_the_ui_changes_without_the_guide() -> None:
    passed, message = guide.check(["frontend/src/pages/payments-page.tsx"], [])
    assert not passed
    assert "frontend/src/pages/payments-page.tsx" in message
    assert "docs/feature-guide.md" in message
    assert "no-guide-change" in message


def test_passes_with_the_guide_or_the_label() -> None:
    ui = ["backend/app/services/ledger.py"]
    assert guide.check([*ui, "docs/feature-guide.md"], [])[0]
    assert guide.check(ui, ["documentation", "no-guide-change"])[0]


def test_passes_when_nothing_user_facing_changed() -> None:
    assert guide.check(["frontend/src/mocks/db.ts", "README.md"], [])[0]
    assert guide.check([], [])[0]


def test_main_exit_codes(capsys: pytest.CaptureFixture[str]) -> None:
    assert guide.main(["--files", "frontend/src/App.tsx", "--labels", ""]) == 1
    assert "doesn't update the feature guide" in capsys.readouterr().err
    assert guide.main(["--files", "frontend/src/App.tsx", "--labels", "no-guide-change"]) == 0
