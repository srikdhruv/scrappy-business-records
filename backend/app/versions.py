"""Version numbers: parse and compare them the way semver (semver.org, 2.0.0) does.

`0.10.0` is newer than `0.9.0` (numbers, not text), and a prerelease such as `1.0.0-rc.1` is
older than `1.0.0`. Build metadata (`+abc`) is ignored when comparing. A leading `v` (a tag,
`v0.3.0`) is accepted. Anything else isn't a version: `parse()` returns None.
"""

from __future__ import annotations

import functools
import re
from dataclasses import dataclass

_SEMVER = re.compile(
    r"^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})"
    r"(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)


@functools.total_ordering
@dataclass(frozen=True)
class Version:
    major: int
    minor: int
    patch: int
    prerelease: tuple[str, ...] = ()

    @property
    def is_prerelease(self) -> bool:
        return bool(self.prerelease)

    def __str__(self) -> str:
        core = f"{self.major}.{self.minor}.{self.patch}"
        return f"{core}-{'.'.join(self.prerelease)}" if self.prerelease else core

    def _key(self) -> tuple[int, int, int]:
        return (self.major, self.minor, self.patch)

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Version):
            return NotImplemented
        return self._key() == other._key() and self.prerelease == other.prerelease

    def __hash__(self) -> int:
        return hash((self._key(), self.prerelease))

    def __lt__(self, other: object) -> bool:
        if not isinstance(other, Version):
            return NotImplemented
        if self._key() != other._key():
            return self._key() < other._key()
        return _prerelease_lt(self.prerelease, other.prerelease)


def _prerelease_lt(a: tuple[str, ...], b: tuple[str, ...]) -> bool:
    """semver §11: no prerelease beats any prerelease; otherwise compare field by field
    (numbers numerically and below words; words as text); a longer list wins a tie."""
    if a == b:
        return False
    if not a:
        return False
    if not b:
        return True
    for x, y in zip(a, b, strict=False):
        if x == y:
            continue
        x_num, y_num = x.isdigit(), y.isdigit()
        if x_num and y_num:
            return int(x) < int(y)
        if x_num != y_num:
            return x_num  # numeric identifiers are lower than alphanumeric ones
        return x < y
    return len(a) < len(b)


def parse(text: object) -> Version | None:
    """`"0.3.0"`, `"v0.3.0"`, `"1.0.0-rc.1"`, `"0.1.0+local"` → a Version; anything else → None."""
    if not isinstance(text, str):
        return None
    match = _SEMVER.match(text.strip())
    if match is None:
        return None
    major, minor, patch, pre, _build = match.groups()
    return Version(int(major), int(minor), int(patch), tuple(pre.split(".")) if pre else ())


def is_newer(candidate: str | None, current: str | None) -> bool:
    """True if `candidate` is a later version than `current` (False if either isn't one)."""
    new, old = parse(candidate), parse(current)
    return new is not None and old is not None and new > old
