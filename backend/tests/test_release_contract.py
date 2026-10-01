"""What older apps rely on when they update to a newer release (docs/runbooks/release.md,
"Updating from inside the app: what must keep working"). These fail if an installer is renamed
or moved, loses an option older apps pass, or stops being published with the release."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app import updater

REPO = Path(__file__).resolve().parents[2]
SCRIPTS = REPO / "scripts"
RELEASE = (REPO / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")


def _publish_job() -> str:
    start = RELEASE.index("\n  publish:\n")
    end = RELEASE.index("\n  verify-candidate:\n", start)
    return RELEASE[start:end]


def test_the_installers_are_where_releases_take_them_from() -> None:
    assert set(updater.SCRIPTS.values()) == {"install.ps1", "install.sh"}
    for name in updater.SCRIPTS.values():
        assert (SCRIPTS / name).is_file(), f"scripts/{name} moved or renamed"
    assert updater.ASSETS == {
        "windows": "scrappy-records-windows-x64.zip",
        "macos": "scrappy-records-macos-arm64.zip",
    }
    assert updater.SUMS == "SHA256SUMS"


def test_every_release_publishes_the_installers_and_their_checksums() -> None:
    publish = _publish_job()
    files = ["scrappy-records-windows-x64.zip", "scrappy-records-macos-arm64.zip"]
    files += ["install.ps1", "install.sh"]
    assert "cp scripts/install.ps1 scripts/install.sh dist/" in publish
    sums = publish[publish.index("sha256sum") : publish.index("> SHA256SUMS")]
    for name in files:
        assert name in sums, f"SHA256SUMS doesn't cover {name}"
    create = publish[publish.index("gh release create") :]
    for name in [*files, "SHA256SUMS"]:
        assert f"dist/{name}" in create, f"the release doesn't upload {name}"
    # Immutable releases: every file goes in while it's a draft, then it's published.
    assert "--draft" in create
    assert "--draft=false --prerelease" in publish


def test_a_release_is_only_promoted_after_the_in_app_update_works() -> None:
    promote = RELEASE[RELEASE.index("\n  promote:\n") :]
    needs = re.search(r"needs: \[([^\]]*)\]", promote)
    assert needs is not None
    assert {"verify-candidate", "verify-in-app"} <= {n.strip() for n in needs.group(1).split(",")}
    in_app = RELEASE[RELEASE.index("\n  verify-in-app:\n") : RELEASE.index("\n  promote:\n")]
    assert "--release-tag" in in_app
    assert "SCRAPPY_INSTALL_ZIP" not in in_app and "--zip" not in in_app


@pytest.mark.parametrize(
    ("script", "needles"),
    [
        (
            "install.ps1",
            [
                "[string]$Version",
                "SCRAPPY_UPDATE_FROM_APP",
                "SCRAPPY_INSTALL_ROOT",
                "SHA256SUMS",
                "Get-FileHash",
                "SCRAPPY_AFTER_UPDATE",
            ],
        ),
        (
            "install.sh",
            [
                "--version)",
                "SCRAPPY_UPDATE_FROM_APP",
                "SCRAPPY_INSTALL_ROOT",
                "SHA256SUMS",
                "shasum -a 256",
                "SCRAPPY_AFTER_UPDATE",
            ],
        ),
    ],
)
def test_the_installers_still_take_what_older_apps_pass(script: str, needles: list[str]) -> None:
    text = (SCRIPTS / script).read_text(encoding="utf-8")
    for needle in needles:
        assert needle in text, f"{script} no longer has {needle}"


def test_install_ps1_stays_ascii_and_never_exits() -> None:
    raw = (SCRIPTS / "install.ps1").read_bytes()
    assert raw.isascii(), "PowerShell 5.1 misreads non-ASCII in files without a BOM"
    code = "\n".join(
        line for line in raw.decode().splitlines() if not line.lstrip().startswith("#")
    )
    assert not re.search(r"(?m)^\s*exit\b", code), "`exit` closes the user's window under iex"
