"""Fail a release if the previous release has no saved-data sample (ADR 0004).

    python3 scripts/ci/check_release_fixture.py --tag v0.1.1     # the release workflow
    python3 scripts/ci/check_release_fixture.py --latest --warn  # CI: a reminder, never fails

Every release's data must upgrade intact, which `backend/tests/test_release_upgrades.py` tests
using `backend/tests/fixtures/releases/<tag>.db` and `<tag>.json`. So before releasing vY, the
release before it (vX) must have its sample: after releasing vX, run
`scripts/make_release_fixture.py vX` and commit the two files via a PR.

Reads the version tags (`v1.2.3`) with git, so the checkout needs them (`fetch-depth: 0`).
Standard library only.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "backend" / "tests" / "fixtures" / "releases"
VERSION_TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")


def version(tag: str) -> tuple[int, int, int] | None:
    match = VERSION_TAG.match(tag)
    return (int(match[1]), int(match[2]), int(match[3])) if match else None


def git_tags() -> list[str]:
    out = subprocess.run(
        ["git", "tag", "--list", "v*"], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout
    return out.split()


def previous_release(tag: str, tags: list[str]) -> str | None:
    """The newest version tag before `tag`, or None if `tag` is the first release."""
    current = version(tag)
    if current is None:
        raise ValueError(f"{tag} isn't a version tag like v1.2.3")
    earlier = [t for t in tags if (v := version(t)) is not None and v < current]
    return max(earlier, key=version, default=None)  # type: ignore[arg-type]


def latest_release(tags: list[str]) -> str | None:
    return max((t for t in tags if version(t)), key=version, default=None)  # type: ignore[arg-type]


def missing(tag: str, fixtures: Path = FIXTURES) -> list[str]:
    return [f"{tag}{ext}" for ext in (".db", ".json") if not (fixtures / f"{tag}{ext}").is_file()]


def main(argv: list[str] | None = None, tags: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    which = parser.add_mutually_exclusive_group(required=True)
    which.add_argument("--tag", help="the release being made: check the one before it")
    which.add_argument("--latest", action="store_true", help="check the newest release tag")
    parser.add_argument("--warn", action="store_true", help="only warn, never fail")
    args = parser.parse_args(argv)
    tags = git_tags() if tags is None else tags

    needed = latest_release(tags) if args.latest else previous_release(args.tag, tags)
    if needed is None:
        print("No earlier release, so no saved-data sample is needed yet.")
        return 0
    absent = missing(needed)
    if not absent:
        print(f"OK: {needed} has its saved-data sample in {FIXTURES.relative_to(ROOT)}.")
        return 0
    level = "warning" if args.warn else "error"
    print(
        f"::{level}::{needed} has no saved-data sample ({', '.join(absent)} missing in "
        f"{FIXTURES.relative_to(ROOT)}). Run `python3 scripts/make_release_fixture.py {needed}` "
        "and commit the files via a PR (docs/runbooks/release.md)."
    )
    return 0 if args.warn else 1


if __name__ == "__main__":
    sys.exit(main())
