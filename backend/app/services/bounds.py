"""Sanity limits on what can be typed in, so a typo can't break a page.

Every limit answers a plain-words 422 that names the field (never a 500):

- Months must be within 2000-01 .. 2099-12 (the `Month` pattern), and a month the user sets
  (`joined_month`, `left_month`, `fee_effective_month`, `from_month`, a payment's `for_month`)
  can be at most **24 months after the current month**. That catches "2062" for "2026", and
  keeps every month range the ledger walks small.
- A payment's `paid_on` must be between 2000-01-01 and tomorrow (one day of slack for a laptop
  clock that is slightly behind).
- Ids larger than SQLite can store are treated as "not found".
"""

from __future__ import annotations

import datetime as dt

from app.errors import unprocessable
from app.months import add_months
from app.services.ledger import MONTHS_AHEAD

EARLIEST_DATE = dt.date(2000, 1, 1)
MAX_ID = 2**63 - 1  # SQLite's largest INTEGER

_LABELS = {
    "joined_month": "Joined month",
    "left_month": "Left month",
    "fee_effective_month": "The month the new fee starts",
    "from_month": "The month they're back from",
    "for_month": "Month",
}


def latest_month(current_month: dt.date) -> dt.date:
    return add_months(current_month, MONTHS_AHEAD)


def check_month(field: str, month: dt.date, current_month: dt.date) -> None:
    """422 if `month` is more than `MONTHS_AHEAD` months after the current month."""
    latest = latest_month(current_month)
    if month > latest:
        raise unprocessable(
            f"{_LABELS[field]} can't be later than {latest:%B %Y} (two years from now)",
            field=field,
        )


def check_paid_on(paid_on: dt.date, today: dt.date) -> None:
    if paid_on < EARLIEST_DATE:
        raise unprocessable("Paid-on date can't be before the year 2000", field="paid_on")
    if paid_on > today + dt.timedelta(days=1):
        raise unprocessable("Paid-on date can't be in the future", field="paid_on")


def valid_id(value: int) -> bool:
    """False for ids that can't exist (too big for the database)."""
    return 0 < value <= MAX_ID
