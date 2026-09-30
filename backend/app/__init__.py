"""Scrappy Records backend."""

from __future__ import annotations

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
