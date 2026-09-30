"""Text matching and sorting that works for any language, not just plain English letters.

SQLite's own `lower()` and `LIKE` only understand A-Z, so searching and sorting by name happen
in Python with `fold()`: case-insensitive and accent-insensitive ("Émile" sorts with "E" and
matches "emile"; "Ölund" matches "ölund" and "olund").
"""

from __future__ import annotations

import re
import unicodedata


def fold(text: str) -> str:
    """Lower-case, with accents removed, for comparing and sorting."""
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    return "".join(c for c in decomposed if not unicodedata.combining(c))


_APOSTROPHES_AND_HYPHENS = re.compile("['\u2019\u2018`\u00b4-]")


def search_fold(text: str) -> str:
    """Exactly the UI's `fold` (`frontend/src/lib/search.ts`): NFKD, every mark removed (`\\p{M}`),
    apostrophes and hyphens dropped ("obrien" finds "O'Brien"), then lower-cased. The monthly
    report sorts names with it on both sides, so the Excel download is in the screen's order."""
    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(c for c in decomposed if not unicodedata.category(c).startswith("M"))
    return _APOSTROPHES_AND_HYPHENS.sub("", stripped).lower()


def contains(haystack: str | None, needle: str) -> bool:
    """`needle` (already folded) appears in `haystack`, ignoring case and accents."""
    return bool(haystack) and needle in fold(haystack)  # type: ignore[arg-type]
