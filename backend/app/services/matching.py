"""Finding students by name or phone quickly, for uploads and unassigned payments.

Every lookup goes through an index (the same name, the same phone digits, a name word, or a
name that's nearly the same), so matching thousands of rows against thousands of students
stays quick. The rules are `services/text.py`'s: the same words in any order, ignoring
capitals, accents and apostrophes; phone digits without +91.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Hashable, Iterable
from dataclasses import dataclass

from app.services.text import (
    looks_like_phone,
    name_key,
    near_miss_limit,
    phone_digits,
    within_edits,
)


@dataclass(frozen=True)
class Person[T: Hashable]:
    """Someone to match against: `ident` is a student id, or a row of the uploaded file."""

    ident: T
    name: str
    phone: str | None = None

    @property
    def key(self) -> tuple[str, ...]:
        return name_key(self.name)

    @property
    def digits(self) -> str:
        return phone_digits(self.phone)


def text_key(text: str) -> tuple[str, ...]:
    """The name in a "student" cell, or () when it's only a phone number."""
    return () if looks_like_phone(text) else name_key(text)


def text_digits(text: str, phone: str | None) -> str:
    """The phone digits for a row: its phone column, else the student cell if it's a number."""
    return phone_digits(phone) or (phone_digits(text) if looks_like_phone(text) else "")


_LONGEST_NEAR_MISS = 40  # longer names are only checked a letter apart


def _deletions(joined: str) -> set[str]:
    """`joined` with up to `near_miss_limit` letters left out (itself included)."""
    depth = min(near_miss_limit(joined), 1 if len(joined) > _LONGEST_NEAR_MISS else 2)
    found = {joined}
    layer = {joined}
    for _ in range(depth):
        layer = {w[:i] + w[i + 1 :] for w in layer for i in range(len(w))}
        found |= layer
    return found if depth else set()


class PeopleIndex[T: Hashable]:
    def __init__(self, people: Iterable[Person[T]] = ()) -> None:
        self._by_key: dict[tuple[str, ...], list[Person[T]]] = defaultdict(list)
        self._by_phone: dict[str, list[Person[T]]] = defaultdict(list)
        self._by_word: dict[str, list[Person[T]]] = defaultdict(list)
        # Near-miss names, by every spelling with a letter or two left out: two names a letter
        # or two apart always share one ("symmetric delete"), so only those are compared.
        self._by_deletion: dict[str, list[tuple[str, Person[T]]]] = defaultdict(list)
        for person in people:
            self.add(person)

    def add(self, person: Person[T]) -> None:
        key = person.key
        self._by_key[key].append(person)
        if digits := person.digits:
            self._by_phone[digits].append(person)
        for word in set(key):
            self._by_word[word].append(person)
        joined = " ".join(key)
        for variant in _deletions(joined):
            self._by_deletion[variant].append((joined, person))

    def same_name(self, key: tuple[str, ...]) -> list[Person[T]]:
        return list(self._by_key.get(key, ())) if key else []

    def same_phone(self, digits: str) -> list[Person[T]]:
        return list(self._by_phone.get(digits, ())) if digits else []

    def near(self, key: tuple[str, ...]) -> list[Person[T]]:
        """People whose name is nearly `key` (a letter or two apart), but not the same."""
        joined = " ".join(key)
        limit = near_miss_limit(joined)
        if not limit:
            return []
        found: dict[int, Person[T]] = {}
        checked: dict[str, bool] = {}
        for variant in _deletions(joined):
            for other, person in self._by_deletion.get(variant, ()):
                if other == joined:
                    continue
                if other not in checked:
                    allowed = min(limit, near_miss_limit(other))
                    checked[other] = bool(allowed) and within_edits(joined, other, allowed)
                if checked[other]:
                    found[id(person)] = person
        return list(found.values())

    def words(self, key: tuple[str, ...]) -> list[Person[T]]:
        """People with every word of `key` in their name; failing that, any word of 3 letters
        or more ("Ananya R" still finds Ananya Rao)."""
        if not key:
            return []
        sets = [{id(p): p for p in self._by_word.get(w, ())} for w in key]
        common = set(sets[0]).intersection(*sets[1:]) if sets else set()
        if common:
            return [sets[0][i] for i in common]
        found: dict[int, Person[T]] = {}
        for word in key:
            if len(word) >= 3:
                found.update({id(p): p for p in self._by_word.get(word, ())})
        return list(found.values())

    def short_forms(self, key: tuple[str, ...]) -> list[Person[T]]:
        """People whose name is `key` with a word shortened, or the other way round: "Ananya R"
        and "Ananya Rao", "A Bhat" and "Aarav Bhat". The same number of words, at least one of
        them the same, and each other word the start of its partner."""
        if len(key) < 2:
            return []
        found: dict[int, Person[T]] = {}
        for word in set(key):
            if len(word) < 2:
                continue
            for person in self._by_word.get(word, ()):
                if id(person) not in found and shortened(key, person.key):
                    found[id(person)] = person
        return list(found.values())


def shortened(a: tuple[str, ...], b: tuple[str, ...]) -> bool:
    """Whether names `a` and `b` (sorted words) are the same apart from shortened words."""
    if a == b or len(a) != len(b):
        return False
    rest_a = list(a)
    rest_b = list(b)
    for word in a:  # the same words first
        if word in rest_b:
            rest_a.remove(word)
            rest_b.remove(word)
    if len(rest_a) == len(a):
        return False  # nothing in common
    for word in sorted(rest_a, key=len):  # then pair each remaining word with one it starts
        partner = next((w for w in rest_b if w.startswith(word) or word.startswith(w)), None)
        if partner is None:
            return False
        rest_b.remove(partner)
    return True
