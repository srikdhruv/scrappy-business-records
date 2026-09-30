"""Helpers for the app's month convention.

The API speaks `"YYYY-MM"` strings; the database stores the first day of the month as a `DATE`.
Convert only through these helpers so the two never drift.
"""

from __future__ import annotations

import datetime as dt
import re

# Years 2000-2099 only: anything else is a typo, and far-off years would make month ranges huge.
MONTH_PATTERN = r"^20\d{2}-(0[1-9]|1[0-2])$"
_MONTH_RE = re.compile(MONTH_PATTERN)


def parse_month(value: str) -> dt.date:
    """`"2026-10"` -> `date(2026, 10, 1)`. Raises `ValueError` for anything else."""
    if not _MONTH_RE.match(value):
        raise ValueError(f"Expected a month like 2026-10, got {value!r}")
    year, month = value.split("-")
    return dt.date(int(year), int(month), 1)


def format_month(value: dt.date) -> str:
    """`date(2026, 10, 1)` (or any day in October 2026) -> `"2026-10"`."""
    return f"{value.year:04d}-{value.month:02d}"


def first_of_month(value: dt.date) -> dt.date:
    return value.replace(day=1)


def current_month(today: dt.date | None = None) -> dt.date:
    """First day of the current month, from the laptop's local clock."""
    return first_of_month(today or dt.date.today())


def add_months(value: dt.date, n: int) -> dt.date:
    """First day of the month `n` months after (or before, if negative) `value`'s month."""
    index = value.year * 12 + (value.month - 1) + n
    return dt.date(index // 12, index % 12 + 1, 1)


def month_range(start: dt.date, end: dt.date) -> list[dt.date]:
    """Every first-of-month from `start`'s month to `end`'s month, inclusive."""
    months: list[dt.date] = []
    m = first_of_month(start)
    last = first_of_month(end)
    while m <= last:
        months.append(m)
        m = add_months(m, 1)
    return months
