"""Scrappy Records backend."""

from __future__ import annotations

import functools
import os
import re
import subprocess
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

DISTRIBUTION_NAME = "scrappy-records"


def _read_version() -> str:
    # 1. Installed package metadata (dev via `uv sync`, or a wheel installed into the bundle).
    try:
        return version(DISTRIBUTION_NAME)
    except PackageNotFoundError:
        pass
    # 2. A `VERSION` file next to the package folder (the bundle layout, see docs/architecture.md).
    version_file = Path(__file__).resolve().parent.parent / "VERSION"
    if version_file.is_file():
        return version_file.read_text(encoding="utf-8").strip()
    return "0.0.0+unknown"


__version__ = _read_version()


BUILD_ID_FILENAME = "BUILD_ID"
_BUILD_ID_PATTERN = re.compile(r"^[0-9A-Za-z._-]{1,64}$")


@functools.cache
def build_id() -> str:
    """The exact code this copy runs: the git commit it was built from.

    1. A `BUILD_ID` file next to the package folder, written by `scripts/build_bundle.py` when
       the bundle is made (the laptop's case).
    2. `SCRAPPY_BUILD_ID`, for anything else that knows it.
    3. `git rev-parse HEAD` in a checkout (dev mode), with a `-dirty` suffix for local changes.
    4. "unknown".
    """
    candidates = []
    build_file = Path(__file__).resolve().parent.parent / BUILD_ID_FILENAME
    if build_file.is_file():
        candidates.append(build_file.read_text(encoding="utf-8", errors="replace").strip())
    candidates.append(os.environ.get("SCRAPPY_BUILD_ID", "").strip())
    for candidate in candidates:
        if _BUILD_ID_PATTERN.match(candidate):
            return candidate
    return _git_build_id() or "unknown"


def _git_build_id() -> str | None:
    repo = Path(__file__).resolve().parent.parent
    if not (repo.parent / ".git").exists():
        return None  # not a checkout (the installed app): never run git there
    try:
        sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        ).stdout.strip()
        dirty = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=no"],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        return None
    return f"{sha}-dirty" if dirty else sha
