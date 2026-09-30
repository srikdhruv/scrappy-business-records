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
        "backend/app/launcher.py",
        "backend/app/backup.py",
        "backend/app/main.py",
        "backend/app/clock.py",
        "backend/app/months.py",
        "frontend/index.html",
        "frontend/public/favicon.svg",
        "scripts/install.ps1",
        "scripts/install.sh",
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
        "backend/app/seed.py",
        "scripts/build_bundle.py",
        "backend/tests/test_ledger.py",
        "docs/runbooks/daily-use.md",
        "scripts/ci/smoke_install_windows.ps1",
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


def test_regenerated_api_types_or_ui_building_blocks_alone_pass() -> None:
    assert guide.check(["frontend/src/api/schema.d.ts"], [])[0]
    assert guide.check(["frontend/src/components/ui/button.tsx", "README.md"], [])[0]
    assert guide.check(
        ["frontend/src/api/schema.d.ts", "frontend/src/components/ui/dialog.tsx"], []
    )[0]


def test_but_not_together_with_a_real_change() -> None:
    passed, message = guide.check(["frontend/src/api/schema.d.ts", "backend/app/schemas.py"], [])
    assert not passed
    assert "backend/app/schemas.py" in message
    assert not guide.check(
        ["frontend/src/components/ui/button.tsx", "frontend/src/pages/students-page.tsx"], []
    )[0]


def test_installer_and_startup_changes_need_the_guide() -> None:
    assert not guide.check(["scripts/install.ps1"], [])[0]
    assert not guide.check(["backend/app/backup.py"], [])[0]
