"""Fail a PR that changes what the user sees without updating docs/feature-guide.md.

    python3 scripts/ci/check_feature_guide.py --base origin/main [--head HEAD]
    python3 scripts/ci/check_feature_guide.py --files frontend/src/pages/x.tsx docs/feature-guide.md

The *Feature guide* workflow runs it on every pull request, with the PR's labels in
`PR_LABELS` (comma-separated). A PR labelled `no-guide-change` always passes. Standard library
only, so it runs on any Python 3.
"""

from __future__ import annotations

import argparse
import fnmatch
import os
import subprocess
import sys

GUIDE = "docs/feature-guide.md"
SKIP_LABEL = "no-guide-change"

# Changes here can change what the user sees or can do.
USER_FACING = (
    "frontend/src/*",
    "backend/app/routers/*",
    "backend/app/services/*",
    "backend/app/schemas.py",
)
# ...except these, which never reach the user.
NOT_USER_FACING = (
    "*.test.*",
    "frontend/src/test/*",
    "frontend/src/mocks/*",
)


def user_facing(path: str) -> bool:
    return any(fnmatch.fnmatchcase(path, p) for p in USER_FACING) and not any(
        fnmatch.fnmatchcase(path, p) for p in NOT_USER_FACING
    )


def changed_files(base: str, head: str) -> list[str]:
    """Files changed on `head` since it branched from `base` (like the PR's "Files" tab)."""
    out = subprocess.run(
        ["git", "diff", "--name-only", f"{base}...{head}"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [line for line in out.splitlines() if line]


def check(files: list[str], labels: list[str]) -> tuple[bool, str]:
    """(passed, message) for a PR changing `files` with `labels`."""
    if SKIP_LABEL in labels:
        return True, f"Skipped: this PR has the '{SKIP_LABEL}' label."
    touched = [f for f in files if user_facing(f)]
    if not touched:
        return True, "Nothing the user sees has changed, so the feature guide needn't change."
    if GUIDE in files:
        return True, f"The feature guide is updated ({len(touched)} user-facing file(s) changed)."
    listing = "\n".join(f"  - {f}" for f in touched[:20])
    more = f"\n  … and {len(touched) - 20} more" if len(touched) > 20 else ""
    return False, (
        "This PR changes files that affect what the user sees or can do:\n"
        f"{listing}{more}\n\n"
        f"but it doesn't update the feature guide ({GUIDE}).\n\n"
        "What to do:\n"
        f"  1. Update {GUIDE} to describe the change: the screen's section, the words-and-colours\n"
        "     table and Everyday situations, as needed. Retake the pictures with\n"
        "     `make guide-screenshots` if a screen changed noticeably.\n"
        f"  2. Or, if the user really sees no difference (a refactor, a speed-up), add the\n"
        f"     '{SKIP_LABEL}' label to the PR. This check then re-runs and passes.\n\n"
        "See CONTRIBUTING.md, 'Keep the feature guide up to date'."
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", help="The branch or commit the PR goes into")
    parser.add_argument("--head", default="HEAD", help="The PR's last commit (default: HEAD)")
    parser.add_argument("--files", nargs="*", help="Check these paths instead of a git diff")
    parser.add_argument("--labels", help="Comma-separated labels (default: $PR_LABELS)")
    args = parser.parse_args(argv)

    if args.files is None and not args.base:
        parser.error("give --base (and optionally --head), or --files")
    files = args.files if args.files is not None else changed_files(args.base, args.head)
    raw = args.labels if args.labels is not None else os.environ.get("PR_LABELS", "")
    labels = [label.strip() for label in raw.split(",") if label.strip()]

    passed, message = check(files, labels)
    if passed:
        print(message)
        return 0
    print(message, file=sys.stderr)
    if os.environ.get("GITHUB_ACTIONS"):
        print(
            f"::error title=Feature guide not updated::Update {GUIDE}, or add the "
            f"'{SKIP_LABEL}' label if the user sees no difference."
        )
    return 1


if __name__ == "__main__":
    sys.exit(main())
