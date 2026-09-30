"""Today's date and the current month, from the laptop's local clock.

`get_today` is the only place the app reads the clock. Routers get the date through
`TodayDep` / `CurrentMonthDep`, never by reading the clock themselves, so tests can freeze time
with `app.dependency_overrides[get_today] = lambda: date(2026, 6, 15)` (which moves both), or
override just `get_current_month`.
"""

from __future__ import annotations

import datetime as dt
from typing import Annotated

from fastapi import Depends

from app.months import first_of_month


def get_today() -> dt.date:
    """Today, in local time."""
    return dt.date.today()


TodayDep = Annotated[dt.date, Depends(get_today)]


def get_current_month(today: TodayDep) -> dt.date:
    """First day of the current month."""
    return first_of_month(today)


CurrentMonthDep = Annotated[dt.date, Depends(get_current_month)]
"""Use as a router parameter type: `def handler(current: CurrentMonthDep): ...`."""
