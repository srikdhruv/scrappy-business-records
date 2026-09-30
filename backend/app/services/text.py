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


# --------------------------------------------------------------------------- student matching
#
# The same rules as the Students page search and the Log payment student list
# (frontend/src/lib/search.ts, `studentMatches`), so an uploaded spreadsheet, the Students
# download and the search all agree on who is who. tests/test_text.py runs search.test.ts's
# examples against these.

# Apostrophes (straight, curly, backtick, acute) and hyphens.
_NAME_PUNCTUATION = str.maketrans("", "", "'\u2019\u2018`\u00b4-")
_PHONE_LIKE = re.compile(r"^[0-9\s()+\-./]+$")


def fold_loose(text: str) -> str:
    """`fold`, with apostrophes and hyphens removed too: "O\u2019Brien", "o'brien" and "obrien" are
    the same, and "dsouza" finds "D'Souza" (search.ts `fold`)."""
    decomposed = unicodedata.normalize("NFKD", text)
    no_marks = "".join(c for c in decomposed if not unicodedata.combining(c))
    return no_marks.translate(_NAME_PUNCTUATION).lower()


def name_key(name: str | None) -> tuple[str, ...]:
    """A name's words, folded and sorted, so "Rao Ananya", "ananya  rao" and "Ananya Rao" are
    the same name. A hyphen separates words ("Mary-Jane" is "Mary Jane"); apostrophes don't
    ("O'Brien" is "OBrien"). Empty for a blank name."""
    return tuple(sorted(fold_loose((name or "").replace("-", " ")).split()))


def within_edits(a: str, b: str, limit: int) -> bool:
    """Whether `a` can become `b` with at most `limit` single-letter changes (insert, delete or
    replace), stopping early once it can't."""
    if abs(len(a) - len(b)) > limit:
        return False
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i]
        for j, cb in enumerate(b, start=1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        if min(current) > limit:
            return False
        previous = current
    return previous[-1] <= limit


def near_miss_limit(name: str) -> int:
    """How many letters two names may differ by and still "look similar": none under 5 letters
    (too many real names are that close), 1 up to 9, 2 from 10."""
    size = len(name.replace(" ", ""))
    return 0 if size < 5 else 1 if size < 10 else 2


def phone_digits(text: str | None) -> str:
    """The digits of a phone number, without India's +91 (or 0) in front of a 10-digit number
    (search.ts `digitsOf`): "+91 98765-43210", "098765 43210" and "9876543210" are the same."""
    digits = "".join(c for c in (text or "") if c.isascii() and c.isdigit())
    if len(digits) == 12 and digits.startswith("91"):
        return digits[2:]
    if len(digits) == 11 and digits.startswith("0"):
        return digits[1:]
    return digits


def looks_like_phone(text: str | None) -> bool:
    """Only digits and what people put between them in a phone number (at least 6 digits)."""
    t = (text or "").strip()
    return bool(_PHONE_LIKE.match(t)) and len(phone_digits(t)) >= 6


def student_matches(
    query: str,
    *,
    name: str,
    phone: str | None = None,
    guardian_name: str | None = None,
    batch_label: str | None = None,
) -> bool:
    """True when every word typed appears in the name, parent's name, class or phone, as on the
    Students page. A word that is only digits (and phone punctuation) also matches the phone
    number's digits; so does everything typed, taken together, if it's only a phone number."""
    words = fold_loose(query).split()
    if not words:
        return True
    text = fold_loose(" ".join(t for t in (name, guardian_name, batch_label, phone) if t))
    digits = phone_digits(phone)

    def in_phone(typed: str) -> bool:
        wanted = phone_digits(typed)
        return bool(wanted) and wanted in digits

    if _PHONE_LIKE.match(query.strip()) and in_phone(query):
        return True
    return all(w in text or (_PHONE_LIKE.match(w) is not None and in_phone(w)) for w in words)
