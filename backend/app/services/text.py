"""Text matching and sorting that works for any language, not just plain English letters.

SQLite's own `lower()` and `LIKE` only understand A-Z, so searching and sorting by name happen
in Python with `fold()`: case-insensitive and accent-insensitive ("Émile" sorts with "E" and
matches "emile"; "Ölund" matches "ölund" and "olund").
"""

from __future__ import annotations

import unicodedata


def fold(text: str) -> str:
    """Lower-case, with accents removed, for comparing and sorting."""
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def contains(haystack: str | None, needle: str) -> bool:
    """`needle` (already folded) appears in `haystack`, ignoring case and accents."""
    return bool(haystack) and needle in fold(haystack)  # type: ignore[arg-type]
