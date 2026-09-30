"""Fail a release if an earlier release has no saved-data sample (ADR 0004).

    python3 scripts/ci/check_release_fixture.py --tag v0.1.1     # the release workflow
    python3 scripts/ci/check_release_fixture.py --latest --warn  # CI: a reminder, never fails

Every release's data must upgrade intact, which `backend/tests/test_release_upgrades.py` tests
using `backend/tests/fixtures/releases/<tag>.db` and `<tag>.json`. So before releasing vY,
**every** release before it must have its sample: after releasing vX, run
`scripts/make_release_fixture.py vX` and commit the two files via a PR.

Release tags look like `v1.2.3`. Any other tag (`v1.0.0-rc1`, `backup/...`) isn't a release:
it is ignored as an earlier release, and releasing it is refused with a clear message.

Reads the tags with git, so the checkout needs them (`fetch-depth: 0`). Standard library only.
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
        ["git", "tag", "--list"], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout
    return out.split()


def releases(tags: list[str], before: str | None = None) -> list[str]:
    """Release tags (`vX.Y.Z`), oldest first; only those before `before`, if given."""
    limit = version(before) if before else None
    found = [t for t in tags if (v := version(t)) is not None and (limit is None or v < limit)]
    return sorted(found, key=lambda t: version(t) or (0, 0, 0))


def previous_release(tag: str, tags: list[str]) -> str | None:
    """The newest release before `tag`, or None if `tag` is the first."""
    earlier = releases(tags, before=tag)
    return earlier[-1] if earlier else None


def missing(tag: str, fixtures: Path = FIXTURES) -> list[str]:
    return [f"{tag}{ext}" for ext in (".db", ".json") if not (fixtures / f"{tag}{ext}").is_file()]


def main(argv: list[str] | None = None, tags: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    which = parser.add_mutually_exclusive_group(required=True)
    which.add_argument("--tag", help="the release being made: check every release before it")
    which.add_argument("--latest", action="store_true", help="check every release tag")
    parser.add_argument("--warn", action="store_true", help="only warn, never fail")
    args = parser.parse_args(argv)
    level = "warning" if args.warn else "error"
    failed = 0 if args.warn else 1

    if args.tag is not None and version(args.tag) is None:
        print(
            f"::{level}::{args.tag} isn't a release tag. Releases are tagged vMAJOR.MINOR.PATCH "
            "(for example v0.2.0, matching backend/pyproject.toml); release candidates and other "
            "tags aren't published (docs/runbooks/release.md)."
        )
        return failed

    tags = git_tags() if tags is None else tags
    ignored = sorted(t for t in tags if t.startswith("v") and version(t) is None)
    if ignored:
        print(f"Not release tags, so not checked: {', '.join(ignored)}")
    needed = releases(tags, before=args.tag)
    if not needed:
        print("No earlier release, so no saved-data sample is needed yet.")
        return 0

    absent = {tag: files for tag in needed if (files := missing(tag))}
    where = FIXTURES.relative_to(ROOT)
    if not absent:
        print(f"OK: every earlier release ({', '.join(needed)}) has its saved-data sample.")
        return 0
    for tag, files in absent.items():
        print(
            f"::{level}::{tag} has no saved-data sample ({', '.join(files)} missing in {where}). "
            f"Run `python3 scripts/make_release_fixture.py {tag}` and commit the files via a PR "
            "(docs/runbooks/release.md). On a hotfix branch cut from an older tag, cherry-pick "
            "the commits that added the samples instead."
        )
    return failed


if __name__ == "__main__":
    sys.exit(main())
